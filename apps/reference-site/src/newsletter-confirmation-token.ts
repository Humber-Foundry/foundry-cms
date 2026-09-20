import {
  createNewsletterSignupRequestId,
  NewsletterConfirmationLinkInvalidError,
  type NewsletterConfirmationLinkFactory,
} from "@humber-foundry/application";

import {
  newsletterIdentityKeyPattern,
  signNewsletterToken,
  verifyNewsletterToken,
} from "./newsletter-token-signing";

/**
 * The signed confirmation link for newsletter signup.
 *
 * It has the same shape as the unsubscribe link and uses the same delivery
 * secret and the same signer, under its own context string, so a token signed
 * for one purpose is refused for the other. The payload carries the request id
 * and the address's identity key, never the address.
 */
const context = "foundry.newsletter-confirm.v1";
const invalidTokenCode = "confirm_token_invalid";
const invalidSecretCode = "confirm_secret_invalid";
const requestIdPattern = /^[A-Za-z0-9_:-]{1,128}$/u;

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
    !newsletterIdentityKeyPattern.test(identityKey) ||
    !Number.isFinite(Date.parse(expiresAt))
  ) {
    throw new TypeError("confirm_token_input_invalid");
  }
  return signNewsletterToken({
    payload: { requestId, identityKey, expiresAt },
    context,
    secret,
    invalidSecretCode,
  });
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
  let payload: unknown;
  try {
    payload = await verifyNewsletterToken({
      token,
      context,
      secret,
      invalidTokenCode,
      invalidSecretCode,
    });
  } catch (error) {
    // A secret that is too short is this installation's fault. It is raised as
    // it is, so it is never shown to a visitor as a bad link.
    if (error instanceof TypeError && error.message === invalidSecretCode) {
      throw error;
    }
    throw new NewsletterConfirmationLinkInvalidError();
  }
  const parsed = payload as {
    requestId?: unknown;
    identityKey?: unknown;
    expiresAt?: unknown;
  };
  if (
    typeof parsed.requestId !== "string" ||
    !requestIdPattern.test(parsed.requestId) ||
    typeof parsed.identityKey !== "string" ||
    !newsletterIdentityKeyPattern.test(parsed.identityKey) ||
    typeof parsed.expiresAt !== "string" ||
    Date.parse(parsed.expiresAt) <= now.getTime()
  ) {
    throw new NewsletterConfirmationLinkInvalidError();
  }
  return Object.freeze({
    requestId: createNewsletterSignupRequestId(parsed.requestId),
    identityKey: parsed.identityKey,
  });
}

/**
 * The confirmation address. It is built from the deployment's canonical origin,
 * so a link can never point somewhere else.
 */
function newsletterConfirmationUrl(canonicalOrigin: string) {
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
