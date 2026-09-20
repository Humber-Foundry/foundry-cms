import {
  sha256Text,
  type NewsletterUnsubscribeAdapter,
} from "@humber-foundry/application";

import {
  newsletterIdentityKeyPattern,
  signNewsletterToken,
  verifyNewsletterToken,
} from "./newsletter-token-signing";

const context = "foundry.unsubscribe.v1";
const invalidTokenCode = "unsubscribe_token_invalid";
const invalidSecretCode = "unsubscribe_secret_invalid";

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
    !newsletterIdentityKeyPattern.test(identityKey) ||
    !Number.isFinite(Date.parse(expiresAt))
  ) {
    throw new TypeError("unsubscribe_token_input_invalid");
  }
  return signNewsletterToken({
    payload: { identityKey, expiresAt },
    context,
    secret,
    invalidSecretCode,
  });
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
  const parsed = (await verifyNewsletterToken({
    token,
    context,
    secret,
    invalidTokenCode,
    invalidSecretCode,
  })) as { identityKey?: unknown; expiresAt?: unknown };
  if (
    typeof parsed.identityKey !== "string" ||
    !newsletterIdentityKeyPattern.test(parsed.identityKey) ||
    typeof parsed.expiresAt !== "string" ||
    Date.parse(parsed.expiresAt) <= now.getTime()
  ) {
    throw new TypeError(invalidTokenCode);
  }
  return Object.freeze({
    identityKey: parsed.identityKey,
    providerEventId: `unsubscribe:${await sha256Text(token)}`,
  });
}

const unsubscribeTokenPlaceholder = "{{foundry.unsubscribe.token}}";
const unsubscribeTokenSentinel = "FOUNDRY_UNSUBSCRIBE_TOKEN";

/**
 * The unsubscribe address with the token left as a placeholder. It is derived
 * from the configured address alone. The delivery secret signs a real token
 * later, at send time, so the compliance footer can be built before the
 * delivery secret is installed.
 */
export function newsletterUnsubscribePlaceholder(baseUrl: string) {
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
}): NewsletterUnsubscribeAdapter {
  const placeholder = newsletterUnsubscribePlaceholder(unsubscribeUrl);
  const adapter: NewsletterUnsubscribeAdapter = {
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
