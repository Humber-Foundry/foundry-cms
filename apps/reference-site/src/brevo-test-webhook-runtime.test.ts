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
  return new Request("https://example.test/api/foundry-cms/webhooks/brevo", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

function memoryStore() {
  const records = new Map<string, BrevoTestWebhookEvidence>();
  const store: BrevoTestWebhookEvidenceStore = {
    async recordVerified(evidence) {
      if (records.has(evidence.eventFingerprint)) return false;
      records.set(evidence.eventFingerprint, evidence);
      return true;
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
});
