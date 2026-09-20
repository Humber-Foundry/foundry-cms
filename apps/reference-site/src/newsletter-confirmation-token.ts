import {
  createNewsletterSignupRequestId,
  type NewsletterConfirmationLinkFactory,
} from "@humber-foundry/application";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * The signed confirmation link for newsletter signup.
 *
 * It is the same shape as the unsubscribe token and is signed with the same
 * newsletter delivery secret, under a different context string so a token for
 * one purpose can never be replayed as a token for the other. The payload
 * carries the request id and the address's identity key, never the address.
 */
const context = "foundry.newsletter-confirm.v1";
const identityKeyPattern = /^[a-f0-9]{64}$/u;
const requestIdPattern = /^[A-Za-z0-9_:-]{1,128}$/u;

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(normalized + padding);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function signingKey(secret: string) {
  if (secret.length < 32) throw new TypeError("confirm_secret_invalid");
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function createNewsletterConfirmationToken({
  requestId,
  identityKey,
  expiresAt,
  secret,
}: {
  requestId: string;
  identityKey: string;
  expiresAt: string;
  secret: string;
}) {
  if (
    !requestIdPattern.test(requestId) ||
    !identityKeyPattern.test(identityKey) ||
    !Number.isFinite(Date.parse(expiresAt))
  ) {
    throw new TypeError("confirm_token_input_invalid");
  }
  const payload = base64UrlEncode(
    encoder.encode(JSON.stringify({ requestId, identityKey, expiresAt })),
  );
  const signature = base64UrlEncode(
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        await signingKey(secret),
        encoder.encode(`${context}:${payload}`),
      ),
    ),
  );
  return `${payload}.${signature}`;
}

export async function verifyNewsletterConfirmationToken({
  token,
  secret,
  now = new Date(),
}: {
  token: string;
  secret: string;
  now?: Date;
}) {
  const [payload, signature, extra] = token.split(".");
  if (payload === undefined || signature === undefined || extra !== undefined) {
    throw new TypeError("confirm_token_invalid");
  }
  let valid = false;
  try {
    valid = await crypto.subtle.verify(
      "HMAC",
      await signingKey(secret),
      base64UrlDecode(signature).buffer as ArrayBuffer,
      encoder.encode(`${context}:${payload}`),
    );
  } catch {
    throw new TypeError("confirm_token_invalid");
  }
  if (!valid) throw new TypeError("confirm_token_invalid");
  let parsed: {
    requestId?: unknown;
    identityKey?: unknown;
    expiresAt?: unknown;
  };
  try {
    parsed = JSON.parse(decoder.decode(base64UrlDecode(payload)));
  } catch {
    throw new TypeError("confirm_token_invalid");
  }
  if (
    typeof parsed.requestId !== "string" ||
    !requestIdPattern.test(parsed.requestId) ||
    typeof parsed.identityKey !== "string" ||
    !identityKeyPattern.test(parsed.identityKey) ||
    typeof parsed.expiresAt !== "string" ||
    Date.parse(parsed.expiresAt) <= now.getTime()
  ) {
    throw new TypeError("confirm_token_invalid");
  }
  return Object.freeze({
    requestId: createNewsletterSignupRequestId(parsed.requestId),
    identityKey: parsed.identityKey,
  });
}

/**
 * The confirmation address with the token placed in it. The address comes from
 * the deployment's canonical origin, so a link can never point somewhere else.
 */
export function newsletterConfirmationUrl(canonicalOrigin: string) {
  const parsed = new URL("/newsletter/confirm", canonicalOrigin);
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw new TypeError("confirm_url_invalid");
  }
  return parsed;
}

export function createSignedNewsletterConfirmationLinks({
  canonicalOrigin,
  secret,
}: {
  canonicalOrigin: string;
  secret: string;
}): NewsletterConfirmationLinkFactory {
  const base = newsletterConfirmationUrl(canonicalOrigin);
  const links: NewsletterConfirmationLinkFactory = {
    async createConfirmationUrl({ requestId, identityKey, expiresAt }) {
      const token = await createNewsletterConfirmationToken({
        requestId,
        identityKey,
        expiresAt,
        secret,
      });
      const url = new URL(base);
      url.searchParams.set("token", token);
      return url.toString();
    },
    async consumeConfirmationToken(token: string) {
      return verifyNewsletterConfirmationToken({ token, secret });
    },
  };
  return Object.freeze(links);
}
