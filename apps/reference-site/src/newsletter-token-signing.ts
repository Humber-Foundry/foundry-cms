/**
 * One signer for every signed newsletter link.
 *
 * The unsubscribe link and the signup confirmation link are the same shape and
 * are signed with the same delivery secret. They differ only by their context
 * string, which is signed along with the payload, so a token minted for one
 * purpose is refused for the other.
 *
 * Keeping one signer means a change to how a link is signed cannot reach one
 * link and miss the other.
 */

/** The shape of a subscriber identity key: a SHA-256 digest in hex. */
export const newsletterIdentityKeyPattern = /^[a-f0-9]{64}$/u;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

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

async function signingKey(secret: string, invalidSecretCode: string) {
  if (secret.length < 32) throw new TypeError(invalidSecretCode);
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/**
 * Signs a payload object under one context string. The result is
 * `<payload>.<signature>`, both base64url.
 */
export async function signNewsletterToken({
  payload,
  context,
  secret,
  invalidSecretCode,
}: {
  payload: unknown;
  context: string;
  secret: string;
  invalidSecretCode: string;
}) {
  const encoded = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const signature = base64UrlEncode(
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        await signingKey(secret, invalidSecretCode),
        encoder.encode(`${context}:${encoded}`),
      ),
    ),
  );
  return `${encoded}.${signature}`;
}

/**
 * Checks the signature under one context string and returns the payload it
 * carried. Anything wrong — a wrong shape, a wrong secret, a wrong context, a
 * changed payload — raises the same error, so a caller cannot tell them apart.
 */
export async function verifyNewsletterToken({
  token,
  context,
  secret,
  invalidTokenCode,
  invalidSecretCode,
}: {
  token: string;
  context: string;
  secret: string;
  invalidTokenCode: string;
  invalidSecretCode: string;
}): Promise<unknown> {
  const [payload, signature, extra] = token.split(".");
  if (payload === undefined || signature === undefined || extra !== undefined) {
    throw new TypeError(invalidTokenCode);
  }
  let valid = false;
  try {
    valid = await crypto.subtle.verify(
      "HMAC",
      await signingKey(secret, invalidSecretCode),
      base64UrlDecode(signature).buffer as ArrayBuffer,
      encoder.encode(`${context}:${payload}`),
    );
  } catch (error) {
    // A secret that is too short is a fault in this installation, not a fault
    // in the link somebody followed. It must not be reported as a bad link.
    if (error instanceof TypeError && error.message === invalidSecretCode) {
      throw error;
    }
    throw new TypeError(invalidTokenCode);
  }
  if (!valid) throw new TypeError(invalidTokenCode);
  try {
    return JSON.parse(decoder.decode(base64UrlDecode(payload)));
  } catch {
    throw new TypeError(invalidTokenCode);
  }
}
