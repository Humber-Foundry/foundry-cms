import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { campaignSuppressionReason } from "@foundry/application";
import { createSiteId } from "@foundry/site-definition";

import { normalizeAuthenticatedBrevoBulkWebhookEvent } from "./brevo-campaign-bulk-webhook-runtime";

const siteId = createSiteId("site_reference");
const identityKeySecret = "identity-key-secret-".padEnd(48, "i");
const fingerprintKey = "fingerprint-key-".padEnd(48, "f");
const operationId = "60000000-0000-4000-8000-000000000052";
const providerSendProof = "a".repeat(64);

function event(
  eventType: string,
  receivedAt: string,
  providerOccurredAt: string | null = null,
) {
  return {
    operationId,
    providerSendProof,
    providerMessageId: "provider-message-52",
    recipient: "subscriber@example.test",
    eventType,
    providerOccurredAt,
    receivedAt,
  };
}

describe("Brevo campaign bulk webhook normalization", () => {
  it("deduplicates timestamp-free retries independently of local receipt time", async () => {
    const first = await normalizeAuthenticatedBrevoBulkWebhookEvent({
      event: event("delivered", "2026-08-01T00:10:00.000Z"),
      siteId,
      identityKeySecret,
      fingerprintKey,
    });
    const retry = await normalizeAuthenticatedBrevoBulkWebhookEvent({
      event: event("delivered", "2026-08-01T00:15:00.000Z"),
      siteId,
      identityKeySecret,
      fingerprintKey,
    });

    expect(retry?.eventId).toBe(first?.eventId);
    expect(retry?.payloadFingerprint).toBe(
      first?.payloadFingerprint,
    );
    expect(retry?.receivedAt).not.toBe(
      first?.receivedAt,
    );
  });

  it.each([
    ["softBounce", "soft_bounced", null],
    ["blocked", "blocked", null],
    ["invalid", "invalid", "hard_bounced"],
    ["deferred", "deferred", null],
    ["error", "provider_error", null],
  ] as const)(
    "normalizes %s and implies the correct suppression, if any",
    async (eventType, normalizedType, suppressionReason) => {
      const normalized = await normalizeAuthenticatedBrevoBulkWebhookEvent({
        event: event(
          eventType,
          "2026-08-01T00:10:01.000Z",
          "2026-08-01T00:10:00.000Z",
        ),
        siteId,
        identityKeySecret,
        fingerprintKey,
      });

      expect(normalized).toMatchObject({
        type: normalizedType,
        occurredAt: "2026-08-01T00:10:00.000Z",
      });
      // Recording the event is what applies suppression, so the normalized type
      // has to imply the right negative state through the shared rule.
      expect(campaignSuppressionReason(normalized!.type)).toBe(
        suppressionReason,
      );
    },
  );
});
