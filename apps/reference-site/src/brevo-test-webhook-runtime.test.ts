import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createBrevoTestWebhookHandler } from "./brevo-test-webhook-runtime";
import type {
  BrevoTestWebhookEvidence,
  BrevoTestWebhookEvidenceStore,
} from "./brevo-test-webhook-evidence";

const authenticationToken = "webhook-token-".padEnd(48, "a");
const installationProofKey = "installation-proof-".padEnd(48, "b");
const executionId = "40000000-0000-4000-8000-000000000001";
const foundrySendProof = "c".repeat(64);
const ownerAddress = "Owner.Primary@example.test";

function request(payload: unknown, token = authenticationToken) {
  return new Request(
    "https://example.test/api/integrations/brevo/webhooks/transactional",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    },
  );
}

function memoryStore() {
  const records = new Map<string, BrevoTestWebhookEvidence>();
  const store: BrevoTestWebhookEvidenceStore = {
    async recordVerified(evidence) {
      const existing = records.get(evidence.eventFingerprint);
      if (existing !== undefined) {
        return existing.payloadFingerprint === evidence.payloadFingerprint
          ? "duplicate"
          : "conflict";
      }
      records.set(evidence.eventFingerprint, evidence);
      return "recorded";
    },
    async listVerified({
      executionId: expectedExecutionId,
      foundrySendProof: expectedProof,
    }) {
      return [...records.values()].filter(
        (evidence) =>
          evidence.executionId === expectedExecutionId &&
          evidence.foundrySendProof === expectedProof,
      );
    },
  };
  return { records, store };
}

function event(overrides: Record<string, unknown> = {}) {
  return {
    id: 17,
    event: "request",
    email: ownerAddress,
    "message-id": "<message-17@brevo.test>",
    "X-Mailin-custom":
      `foundry_execution:${executionId}|foundry_proof:${foundrySendProof}`,
    tags: [executionId],
    ts_event: 1_785_347_200,
    ...overrides,
  };
}

describe("Brevo test webhook runtime", () => {
  it("rejects unauthenticated requests before recording evidence", async () => {
    const { records, store } = memoryStore();
    const handler = createBrevoTestWebhookHandler({
      authenticationToken,
      installationProofKey,
      store,
    });

    const response = await handler(request(event(), "wrong-token"));

    expect(response.status).toBe(401);
    expect(records.size).toBe(0);
  });

  it("records only a keyed recipient fingerprint from authenticated proof-bearing events", async () => {
    const { records, store } = memoryStore();
    const handler = createBrevoTestWebhookHandler({
      authenticationToken,
      installationProofKey,
      store,
      clock: () => new Date("2026-07-29T20:00:00.000Z"),
    });

    const response = await handler(request([event(), event()]));

    expect(response.status).toBe(204);
    expect(records.size).toBe(1);
    const [recorded] = [...records.values()];
    expect(recorded).toMatchObject({
      providerEventId: "17",
      payloadFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
      executionId,
      foundrySendProof,
      providerMessageId: "<message-17@brevo.test>",
      eventType: "request",
      receivedAt: "2026-07-29T20:00:00.000Z",
    });
    expect(recorded?.recipientFingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(recorded)).not.toContain(ownerAddress);
    expect(JSON.stringify(recorded)).not.toContain(
      ownerAddress.toLowerCase(),
    );
  });

  it("ignores authenticated events that lack an exact execution tag or proof header", async () => {
    const { records, store } = memoryStore();
    const handler = createBrevoTestWebhookHandler({
      authenticationToken,
      installationProofKey,
      store,
    });

    const response = await handler(request([
      event({ tags: ["different-execution"] }),
      event({ "X-Mailin-custom": "unrelated:value" }),
    ]));

    expect(response.status).toBe(204);
    expect(records.size).toBe(0);
  });

  it("deduplicates timestamp-free retries without using receipt time as identity", async () => {
    const { records, store } = memoryStore();
    let receivedAt = new Date("2026-07-29T20:00:00.000Z");
    const handler = createBrevoTestWebhookHandler({
      authenticationToken,
      installationProofKey,
      store,
      clock: () => receivedAt,
    });
    const timestampFreeEvent = event({ id: undefined, ts_event: undefined });

    expect((await handler(request(timestampFreeEvent))).status).toBe(204);
    receivedAt = new Date("2026-07-29T20:05:00.000Z");
    expect(
      (await handler(request(event({
        id: undefined,
        ts_event: "invalid",
      })))).status,
    ).toBe(204);

    expect(records.size).toBe(1);
    expect([...records.values()][0]).toMatchObject({
      occurredAt: "2026-07-29T20:00:00.000Z",
      receivedAt: "2026-07-29T20:00:00.000Z",
    });
  });

  it("rejects a changed payload that reuses the same integer provider event ID", async () => {
    const { records, store } = memoryStore();
    const handler = createBrevoTestWebhookHandler({
      authenticationToken,
      installationProofKey,
      store,
    });

    expect(
      (await handler(request(event({ id: 42 })))).status,
    ).toBe(204);
    expect(
      (await handler(request(event({
        id: 42,
        event: "opened",
      })))).status,
    ).toBe(409);

    expect(records.size).toBe(1);
  });
});
