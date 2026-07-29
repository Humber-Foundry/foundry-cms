import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  loadEnvironment: vi.fn(),
  verify: vi.fn(),
  ingest: vi.fn(),
}));

vi.mock("../../../src/human-access-environment", () => ({
  loadHumanAccessEnvironment: mocks.loadEnvironment,
}));
vi.mock("../../../src/human-access-configuration", () => ({
  readNewsletterDeliverySecret: () =>
    "unsubscribe-test-secret-with-32-bytes",
}));
vi.mock("../../../src/newsletter-unsubscribe-token", () => ({
  createSignedNewsletterDeliveryAdapter: () => ({
    consumeUnsubscribeToken: mocks.verify,
  }),
}));
vi.mock("../../../src/subscriber-ledger-runtime", () => ({
  loadSubscriberLedgerIntegrationApplication: async () => ({
    provider: { ingestSuppressionByIdentityKey: mocks.ingest },
  }),
}));

import { GET, POST } from "./route";

describe("public newsletter unsubscribe route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadEnvironment.mockResolvedValue({
      FOUNDRY_CAMPAIGN_UNSUBSCRIBE_URL:
        "https://example.org/newsletter/unsubscribe",
    });
    mocks.verify.mockResolvedValue({
      identityKey: "a".repeat(64),
      providerEventId: `unsubscribe:${"b".repeat(64)}`,
    });
  });

  it("keeps GET side-effect free and requires POST confirmation", async () => {
    const response = await GET(
      new Request("https://example.org/newsletter/unsubscribe?token=valid"),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('method="post"');
    expect(mocks.ingest).not.toHaveBeenCalled();
  });

  it("records the unsubscribe in the canonical suppression ledger", async () => {
    const response = await POST(
      new Request("https://example.org/newsletter/unsubscribe", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "token=valid",
      }),
    );
    expect(response.status).toBe(200);
    expect(mocks.ingest).toHaveBeenCalledWith({
      provider: "foundry_unsubscribe",
      providerEventId: `unsubscribe:${"b".repeat(64)}`,
      identityKey: "a".repeat(64),
      reason: "unsubscribed",
      occurredAt: expect.any(String),
    });
  });
});
