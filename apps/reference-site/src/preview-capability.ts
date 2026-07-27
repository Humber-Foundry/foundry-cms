import type {
  ContentWorkspaceId,
  ExternalHumanIdentity,
} from "@foundry/application";

const capabilityLifetimeSeconds = 5 * 60;

type PreviewCapabilityClaims = Readonly<{
  issuer: string;
  subject: string;
  audience: string;
  workspaceId: ContentWorkspaceId;
  revision: number;
  expiresAt: number;
}>;

export class PreviewCapabilityError extends Error {
  constructor() {
    super("preview_capability_invalid");
    this.name = "PreviewCapabilityError";
  }
}

function encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decode(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(
    base64.padEnd(Math.ceil(base64.length / 4) * 4, "="),
  );
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function signingKey(secret: string) {
  if (secret.length < 24) {
    throw new PreviewCapabilityError();
  }
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function createPreviewCapability({
  identity,
  audience,
  workspaceId,
  revision,
  secret,
  now = new Date(),
}: {
  identity: ExternalHumanIdentity;
  audience: string;
  workspaceId: ContentWorkspaceId;
  revision: number;
  secret: string;
  now?: Date;
}) {
  const claims: PreviewCapabilityClaims = {
    issuer: identity.binding.issuer,
    subject: identity.binding.subject,
    audience,
    workspaceId,
    revision,
    expiresAt:
      Math.floor(now.getTime() / 1_000) + capabilityLifetimeSeconds,
  };
  const encodedClaims = encode(
    new TextEncoder().encode(JSON.stringify(claims)),
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    await signingKey(secret),
    new TextEncoder().encode(encodedClaims),
  );
  return `${encodedClaims}.${encode(new Uint8Array(signature))}`;
}

export async function verifyPreviewCapability({
  capability,
  identity,
  audience,
  workspaceId,
  revision,
  secret,
  now = new Date(),
}: {
  capability: string;
  identity: ExternalHumanIdentity;
  audience: string;
  workspaceId: ContentWorkspaceId;
  revision: number;
  secret: string;
  now?: Date;
}): Promise<void> {
  try {
    const [claimsPart, signaturePart, extra] = capability.split(".");
    if (
      claimsPart === undefined ||
      signaturePart === undefined ||
      extra !== undefined
    ) {
      throw new PreviewCapabilityError();
    }
    const signatureMatches = await crypto.subtle.verify(
      "HMAC",
      await signingKey(secret),
      decode(signaturePart).buffer as ArrayBuffer,
      new TextEncoder().encode(claimsPart),
    );
    const claims: unknown = JSON.parse(
      new TextDecoder().decode(decode(claimsPart)),
    );
    const expected: PreviewCapabilityClaims = {
      issuer: identity.binding.issuer,
      subject: identity.binding.subject,
      audience,
      workspaceId,
      revision,
      expiresAt:
        typeof claims === "object" &&
        claims !== null &&
        "expiresAt" in claims &&
        typeof claims.expiresAt === "number"
          ? claims.expiresAt
          : 0,
    };
    if (
      !signatureMatches ||
      typeof claims !== "object" ||
      claims === null ||
      JSON.stringify(claims) !== JSON.stringify(expected) ||
      expected.expiresAt < Math.floor(now.getTime() / 1_000)
    ) {
      throw new PreviewCapabilityError();
    }
  } catch {
    throw new PreviewCapabilityError();
  }
}
