import { describe, expect, it } from "vitest";

import {
  createCampaignId,
  createCampaignRevisionId,
  renderCampaignRevision,
  sha256CanonicalJson,
  type CampaignBulkProviderRequest,
  type CampaignRevision,
} from "@foundry/application";
import {
  createRichTextDocumentFromPlainText,
  createSiteId,
} from "@foundry/site-definition";

import {
  brevoBulkRecipientLimit,
  createBrevoCampaignBulkDeliveryAdapter,
} from "./brevo-campaign-bulk-delivery-adapter";

const siteId = createSiteId("site_reference");
const campaignId = createCampaignId("20000000-0000-4000-8000-000000000052");
const revision: CampaignRevision = {
  id: createCampaignRevisionId("30000000-0000-4000-8000-000000000052"),
  siteId,
  campaignId,
  revisionNumber: 1,
  provenance: { kind: "standalone" },
  subject: "Exact bulk message",
  previewText: "Exact preview",
  callToAction: { label: "Read", href: "https://example.test/read" },
  emailContent: createRichTextDocumentFromPlainText("Exact body"),
  senderIdentityId: "sender_primary",
  complianceFooter: {
    version: "footer-v1",
    content: "Legal footer",
    unsubscribePlaceholder:
      "https://example.test/unsubscribe?token={{foundry.unsubscribe.token}}",
  },
  audienceDefinition: {
    id: "canonical-consent-and-suppression",
    version: 1,
  },
  schemaVersion: "1.3.0",
  rendererVersion: "1".repeat(40),
  createdAt: "2026-08-01T00:00:00.000Z",
  createdByActorId: "membership-editor",
};

async function providerRequest(): Promise<CampaignBulkProviderRequest> {
  const rendered = await renderCampaignRevision(revision, 1);
  const senderConfigurationFingerprint = await sha256CanonicalJson({
    version: "foundry.brevo-sender-configuration.v1",
    logicalId: "sender_primary",
    id: 17,
    email: "sender@example.test",
    name: "Foundry Sender",
  });
  const senderFingerprint = await sha256CanonicalJson({
    version: "foundry.campaign-test-sender.v2",
    senderIdentityId: "sender_primary",
    senderConfigurationFingerprint,
  });
  return {
    operationId: "60000000-0000-4000-8000-000000000052",
    stableSendKey: "a".repeat(64),
    providerCampaignId: null,
    providerSendProof: "b".repeat(64),
    attemptedAt: "2026-07-29T17:00:00.000Z",
    sendArtifact: {
      version: "foundry.campaign-bulk-send-artifact.v2",
      operationId: "60000000-0000-4000-8000-000000000052",
      stableSendKey: "a".repeat(64),
      siteId,
      campaignId,
      campaignRevisionId: revision.id,
      authorizationId: "50000000-0000-4000-8000-000000000052",
      authorizationFingerprint: "c".repeat(64),
      campaignFingerprint: rendered.campaignFingerprint,
      senderIdentityId: revision.senderIdentityId,
      sender: {
        email: "sender@example.test",
        name: "Foundry Sender",
      },
      senderFingerprint,
      providerConfigurationFingerprint: "f".repeat(64),
      complianceVersion: "footer-v1",
      audienceDefinition: {
        id: "canonical-consent-and-suppression",
        version: 1,
      },
      scheduledInstant: null,
      recipientCount: 1,
      subject: revision.subject,
      htmlContent: rendered.html.bytes,
      textContent: rendered.text.bytes,
      htmlFingerprint: rendered.html.fingerprint,
      textFingerprint: rendered.text.fingerprint,
      audienceFingerprint: "1".repeat(64),
    },
    recipients: [
      {
        subscriberId: "subscriber-52",
        identityKey: "d".repeat(64),
        address: "subscriber@example.test",
      },
    ],
  };
}

describe("Brevo campaign bulk delivery adapter", () => {
  it("sends the exact rendered artifacts under the stable logical send key", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const adapter = createBrevoCampaignBulkDeliveryAdapter({
      apiKey: "brevo-test-key",
      providerConfigurationFingerprint: "f".repeat(64),
      senders: {
        sender_primary: {
          id: 17,
          email: "sender@example.test",
          name: "Foundry Sender",
        },
      },
      fetcher: async (input, init) => {
        calls.push({ url: String(input), init });
        return Response.json(
          { messageIds: ["brevo-message-52"] },
          {
            status: 201,
          },
        );
      },
      baseUrl: "https://api.brevo.test/v3",
    });
    const request = await providerRequest();

    await expect(adapter.sendBulk(request)).resolves.toEqual({
      outcome: "accepted",
      providerCampaignId: `brevo-bulk-${request.operationId}`,
      providerMessageId: "brevo-message-52",
    });
    expect(calls).toHaveLength(1);
    const body = JSON.parse(String(calls[0]!.init?.body));
    const rendered = await renderCampaignRevision(revision, 1);
    expect(body).toMatchObject({
      sender: {
        email: "sender@example.test",
        name: "Foundry Sender",
      },
      messageVersions: [{ to: [{ email: "subscriber@example.test" }] }],
      subject: revision.subject,
      htmlContent: rendered.html.bytes,
      textContent: rendered.text.bytes,
      tags: [request.operationId],
      headers: {
        "Idempotency-Key": request.operationId,
        "X-Mailin-custom":
          `foundry_bulk_operation:${request.operationId}` +
          `|foundry_bulk_proof:${request.providerSendProof}`,
      },
    });
  });

  it("isolates every recipient in its own message version and never shares an address", async () => {
    const bodies: unknown[] = [];
    const adapter = createBrevoCampaignBulkDeliveryAdapter({
      apiKey: "brevo-test-key",
      providerConfigurationFingerprint: "f".repeat(64),
      senders: {
        sender_primary: {
          id: 17,
          email: "sender@example.test",
          name: "Foundry Sender",
        },
      },
      fetcher: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return Response.json(
          {
            messageIds: [
              "brevo-message-first",
              "brevo-message-second",
              "brevo-message-third",
            ],
          },
          { status: 201 },
        );
      },
      baseUrl: "https://api.brevo.test/v3",
    });
    const base = await providerRequest();
    const recipients = [
      base.recipients[0]!,
      {
        subscriberId: "subscriber-53",
        identityKey: "e".repeat(64),
        address: "second@example.test",
      },
      {
        subscriberId: "subscriber-54",
        identityKey: "f".repeat(64),
        address: "third@example.test",
      },
    ];

    await expect(
      adapter.sendBulk({
        ...base,
        recipients,
        sendArtifact: { ...base.sendArtifact, recipientCount: 3 },
      }),
    ).resolves.toEqual({
      outcome: "accepted",
      providerCampaignId: `brevo-bulk-${base.operationId}`,
      providerMessageId: null,
    });
    expect(bodies).toHaveLength(1);
    const body = bodies[0] as {
      to?: unknown;
      cc?: unknown;
      bcc?: unknown;
      messageVersions: ReadonlyArray<{ to: ReadonlyArray<{ email: string }> }>;
    };
    expect(body.to).toBeUndefined();
    expect(body.cc).toBeUndefined();
    expect(body.bcc).toBeUndefined();
    expect(body.messageVersions).toEqual([
      { to: [{ email: "subscriber@example.test" }] },
      { to: [{ email: "second@example.test" }] },
      { to: [{ email: "third@example.test" }] },
    ]);
    for (const version of body.messageVersions) {
      expect(version.to).toHaveLength(1);
    }
  });

  it("treats a message-identifier set that does not cover every version as ambiguous", async () => {
    const adapter = createBrevoCampaignBulkDeliveryAdapter({
      apiKey: "brevo-test-key",
      providerConfigurationFingerprint: "f".repeat(64),
      senders: {
        sender_primary: {
          id: 17,
          email: "sender@example.test",
          name: "Foundry Sender",
        },
      },
      fetcher: async () =>
        Response.json({ messageIds: ["brevo-message-only"] }, { status: 201 }),
      baseUrl: "https://api.brevo.test/v3",
    });
    const base = await providerRequest();

    await expect(
      adapter.sendBulk({
        ...base,
        recipients: [
          base.recipients[0]!,
          {
            subscriberId: "subscriber-53",
            identityKey: "e".repeat(64),
            address: "second@example.test",
          },
        ],
        sendArtifact: { ...base.sendArtifact, recipientCount: 2 },
      }),
    ).resolves.toEqual({
      outcome: "ambiguous",
      providerCampaignId: `brevo-bulk-${base.operationId}`,
      code: "provider_result_ambiguous",
    });
  });

  it("refuses an audience above the documented provider batch limit without writing", async () => {
    let calls = 0;
    const adapter = createBrevoCampaignBulkDeliveryAdapter({
      apiKey: "brevo-test-key",
      providerConfigurationFingerprint: "f".repeat(64),
      senders: {
        sender_primary: {
          id: 17,
          email: "sender@example.test",
          name: "Foundry Sender",
        },
      },
      fetcher: async () => {
        calls += 1;
        return Response.json({ messageIds: [] }, { status: 201 });
      },
      baseUrl: "https://api.brevo.test/v3",
    });
    const base = await providerRequest();
    const recipients = Array.from(
      { length: brevoBulkRecipientLimit + 1 },
      (_value, index) => ({
        subscriberId: `subscriber-${index}`,
        identityKey: index.toString(16).padStart(64, "0"),
        address: `recipient-${index}@example.test`,
      }),
    );

    await expect(
      adapter.sendBulk({
        ...base,
        recipients,
        sendArtifact: {
          ...base.sendArtifact,
          recipientCount: recipients.length,
        },
      }),
    ).resolves.toEqual({
      outcome: "rejected",
      code: "provider_audience_unsupported",
    });
    expect(calls).toBe(0);
  });

  it("classifies an uncertain send and reconciles proof-bearing provider facts before retry", async () => {
    const urls: string[] = [];
    const request = await providerRequest();
    const fetcher = async (input: string | URL | Request) => {
      urls.push(String(input));
      if (urls.length === 1) return new Response(null, { status: 503 });
      return Response.json({
        events: [
          {
            email: "subscriber@example.test",
            event: "delivered",
            messageId: "brevo-message-52",
            from: "sender@example.test",
            tag: request.operationId,
            date: "2026-07-29T17:46:40.000Z",
          },
          {
            email: "subscriber@example.test",
            event: "opened",
            messageId: "brevo-message-52",
            from: "sender@example.test",
            tag: request.operationId,
            date: "2026-07-29T17:47:40.000Z",
          },
        ],
      });
    };
    const adapter = createBrevoCampaignBulkDeliveryAdapter({
      apiKey: "brevo-test-key",
      providerConfigurationFingerprint: "f".repeat(64),
      senders: {
        sender_primary: {
          id: 17,
          email: "sender@example.test",
          name: "Foundry Sender",
        },
      },
      fetcher,
      baseUrl: "https://api.brevo.test/v3",
    });

    const uncertain = await adapter.sendBulk(request);
    expect(uncertain).toEqual({
      outcome: "ambiguous",
      providerCampaignId: `brevo-bulk-${request.operationId}`,
      code: "provider_result_ambiguous",
    });
    const driftedAdapter = createBrevoCampaignBulkDeliveryAdapter({
      apiKey: "brevo-test-key",
      providerConfigurationFingerprint: "e".repeat(64),
      senders: {
        sender_primary: {
          id: 99,
          email: "replacement@example.test",
          name: "Replacement Sender",
        },
      },
      fetcher,
      baseUrl: "https://api.brevo.test/v3",
    });
    await expect(
      driftedAdapter.reconcileBulk({
        ...request,
        providerCampaignId: `brevo-bulk-${request.operationId}`,
      }),
    ).resolves.toEqual({
      outcome: "verified",
      providerCampaignId: `brevo-bulk-${request.operationId}`,
      providerMessageIds: ["brevo-message-52"],
      facts: [
        {
          providerMessageId: "brevo-message-52",
          recipientIdentityKey: "d".repeat(64),
          type: "delivered",
          occurredAt: "2026-07-29T17:46:40.000Z",
        },
        {
          providerMessageId: "brevo-message-52",
          recipientIdentityKey: "d".repeat(64),
          type: "opened",
          occurredAt: "2026-07-29T17:47:40.000Z",
        },
      ],
    });
    // Reconciliation costs one tag-filtered report request whatever the
    // audience size, so a large send cannot exhaust the runtime's subrequest
    // budget part-way through and strand itself.
    expect(urls).toEqual([
      "https://api.brevo.test/v3/smtp/email",
      expect.stringContaining("/smtp/statistics/events?"),
    ]);
  });

  it("proves no send exists only once the report lag allowance has passed", async () => {
    const request = await providerRequest();
    const emptyReport = { fetcher: async () => Response.json({ events: [] }) };
    const configuration = {
      apiKey: "brevo-test-key",
      providerConfigurationFingerprint: "f".repeat(64),
      senders: {
        sender_primary: {
          id: 17,
          email: "sender@example.test",
          name: "Foundry Sender",
        },
      },
      baseUrl: "https://api.brevo.test/v3",
      ...emptyReport,
    };

    // Five minutes after the attempt an empty report is only reporting lag.
    await expect(
      createBrevoCampaignBulkDeliveryAdapter({
        ...configuration,
        now: () => new Date("2026-07-29T17:05:00.000Z"),
      }).reconcileBulk(request),
    ).resolves.toEqual({
      outcome: "ambiguous",
      providerCampaignId: `brevo-bulk-${request.operationId}`,
      code: "provider_result_ambiguous",
    });

    // Well past the allowance it is proof that no send exists, which is the
    // only basis on which the same operation may be sent again.
    await expect(
      createBrevoCampaignBulkDeliveryAdapter({
        ...configuration,
        now: () => new Date("2026-07-29T17:20:00.000Z"),
      }).reconcileBulk(request),
    ).resolves.toEqual({ outcome: "not_sent" });
  });

  it("reads every report page and refuses to conclude from a truncated one", async () => {
    const request = await providerRequest();
    const offsets: string[] = [];
    const event = (address: string, type: string) => ({
      email: address,
      event: type,
      messageId: `brevo-message-${address}`,
      from: "sender@example.test",
      tag: request.operationId,
      date: "2026-07-29T17:46:40.000Z",
    });
    const recipients = Array.from({ length: 2 }, (_value, index) => ({
      subscriberId: `subscriber-${index}`,
      identityKey: index.toString(16).padStart(64, "0"),
      address: `recipient-${index}@example.test`,
    }));
    const adapter = createBrevoCampaignBulkDeliveryAdapter({
      apiKey: "brevo-test-key",
      providerConfigurationFingerprint: "f".repeat(64),
      senders: {
        sender_primary: {
          id: 17,
          email: "sender@example.test",
          name: "Foundry Sender",
        },
      },
      // Every page is full, so the report never ends inside the page budget.
      fetcher: async (input) => {
        const offset = new URL(String(input)).searchParams.get("offset") ?? "";
        offsets.push(offset);
        return Response.json({
          events: Array.from({ length: 1000 }, () =>
            event(recipients[0]!.address, "delivered"),
          ),
        });
      },
      baseUrl: "https://api.brevo.test/v3",
    });

    await expect(
      adapter.reconcileBulk({
        ...request,
        recipients,
        sendArtifact: { ...request.sendArtifact, recipientCount: 2 },
      }),
    ).resolves.toEqual({
      outcome: "ambiguous",
      providerCampaignId: `brevo-bulk-${request.operationId}`,
      code: "provider_report_incomplete",
    });
    expect(offsets).toHaveLength(20);
    expect(offsets[0]).toBe("0");
    expect(offsets.at(-1)).toBe(String(19 * 1000));
  });

  it("keeps an expected-recipient subset unresolved", async () => {
    const request = await providerRequest();
    const secondRecipient = {
      subscriberId: "subscriber-53",
      identityKey: "e".repeat(64),
      address: "second@example.test",
    };
    const adapter = createBrevoCampaignBulkDeliveryAdapter({
      apiKey: "brevo-test-key",
      providerConfigurationFingerprint: "f".repeat(64),
      senders: {
        sender_primary: {
          id: 17,
          email: "sender@example.test",
          name: "Foundry Sender",
        },
      },
      fetcher: async () =>
        Response.json({
          events: [
            {
              email: request.recipients[0]!.address,
              event: "delivered",
              messageId: "brevo-message-subset",
              from: "sender@example.test",
              tag: request.operationId,
              date: "2026-07-29T17:46:40.000Z",
            },
          ],
        }),
      baseUrl: "https://api.brevo.test/v3",
    });

    await expect(
      adapter.reconcileBulk({
        ...request,
        recipients: [...request.recipients, secondRecipient],
        sendArtifact: {
          ...request.sendArtifact,
          recipientCount: 2,
        },
      }),
    ).resolves.toEqual({
      outcome: "ambiguous",
      providerCampaignId: `brevo-bulk-${request.operationId}`,
      code: "provider_result_ambiguous",
    });
  });

  it("treats a duplicate-provider response as ambiguous and preserves the UUID idempotency key", async () => {
    const request = await providerRequest();
    let capturedHeaders: HeadersInit | undefined;
    let capturedBody: BodyInit | null | undefined;
    const adapter = createBrevoCampaignBulkDeliveryAdapter({
      apiKey: "brevo-test-key",
      providerConfigurationFingerprint: "f".repeat(64),
      senders: {
        sender_primary: {
          id: 17,
          email: "sender@example.test",
          name: "Foundry Sender",
        },
      },
      fetcher: async (_input, init) => {
        capturedHeaders = init?.headers;
        capturedBody = init?.body;
        return Response.json({ code: "duplicate_parameter" }, { status: 409 });
      },
      baseUrl: "https://api.brevo.test/v3",
    });

    await expect(adapter.sendBulk(request)).resolves.toEqual({
      outcome: "ambiguous",
      providerCampaignId: `brevo-bulk-${request.operationId}`,
      code: "provider_result_ambiguous",
    });
    expect((capturedHeaders as Record<string, string>)["content-type"]).toBe(
      "application/json",
    );
    // The operation id is the idempotency key the provider sees, so a retry of
    // the same operation is recognisably the same request.
    expect(JSON.parse(String(capturedBody)).headers["Idempotency-Key"]).toBe(
      request.operationId,
    );
    expect(request.operationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
  });
});
