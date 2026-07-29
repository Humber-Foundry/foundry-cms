import { describe, expect, it } from "vitest";

import {
  createNewsletterUnsubscribeToken,
  verifyNewsletterUnsubscribeToken,
} from "./newsletter-unsubscribe-token";

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
});
