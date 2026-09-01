import { describe, expect, it } from "vitest";

import {
  createNewsletterUnsubscribeToken,
  createSignedNewsletterDeliveryAdapter,
  verifyNewsletterUnsubscribeToken,
} from "./newsletter-unsubscribe-token";

// The adapter verifies expiry against the real clock, so a token the test
// expects to succeed has to stay in the future. A fixed calendar date here
// passes until that date arrives and then fails for good.
function stillValid() {
  return new Date(Date.now() + 60 * 60 * 1000).toISOString();
}

describe("newsletter unsubscribe tokens", () => {
  it("binds an opaque ledger identity and expiry without exposing an address", async () => {
    const identityKey = "a".repeat(64);
    const token = await createNewsletterUnsubscribeToken({
      identityKey,
      expiresAt: "2026-08-30T00:00:00.000Z",
      secret: "unsubscribe-test-secret-with-32-bytes",
    });

    await expect(
      verifyNewsletterUnsubscribeToken({
        token,
        secret: "unsubscribe-test-secret-with-32-bytes",
        now: new Date("2026-07-29T00:00:00.000Z"),
      }),
    ).resolves.toMatchObject({
      identityKey,
      providerEventId: expect.stringMatching(/^unsubscribe:[a-f0-9]{64}$/u),
    });
    expect(token).not.toContain("@");
    await expect(
      verifyNewsletterUnsubscribeToken({
        token: `${token}tampered`,
        secret: "unsubscribe-test-secret-with-32-bytes",
      }),
    ).rejects.toThrow("unsubscribe_token_invalid");
  });

  it("lets the delivery adapter resolve its placeholder and consume the opaque token", async () => {
    const adapter = createSignedNewsletterDeliveryAdapter({
      unsubscribeUrl: "https://example.org/newsletter/unsubscribe",
      secret: "unsubscribe-test-secret-with-32-bytes",
    });
    expect(adapter.unsubscribePlaceholder).toBe(
      "https://example.org/newsletter/unsubscribe" +
        "?token={{foundry.unsubscribe.token}}",
    );

    const url = await adapter.createUnsubscribeUrl({
      identityKey: "b".repeat(64),
      expiresAt: stillValid(),
    });
    const token = new URL(url).searchParams.get("token");

    expect(token).not.toBeNull();
    await expect(
      adapter.consumeUnsubscribeToken(token!),
    ).resolves.toMatchObject({
      identityKey: "b".repeat(64),
      providerEventId: expect.stringMatching(/^unsubscribe:[a-f0-9]{64}$/u),
    });
  });

  it("places the opaque token in the query before any configured fragment", async () => {
    const adapter = createSignedNewsletterDeliveryAdapter({
      unsubscribeUrl:
        "https://example.org/newsletter/unsubscribe#preferences",
      secret: "unsubscribe-test-secret-with-32-bytes",
    });
    const url = await adapter.createUnsubscribeUrl({
      identityKey: "c".repeat(64),
      expiresAt: stillValid(),
    });
    const parsed = new URL(url);

    expect(parsed.hash).toBe("#preferences");
    expect(parsed.searchParams.get("token")).not.toBeNull();
    await expect(
      adapter.consumeUnsubscribeToken(parsed.searchParams.get("token")!),
    ).resolves.toMatchObject({ identityKey: "c".repeat(64) });
  });
});
