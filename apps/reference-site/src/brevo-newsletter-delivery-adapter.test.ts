import { describe, expect, it, vi } from "vitest";

import {
  assessBrevoClientAccountReadiness,
  createBrevoNewsletterDeliveryAdapter,
} from "./brevo-newsletter-delivery-adapter";
import type {
  CampaignTestDeliveryEvidence,
  NewsletterTestRequest,
} from "@foundry/application";

const configurationFingerprint = "a".repeat(64);
const request: NewsletterTestRequest = {
  executionId: "40000000-0000-4000-8000-000000000001",
  providerCampaignId: null,
  renderedCampaign: {
    campaignId: "20000000-0000-4000-8000-000000000001" as never,
    campaignRevisionId:
      "30000000-0000-4000-8000-000000000001" as never,
    revisionNumber: 1,
    campaignFingerprint: "b".repeat(64),
    eligibleSubscriberCount: 3,
    html: {
      channel: "html",
      bytes: "<html><body>Exact body</body></html>",
      fingerprint: "c".repeat(64),
      schemaVersion: "1.3.0",
      rendererVersion: "1".repeat(40),
    },
    text: {
      channel: "text",
      bytes: "Exact body",
      fingerprint: "d".repeat(64),
      schemaVersion: "1.3.0",
      rendererVersion: "1".repeat(40),
    },
  },
  subject: "An exact test campaign",
  previewText: "Review this exact delivery.",
  senderIdentityId: "sender_primary",
  recipients: [
    { id: "owner-primary", address: "owner-primary@example.test" },
  ],
  binding: {
    campaignId: "20000000-0000-4000-8000-000000000001" as never,
    campaignRevisionId:
      "30000000-0000-4000-8000-000000000001" as never,
    campaignFingerprint: "b".repeat(64),
    htmlFingerprint: "c".repeat(64),
    textFingerprint: "d".repeat(64),
    senderFingerprint: "e".repeat(64),
    audienceDefinitionFingerprint: "f".repeat(64),
    complianceFingerprint: "0".repeat(64),
    providerConfigurationFingerprint: configurationFingerprint,
    recipientSetFingerprint: "2".repeat(64),
  },
};

function response(status: number, body?: unknown) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers:
      body === undefined
        ? undefined
        : { "content-type": "application/json" },
  });
}

describe("Brevo newsletter delivery adapter", () => {
  it("creates one fresh draft, sends to explicit recipients, and accepts only reconciled testSent evidence", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response(201, { id: 17 }))
      .mockResolvedValueOnce(response(204))
      .mockResolvedValueOnce(
        response(200, {
          id: 17,
          name: "foundry-test-40000000-0000-4000-8000-000000000001",
          tag: "f-test-8000000000000001",
          sender: { id: 42 },
          subject: "Foundry campaign test bbbbbbbbbbbb",
          previewText: "Foundry exact test delivery",
          htmlContent: "<html><body>Exact body</body></html>",
          testSent: true,
        }),
      );
    const adapter = createBrevoNewsletterDeliveryAdapter({
      apiKey: "test-key-not-a-real-secret",
      configurationFingerprint,
      senderIds: { sender_primary: 42 },
      fetcher,
    });

    await expect(adapter.sendTest(request)).resolves.toEqual({
      outcome: "accepted",
      providerCampaignId: "17",
      providerReceipt: expect.stringMatching(/^brevo:test:/u),
    });
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      "https://api.brevo.com/v3/emailCampaigns/17/sendTest",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          emailTo: ["owner-primary@example.test"],
        }),
      }),
    );
  });

  it("finds the fresh execution draft and reconciles before any retry after a lost create response", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      response(200, {
        campaigns: [
          {
            id: 18,
            name: "foundry-test-40000000-0000-4000-8000-000000000001",
            tag: "f-test-8000000000000001",
            sender: { id: 42 },
            subject: "Foundry campaign test bbbbbbbbbbbb",
            previewText: "Foundry exact test delivery",
            htmlContent: "<html><body>Exact body</body></html>",
            testSent: true,
          },
        ],
      }),
    );
    const adapter = createBrevoNewsletterDeliveryAdapter({
      apiKey: "test-key-not-a-real-secret",
      configurationFingerprint,
      senderIds: { sender_primary: 42 },
      fetcher,
    });

    await expect(
      adapter.reconcileTest({
        request,
        providerCampaignId: null,
      }),
    ).resolves.toEqual({
      outcome: "accepted",
      providerCampaignId: "18",
      providerReceipt: expect.stringMatching(/^brevo:test:/u),
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("reports explicit capabilities and checks account plus sender health without returning account identity", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response(200, { plan: [{ status: "active" }] }))
      .mockResolvedValueOnce(
        response(200, {
          senders: [{ id: 42, active: true, email: "secret@example.test" }],
        }),
      );
    const adapter = createBrevoNewsletterDeliveryAdapter({
      apiKey: "test-key-not-a-real-secret",
      configurationFingerprint,
      senderIds: { sender_primary: 42 },
      fetcher,
    });

    await expect(adapter.capabilities()).resolves.toMatchObject({
      provider: "brevo",
      apiTestDelivery: "supported",
      explicitRecipients: "supported",
      ambiguousOutcomeReconciliation: "supported",
    });
    const health = await adapter.health();
    expect(health).toEqual({
      state: "healthy",
      credential: "verified",
      senderIdentity: "verified",
    });
    expect(JSON.stringify(health)).not.toContain("@");
  });

  it("keeps evaluation accounts non-production and requires current client-owned live evidence", async () => {
    const evidence = {
      ...request.binding,
      executionId: request.executionId,
      providerCampaignId: "17",
      providerReceiptHash: "3".repeat(64),
      acceptedAt: "2026-07-29T19:05:00.000Z",
    } satisfies CampaignTestDeliveryEvidence;
    const adapter = createBrevoNewsletterDeliveryAdapter({
      apiKey: "test-key-not-a-real-secret",
      configurationFingerprint,
      senderIds: { sender_primary: 42 },
      fetcher: vi
        .fn()
        .mockResolvedValueOnce(response(200, {}))
        .mockResolvedValueOnce(
          response(200, { senders: [{ id: 42, active: true }] }),
        ),
    });

    await expect(
      assessBrevoClientAccountReadiness({
        adapter,
        ownership: "evaluation",
        liveTestEvidence: evidence,
        ownerConfirmedReceipt: true,
      }),
    ).resolves.toMatchObject({
      state: "evaluation_only",
      productionReady: false,
    });
  });

  it("marks only healthy client-owned configuration with confirmed current live evidence ready", async () => {
    const evidence = {
      ...request.binding,
      executionId: request.executionId,
      providerCampaignId: "17",
      providerReceiptHash: "3".repeat(64),
      acceptedAt: "2026-07-29T19:05:00.000Z",
    } satisfies CampaignTestDeliveryEvidence;
    const adapter = createBrevoNewsletterDeliveryAdapter({
      apiKey: "test-key-not-a-real-secret",
      configurationFingerprint,
      senderIds: { sender_primary: 42 },
      fetcher: vi
        .fn()
        .mockResolvedValueOnce(response(200, {}))
        .mockResolvedValueOnce(
          response(200, { senders: [{ id: 42, active: true }] }),
        ),
    });

    await expect(
      assessBrevoClientAccountReadiness({
        adapter,
        ownership: "client_owned",
        liveTestEvidence: evidence,
        ownerConfirmedReceipt: true,
      }),
    ).resolves.toEqual({
      state: "ready",
      productionReady: true,
      provider: "brevo",
      configurationFingerprint,
      acceptedAt: evidence.acceptedAt,
    });
  });
});
