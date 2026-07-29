import { describe, expect, it, vi } from "vitest";

import { sha256Text, type NewsletterTestRequest } from "@foundry/application";

import { createBrevoNewsletterDeliveryAdapter } from "./brevo-newsletter-delivery-adapter";

const configurationFingerprint = "a".repeat(64);
const request: NewsletterTestRequest = {
  executionId: "40000000-0000-4000-8000-000000000001",
  providerCampaignId: null,
  foundrySendProof: null,
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
          subject: request.subject,
          previewText: request.previewText,
          htmlContent: "<html><body>Exact body</body></html>",
          testSent: true,
        }),
      );
    const adapter = createBrevoNewsletterDeliveryAdapter({
      apiKey: "test-key-not-a-real-secret",
      configurationFingerprint,
      accountScopeFingerprint: "8".repeat(64),
      senderIds: { sender_primary: 42 },
      fetcher,
    });

    await expect(adapter.sendTest(request)).resolves.toEqual({
      outcome: "accepted",
      providerCampaignId: "17",
      providerReceipt: expect.stringMatching(/^brevo:test:/u),
    });
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      "https://api.brevo.com/v3/emailCampaigns",
      expect.objectContaining({
        method: "POST",
        signal: expect.any(AbortSignal),
      }),
    );
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

  it("does not accept a matching provider draft sent outside Foundry", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      response(200, {
        count: 1,
        campaigns: [
          {
            id: 18,
            name: "foundry-test-40000000-0000-4000-8000-000000000001",
            tag: "f-test-8000000000000001",
            sender: { id: 42 },
            subject: request.subject,
            previewText: request.previewText,
            htmlContent: "<html><body>Exact body</body></html>",
            testSent: true,
          },
        ],
      }),
    );
    const adapter = createBrevoNewsletterDeliveryAdapter({
      apiKey: "test-key-not-a-real-secret",
      configurationFingerprint,
      accountScopeFingerprint: "8".repeat(64),
      senderIds: { sender_primary: 42 },
      fetcher,
    });

    await expect(
      adapter.reconcileTest({
        request,
        providerCampaignId: null,
      }),
    ).resolves.toEqual({
      outcome: "ambiguous",
      providerCampaignId: "18",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps transient and deleted known-campaign reads ambiguous", async () => {
    const transientRead = createBrevoNewsletterDeliveryAdapter({
      apiKey: "test-key-not-a-real-secret",
      configurationFingerprint,
      accountScopeFingerprint: "8".repeat(64),
      senderIds: { sender_primary: 42 },
      fetcher: vi.fn().mockResolvedValue(response(429)),
    });
    await expect(
      transientRead.reconcileTest({
        request,
        providerCampaignId: "17",
      }),
    ).resolves.toEqual({
      outcome: "ambiguous",
      providerCampaignId: "17",
      code: "provider_rate_limited",
    });

    const transientSearch = createBrevoNewsletterDeliveryAdapter({
      apiKey: "test-key-not-a-real-secret",
      configurationFingerprint,
      accountScopeFingerprint: "8".repeat(64),
      senderIds: { sender_primary: 42 },
      fetcher: vi.fn().mockResolvedValue(response(503)),
    });
    await expect(
      transientSearch.reconcileTest({
        request,
        providerCampaignId: null,
      }),
    ).resolves.toEqual({ outcome: "ambiguous" });

    const absent = createBrevoNewsletterDeliveryAdapter({
      apiKey: "test-key-not-a-real-secret",
      configurationFingerprint,
      accountScopeFingerprint: "8".repeat(64),
      senderIds: { sender_primary: 42 },
      fetcher: vi.fn().mockResolvedValue(response(404)),
    });
    await expect(
      absent.reconcileTest({
        request,
        providerCampaignId: "17",
      }),
    ).resolves.toEqual({
      outcome: "ambiguous",
      providerCampaignId: "17",
    });
  });

  it("keeps a lost Foundry send response ambiguous after its provider draft is deleted", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response(201, { id: 17 }))
      .mockRejectedValueOnce(new Error("response_lost_after_send"))
      .mockResolvedValueOnce(response(404))
      .mockResolvedValueOnce(
        response(200, {
          id: 17,
          name: "foundry-test-40000000-0000-4000-8000-000000000001",
          tag: "f-test-8000000000000001",
          sender: { id: 42 },
          subject: request.subject,
          previewText: request.previewText,
          htmlContent: "<html><body>Exact body</body></html>",
          testSent: false,
        }),
      );
    const adapter = createBrevoNewsletterDeliveryAdapter({
      apiKey: "test-key-not-a-real-secret",
      configurationFingerprint,
      accountScopeFingerprint: "8".repeat(64),
      senderIds: { sender_primary: 42 },
      fetcher,
    });

    const ambiguous = await adapter.sendTest(request);
    expect(ambiguous).toMatchObject({
      outcome: "ambiguous",
      providerCampaignId: "17",
      foundrySendProof: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    const reconciliationRequest = {
      ...request,
      foundrySendProof:
        ambiguous.outcome === "ambiguous"
          ? (ambiguous.foundrySendProof ?? null)
          : null,
    };
    await expect(
      adapter.reconcileTest({
        request: reconciliationRequest,
        providerCampaignId: "17",
      }),
    ).resolves.toEqual({
      outcome: "ambiguous",
      providerCampaignId: "17",
      foundrySendProof: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    await expect(
      adapter.reconcileTest({
        request: reconciliationRequest,
        providerCampaignId: "17",
      }),
    ).resolves.toEqual({
      outcome: "ambiguous",
      providerCampaignId: "17",
      foundrySendProof: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("keeps server errors ambiguous because either provider write may have applied", async () => {
    const createAmbiguous = createBrevoNewsletterDeliveryAdapter({
      apiKey: "test-key-not-a-real-secret",
      configurationFingerprint,
      accountScopeFingerprint: "8".repeat(64),
      senderIds: { sender_primary: 42 },
      fetcher: vi.fn().mockResolvedValue(response(503)),
    });
    await expect(createAmbiguous.sendTest(request)).resolves.toEqual({
      outcome: "ambiguous",
    });

    const createRateLimited = createBrevoNewsletterDeliveryAdapter({
      apiKey: "test-key-not-a-real-secret",
      configurationFingerprint,
      accountScopeFingerprint: "8".repeat(64),
      senderIds: { sender_primary: 42 },
      fetcher: vi.fn().mockResolvedValue(response(429)),
    });
    await expect(createRateLimited.sendTest(request)).resolves.toEqual({
      outcome: "ambiguous",
      code: "provider_rate_limited",
    });

    const sendAmbiguous = createBrevoNewsletterDeliveryAdapter({
      apiKey: "test-key-not-a-real-secret",
      configurationFingerprint,
      accountScopeFingerprint: "8".repeat(64),
      senderIds: { sender_primary: 42 },
      fetcher: vi
        .fn()
        .mockResolvedValueOnce(response(201, { id: 19 }))
        .mockResolvedValueOnce(response(503)),
    });
    await expect(sendAmbiguous.sendTest(request)).resolves.toEqual({
      outcome: "ambiguous",
      providerCampaignId: "19",
      foundrySendProof: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });

    const sendRateLimited = createBrevoNewsletterDeliveryAdapter({
      apiKey: "test-key-not-a-real-secret",
      configurationFingerprint,
      accountScopeFingerprint: "8".repeat(64),
      senderIds: { sender_primary: 42 },
      fetcher: vi
        .fn()
        .mockResolvedValueOnce(response(201, { id: 20 }))
        .mockResolvedValueOnce(response(429)),
    });
    await expect(sendRateLimited.sendTest(request)).resolves.toEqual({
      outcome: "ambiguous",
      providerCampaignId: "20",
      foundrySendProof: expect.stringMatching(/^[a-f0-9]{64}$/u),
      code: "provider_rate_limited",
    });
  });

  it("reports explicit capabilities and checks account plus sender health without returning account identity", async () => {
    const accountScopeFingerprint = await sha256Text(
      "foundry.brevo-account-scope.v1:owner@example.test",
    );
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        response(200, {
          email: "Owner@Example.Test",
          plan: [{ status: "active" }],
        }),
      )
      .mockResolvedValueOnce(
        response(200, {
          senders: [{ id: 42, active: true, email: "secret@example.test" }],
        }),
      );
    const adapter = createBrevoNewsletterDeliveryAdapter({
      apiKey: "test-key-not-a-real-secret",
      configurationFingerprint,
      accountScopeFingerprint,
      senderIds: { sender_primary: 42 },
      fetcher,
    });

    await expect(adapter.capabilities()).resolves.toMatchObject({
      provider: "brevo",
      apiTestDelivery: "supported",
      explicitRecipients: "supported",
      ambiguousOutcomeReconciliation: "supported",
      plainTextArtifact: "unsupported",
    });
    const health = await adapter.health();
    expect(health).toEqual({
      state: "healthy",
      credential: "verified",
      senderIdentity: "verified",
    });
    expect(JSON.stringify(health)).not.toContain("@");
  });

  it("fails health when the credential belongs to a different provisioned account", async () => {
    const adapter = createBrevoNewsletterDeliveryAdapter({
      apiKey: "test-key-not-a-real-secret",
      configurationFingerprint,
      accountScopeFingerprint: "8".repeat(64),
      senderIds: { sender_primary: 42 },
      fetcher: vi
        .fn()
        .mockResolvedValueOnce(
          response(200, { email: "other-account@example.test" }),
        )
        .mockResolvedValueOnce(
          response(200, { senders: [{ id: 42, active: true }] }),
        ),
    });

    await expect(adapter.health()).resolves.toEqual({
      state: "degraded",
      credential: "invalid",
      senderIdentity: "unknown",
    });
  });
});
