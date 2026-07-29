import { describe, expect, it, vi } from "vitest";

import {
  sha256Text,
  type NewsletterDeliveryAdapter,
  type NewsletterTestRequest,
} from "@foundry/application";

import { createBrevoNewsletterDeliveryAdapter } from "./brevo-newsletter-delivery-adapter";

const configurationFingerprint = "a".repeat(64);
const correlationId =
  "brevo-transactional-40000000-0000-4000-8000-000000000001";
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

async function prepareRequest(
  adapter: NewsletterDeliveryAdapter,
): Promise<NewsletterTestRequest> {
  const preparation = await adapter.prepareTest(request);
  if (preparation.outcome !== "prepared") {
    throw new Error(`test preparation failed: ${preparation.outcome}`);
  }
  return {
    ...request,
    providerCampaignId: preparation.providerCampaignId,
    foundrySendProof: preparation.foundrySendProof,
  };
}

function adapter(fetcher = vi.fn()) {
  return createBrevoNewsletterDeliveryAdapter({
    apiKey: "test-key-not-a-real-secret",
    configurationFingerprint,
    accountScopeFingerprint: "8".repeat(64),
    installationProofKey: "p".repeat(64),
    senderIds: { sender_primary: 42 },
    fetcher,
  });
}

describe("Brevo newsletter delivery adapter", () => {
  it("sends the exact content, sender, subject, and recipients in one provider write", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      response(201, { messageId: "<message-17@brevo.test>" }),
    );
    const delivery = adapter(fetcher);
    const prepared = await prepareRequest(delivery);

    await expect(delivery.sendTest(prepared)).resolves.toEqual({
      outcome: "accepted",
      providerCampaignId: correlationId,
      foundrySendProof: prepared.foundrySendProof,
      providerReceipt: expect.stringMatching(
        /^brevo:transactional-test:v1:/u,
      ),
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.brevo.com/v3/smtp/email",
      expect.objectContaining({
        method: "POST",
        signal: expect.any(AbortSignal),
        body: JSON.stringify({
          sender: { id: 42 },
          to: [{ email: "owner-primary@example.test" }],
          subject: request.subject,
          htmlContent: request.renderedCampaign.html.bytes,
          tags: [request.executionId],
          headers: {
            idempotencyKey: request.executionId,
            "X-Mailin-custom":
              `foundry_execution:${request.executionId}` +
              `|foundry_proof:${prepared.foundrySendProof}`,
          },
        }),
      }),
    );
  });

  it("prepares deterministic proof without a mutable provider draft", async () => {
    const before = adapter();
    const after = createBrevoNewsletterDeliveryAdapter({
      apiKey: "rotated-test-key",
      configurationFingerprint,
      accountScopeFingerprint: "8".repeat(64),
      installationProofKey: "p".repeat(64),
      senderIds: { sender_primary: 42 },
      fetcher: vi.fn(),
    });

    const beforeRotation = await before.prepareTest(request);
    const afterRotation = await after.prepareTest(request);
    expect(beforeRotation).toEqual(afterRotation);
    expect(beforeRotation).toEqual({
      outcome: "prepared",
      providerCampaignId: correlationId,
      foundrySendProof: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
  });

  it("refuses the provider write without the persisted exact proof", async () => {
    const fetcher = vi.fn();
    await expect(
      adapter(fetcher).sendTest({
        ...request,
        providerCampaignId: correlationId,
        foundrySendProof: null,
      }),
    ).resolves.toEqual({
      outcome: "rejected",
      code: "foundry_send_proof_invalid",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps lost, malformed, rate-limited, and server responses ambiguous", async () => {
    for (const result of [
      () => Promise.reject(new Error("response_lost_after_send")),
      () => Promise.resolve(response(201, {})),
      () => Promise.resolve(response(429)),
      () => Promise.resolve(response(503)),
    ]) {
      const delivery = adapter(vi.fn().mockImplementation(result));
      const prepared = await prepareRequest(delivery);
      await expect(delivery.sendTest(prepared)).resolves.toMatchObject({
        outcome: "ambiguous",
        providerCampaignId: correlationId,
        foundrySendProof: prepared.foundrySendProof,
      });
    }
  });

  it("does not infer acceptance while reconciling an uncertain transactional write", async () => {
    const delivery = adapter();
    const prepared = await prepareRequest(delivery);
    await expect(
      delivery.reconcileTest({
        request: prepared,
        providerCampaignId: correlationId,
      }),
    ).resolves.toEqual({
      outcome: "ambiguous",
      providerCampaignId: correlationId,
      foundrySendProof: prepared.foundrySendProof,
    });
  });

  it("reconciles an uncertain write only from exact tagged transactional evidence", async () => {
    const messageId = "<message-17@brevo.test>";
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        response(200, {
          events: [
            {
              email: "owner-primary@example.test",
              event: "delivered",
              messageId,
              from: "sender@example.test",
              tag: request.executionId,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        response(200, {
          senders: [
            {
              id: 42,
              active: true,
              email: "sender@example.test",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        response(200, {
          count: 1,
          transactionalEmails: [
            {
              email: "owner-primary@example.test",
              messageId,
              subject: request.subject,
              uuid: "transactional-email-uuid-17",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        response(200, {
          email: "owner-primary@example.test",
          subject: request.subject,
          body: request.renderedCampaign.html.bytes,
          events: [{ name: "delivered" }],
        }),
      );
    const delivery = adapter(fetcher);
    const prepared = await prepareRequest(delivery);

    await expect(
      delivery.reconcileTest({
        request: prepared,
        providerCampaignId: correlationId,
      }),
    ).resolves.toEqual({
      outcome: "accepted",
      providerCampaignId: correlationId,
      foundrySendProof: prepared.foundrySendProof,
      providerReceipt: expect.stringMatching(
        /^brevo:transactional-test:v1:/u,
      ),
    });
    expect(fetcher).toHaveBeenNthCalledWith(
      3,
      "https://api.brevo.com/v3/smtp/emails?messageId=" +
        encodeURIComponent(messageId),
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      4,
      "https://api.brevo.com/v3/smtp/emails/transactional-email-uuid-17",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("rejects tagged transactional evidence whose actual body differs", async () => {
    const messageId = "<message-18@brevo.test>";
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        response(200, {
          events: [
            {
              email: "owner-primary@example.test",
              messageId,
              from: "sender@example.test",
              tag: request.executionId,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        response(200, {
          senders: [
            { id: 42, active: true, email: "sender@example.test" },
          ],
        }),
      )
      .mockResolvedValueOnce(
        response(200, {
          transactionalEmails: [
            {
              email: "owner-primary@example.test",
              messageId,
              subject: request.subject,
              uuid: "transactional-email-uuid-18",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        response(200, {
          email: "owner-primary@example.test",
          subject: request.subject,
          body: "<html>provider-side mutation</html>",
        }),
      );
    const delivery = adapter(fetcher);
    const prepared = await prepareRequest(delivery);

    await expect(
      delivery.reconcileTest({
        request: prepared,
        providerCampaignId: correlationId,
      }),
    ).resolves.toEqual({
      outcome: "rejected",
      code: "provider_campaign_fingerprint_mismatch",
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
    const delivery = createBrevoNewsletterDeliveryAdapter({
      apiKey: "test-key-not-a-real-secret",
      configurationFingerprint,
      accountScopeFingerprint,
      installationProofKey: "p".repeat(64),
      senderIds: { sender_primary: 42 },
      fetcher,
    });

    await expect(delivery.capabilities()).resolves.toMatchObject({
      provider: "brevo",
      apiTestDelivery: "supported",
      explicitRecipients: "supported",
      ambiguousOutcomeReconciliation: "supported",
      plainTextArtifact: "unsupported",
    });
    const health = await delivery.health();
    expect(health).toEqual({
      state: "healthy",
      credential: "verified",
      senderIdentity: "verified",
    });
    expect(JSON.stringify(health)).not.toContain("@");
  });

  it("fails health when the credential belongs to a different provisioned account", async () => {
    const delivery = createBrevoNewsletterDeliveryAdapter({
      apiKey: "test-key-not-a-real-secret",
      configurationFingerprint,
      accountScopeFingerprint: "8".repeat(64),
      installationProofKey: "p".repeat(64),
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

    await expect(delivery.health()).resolves.toEqual({
      state: "degraded",
      credential: "invalid",
      senderIdentity: "unknown",
    });
  });
});
