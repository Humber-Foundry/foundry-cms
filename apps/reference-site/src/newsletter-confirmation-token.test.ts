import { describe, expect, it } from "vitest";

import {
  createNewsletterSignupRequestId,
  NewsletterConfirmationLinkInvalidError,
} from "@humber-foundry/application";

import {
  createNewsletterConfirmationToken,
  createSignedNewsletterConfirmationLinks,
  verifyNewsletterConfirmationToken,
} from "./newsletter-confirmation-token";
import {
  createNewsletterUnsubscribeToken,
  verifyNewsletterUnsubscribeToken,
} from "./newsletter-unsubscribe-token";

const secret = "a-newsletter-delivery-secret-of-enough-length";
const identityKey = "a".repeat(64);
const requestId = "newsletter_signup-1";
const expiresAt = "2026-03-02T10:00:00.000Z";
const before = new Date("2026-03-01T10:00:00.000Z");
const after = new Date("2026-03-03T10:00:00.000Z");

describe("newsletter confirmation token", () => {
  it("round trips the request id and the identity key", async () => {
    const token = await createNewsletterConfirmationToken({
      requestId,
      identityKey,
      expiresAt,
      secret,
    });
    expect(
      await verifyNewsletterConfirmationToken({
        token,
        secret,
        now: before,
      }),
    ).toStrictEqual({
      requestId: createNewsletterSignupRequestId(requestId),
      identityKey,
    });
  });

  it("never carries the address", async () => {
    const token = await createNewsletterConfirmationToken({
      requestId,
      identityKey,
      expiresAt,
      secret,
    });
    const encoded = token
      .split(".")[0]!
      .replaceAll("-", "+")
      .replaceAll("_", "/");
    const payload = atob(
      encoded + "=".repeat((4 - (encoded.length % 4)) % 4),
    );
    expect(payload).not.toContain("@");
  });

  it("refuses a token after it expires", async () => {
    const token = await createNewsletterConfirmationToken({
      requestId,
      identityKey,
      expiresAt,
      secret,
    });
    await expect(
      verifyNewsletterConfirmationToken({ token, secret, now: after }),
    ).rejects.toBeInstanceOf(NewsletterConfirmationLinkInvalidError);
  });

  it("refuses a token signed with a different secret", async () => {
    const token = await createNewsletterConfirmationToken({
      requestId,
      identityKey,
      expiresAt,
      secret,
    });
    await expect(
      verifyNewsletterConfirmationToken({
        token,
        secret: "another-secret-that-is-also-long-enough-here",
        now: before,
      }),
    ).rejects.toBeInstanceOf(NewsletterConfirmationLinkInvalidError);
  });

  it("refuses a tampered payload", async () => {
    const token = await createNewsletterConfirmationToken({
      requestId,
      identityKey,
      expiresAt,
      secret,
    });
    const [, signature] = token.split(".");
    const forged = btoa(
      JSON.stringify({ requestId, identityKey: "b".repeat(64), expiresAt }),
    )
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
    await expect(
      verifyNewsletterConfirmationToken({
        token: `${forged}.${signature}`,
        secret,
        now: before,
      }),
    ).rejects.toBeInstanceOf(NewsletterConfirmationLinkInvalidError);
  });

  it("cannot be replayed as an unsubscribe token, or the other way round", async () => {
    const confirmation = await createNewsletterConfirmationToken({
      requestId,
      identityKey,
      expiresAt,
      secret,
    });
    await expect(
      verifyNewsletterUnsubscribeToken({
        token: confirmation,
        secret,
        now: before,
      }),
    ).rejects.toBeInstanceOf(TypeError);

    const unsubscribe = await createNewsletterUnsubscribeToken({
      identityKey,
      expiresAt,
      secret,
    });
    await expect(
      verifyNewsletterConfirmationToken({
        token: unsubscribe,
        secret,
        now: before,
      }),
    ).rejects.toBeInstanceOf(NewsletterConfirmationLinkInvalidError);
  });

  it("reports a secret that is too short as this site's fault, not a bad link", async () => {
    const token = await createNewsletterConfirmationToken({
      requestId,
      identityKey,
      expiresAt,
      secret,
    });
    // A visitor followed a good link. Telling them the link was wrong would
    // hide an installation fault behind their own action.
    await expect(
      verifyNewsletterConfirmationToken({
        token,
        secret: "too-short",
        now: before,
      }),
    ).rejects.not.toBeInstanceOf(NewsletterConfirmationLinkInvalidError);
  });

  it("refuses a secret that is too short to sign with", async () => {
    await expect(
      createNewsletterConfirmationToken({
        requestId,
        identityKey,
        expiresAt,
        secret: "too-short",
      }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("builds a confirmation link on this site only", async () => {
    const links = createSignedNewsletterConfirmationLinks({
      canonicalOrigin: "https://example.test",
      secret,
    });
    const url = await links.createConfirmationUrl({
      requestId: createNewsletterSignupRequestId(requestId),
      identityKey,
      expiresAt,
    });
    const parsed = new URL(url);
    expect(parsed.origin).toBe("https://example.test");
    expect(parsed.pathname).toBe("/newsletter/confirm");
    expect(parsed.searchParams.get("token")).not.toBeNull();
  });

  it("refuses to build links on an address that is not https", () => {
    expect(() =>
      createSignedNewsletterConfirmationLinks({
        canonicalOrigin: "http://example.test",
        secret,
      }),
    ).toThrow(TypeError);
  });
});
