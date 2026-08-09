import type { ExternalHumanIdentity } from "@humber-foundry/application";

export const humanTokenLifetimeSeconds = 5 * 60;

export class HumanRequestIntegrityError extends Error {
  constructor() {
    super("human_request_integrity_invalid");
    this.name = "HumanRequestIntegrityError";
  }
}

type CsrfClaims = Readonly<{
  issuer: string;
  subject: string;
  audience: string;
  nonce: string;
  expiresAt: number;
  scope?: ReadonlyArray<string>;
}>;

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeBase64Url(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function importSigningKey(secret: string) {
  if (secret.length < 24) {
    throw new HumanRequestIntegrityError();
  }
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function claimsFor({
  identity,
  audience,
  expiresAt,
  scope,
}: {
  identity: ExternalHumanIdentity;
  audience: string;
  expiresAt: number;
  scope?: ReadonlyArray<string>;
}): CsrfClaims {
  return {
    issuer: identity.binding.issuer,
    subject: identity.binding.subject,
    audience,
    nonce: identity.nonce,
    expiresAt,
    ...(scope === undefined ? {} : { scope: [...scope].sort() }),
  };
}

export async function createHumanCsrfToken({
  identity,
  audience,
  secret,
  now = new Date(),
  scope,
}: {
  identity: ExternalHumanIdentity;
  audience: string;
  secret: string;
  now?: Date;
  scope?: ReadonlyArray<string>;
}): Promise<string> {
  const encodedClaims = encodeBase64Url(
    new TextEncoder().encode(
      JSON.stringify(
        claimsFor({
          identity,
          audience,
          expiresAt:
            Math.floor(now.getTime() / 1_000) + humanTokenLifetimeSeconds,
          scope,
        }),
      ),
    ),
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    await importSigningKey(secret),
    new TextEncoder().encode(encodedClaims),
  );
  return `${encodedClaims}.${encodeBase64Url(new Uint8Array(signature))}`;
}

export async function verifyHumanMutationRequest({
  request,
  identity,
  audience,
  canonicalOrigin,
  secret,
  now = new Date(),
}: {
  request: Request;
  identity: ExternalHumanIdentity;
  audience: string;
  canonicalOrigin: string;
  secret: string;
  now?: Date;
}): Promise<void> {
  const contentType = request.headers.get("content-type")?.toLowerCase();
  if (
    request.method === "GET" ||
    request.method === "HEAD" ||
    request.headers.get("origin") !== canonicalOrigin ||
    (contentType?.startsWith("application/json") !== true &&
      contentType?.startsWith("multipart/form-data;") !== true)
  ) {
    throw new HumanRequestIntegrityError();
  }
  const token = request.headers.get("x-foundry-csrf");
  await verifyHumanCsrfToken({
    token,
    identity,
    audience,
    secret,
    now,
  });
}

export async function verifyHumanCsrfToken({
  token,
  identity,
  audience,
  secret,
  now = new Date(),
  requiredScope,
}: {
  token: string | null;
  identity: ExternalHumanIdentity;
  audience: string;
  secret: string;
  now?: Date;
  requiredScope?: string;
}): Promise<void> {
  const [encodedClaims, encodedSignature, unexpected] =
    token?.split(".") ?? [];
  if (
    encodedClaims === undefined ||
    encodedSignature === undefined ||
    unexpected !== undefined
  ) {
    throw new HumanRequestIntegrityError();
  }

  try {
    const verified = await crypto.subtle.verify(
      "HMAC",
      await importSigningKey(secret),
      decodeBase64Url(encodedSignature).buffer as ArrayBuffer,
      new TextEncoder().encode(encodedClaims),
    );
    const claims: unknown = JSON.parse(
      new TextDecoder().decode(decodeBase64Url(encodedClaims)),
    );
    const expected = claimsFor({
      identity,
      audience,
      expiresAt:
        typeof claims === "object" &&
        claims !== null &&
        "expiresAt" in claims &&
        typeof claims.expiresAt === "number"
          ? claims.expiresAt
          : 0,
      scope:
        typeof claims === "object" &&
        claims !== null &&
        "scope" in claims &&
        Array.isArray(claims.scope) &&
        claims.scope.every((entry) => typeof entry === "string")
          ? claims.scope
          : undefined,
    });
    if (
      !verified ||
      typeof claims !== "object" ||
      claims === null ||
      JSON.stringify(claims) !== JSON.stringify(expected) ||
      expected.expiresAt < Math.floor(now.getTime() / 1_000) ||
      (requiredScope !== undefined &&
        !expected.scope?.includes(requiredScope))
    ) {
      throw new HumanRequestIntegrityError();
    }
  } catch {
    throw new HumanRequestIntegrityError();
  }
}
