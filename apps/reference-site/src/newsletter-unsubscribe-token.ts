import {
  sha256Text,
  type NewsletterDeliveryAdapter,
} from "@foundry/application";

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

async function signingKey(secret: string) {
  if (secret.length < 32) throw new TypeError("unsubscribe_secret_invalid");
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function createNewsletterUnsubscribeToken({
  identityKey,
  expiresAt,
  secret,
}: {
  identityKey: string;
  expiresAt: string;
  secret: string;
}) {
  if (
    !/^[a-f0-9]{64}$/u.test(identityKey) ||
    !Number.isFinite(Date.parse(expiresAt))
  ) {
    throw new TypeError("unsubscribe_token_input_invalid");
  }
  const payload = base64UrlEncode(
    encoder.encode(JSON.stringify({ identityKey, expiresAt })),
  );
  const signature = base64UrlEncode(
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        await signingKey(secret),
        encoder.encode(`foundry.unsubscribe.v1:${payload}`),
      ),
    ),
  );
  return `${payload}.${signature}`;
}

export async function verifyNewsletterUnsubscribeToken({
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
    throw new TypeError("unsubscribe_token_invalid");
  }
  let valid = false;
  try {
    valid = await crypto.subtle.verify(
      "HMAC",
      await signingKey(secret),
      base64UrlDecode(signature).buffer as ArrayBuffer,
      encoder.encode(`foundry.unsubscribe.v1:${payload}`),
    );
  } catch {
    throw new TypeError("unsubscribe_token_invalid");
  }
  if (!valid) throw new TypeError("unsubscribe_token_invalid");
  const parsed = JSON.parse(
    decoder.decode(base64UrlDecode(payload)),
  ) as { identityKey?: unknown; expiresAt?: unknown };
  if (
    typeof parsed.identityKey !== "string" ||
    !/^[a-f0-9]{64}$/u.test(parsed.identityKey) ||
    typeof parsed.expiresAt !== "string" ||
    Date.parse(parsed.expiresAt) <= now.getTime()
  ) {
    throw new TypeError("unsubscribe_token_invalid");
  }
  return Object.freeze({
    identityKey: parsed.identityKey,
    providerEventId: `unsubscribe:${await sha256Text(token)}`,
  });
}

const unsubscribeTokenPlaceholder = "{{foundry.unsubscribe.token}}";
const unsubscribeTokenSentinel = "FOUNDRY_UNSUBSCRIBE_TOKEN";

function unsubscribePlaceholder(baseUrl: string) {
  const parsed = new URL(baseUrl);
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw new TypeError("unsubscribe_url_invalid");
  }
  parsed.searchParams.delete("token");
  parsed.searchParams.set("token", unsubscribeTokenSentinel);
  return parsed
    .toString()
    .replace(unsubscribeTokenSentinel, unsubscribeTokenPlaceholder);
}

export function createSignedNewsletterDeliveryAdapter({
  unsubscribeUrl,
  secret,
}: {
  unsubscribeUrl: string;
  secret: string;
}): NewsletterDeliveryAdapter {
  const placeholder = unsubscribePlaceholder(unsubscribeUrl);
  const adapter: NewsletterDeliveryAdapter = {
    unsubscribePlaceholder: placeholder,
    async createUnsubscribeUrl({
      identityKey,
      expiresAt,
    }: {
      identityKey: string;
      expiresAt: string;
    }) {
      const token = await createNewsletterUnsubscribeToken({
        identityKey,
        expiresAt,
        secret,
      });
      return placeholder.replace(
        unsubscribeTokenPlaceholder,
        encodeURIComponent(token),
      );
    },
    consumeUnsubscribeToken(token: string) {
      return verifyNewsletterUnsubscribeToken({ token, secret });
    },
  };
  return Object.freeze(adapter);
}
