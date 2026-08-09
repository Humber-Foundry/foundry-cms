import { beforeEach, describe, expect, it, vi } from "vitest";

import { AccessDeniedError } from "@humber-foundry/application";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  exportLedger: vi.fn(),
  listIdentities: vi.fn(),
  recordConsent: vi.fn(),
  resubscribe: vi.fn(),
  suppress: vi.fn(),
  loadRequestContext: vi.fn(),
  loadIdentity: vi.fn(),
  authorizeIdentity: vi.fn(),
  verifyMutation: vi.fn(),
}));

const identity = {
  binding: { issuer: "https://access.example", subject: "owner" },
  email: "owner@example.com",
  nonce: "owner-nonce",
};
const application = {
  queries: {
    exportLedger: mocks.exportLedger,
    listIdentities: mocks.listIdentities,
  },
  commands: {
    recordConsent: mocks.recordConsent,
    resubscribe: mocks.resubscribe,
    suppress: mocks.suppress,
  },
};

vi.mock("../../../../src/subscriber-ledger-runtime", () => ({
  loadSubscriberLedgerRequestContext: mocks.loadRequestContext,
  loadHumanIdentityRequestContext: mocks.loadIdentity,
  authorizeSubscriberLedgerIdentity: mocks.authorizeIdentity,
}));
vi.mock("../../../../src/human-mutation-runtime", () => ({
  executeIdempotentHumanMutation: async ({
    execute,
  }: {
    execute: () => Promise<Response>;
  }) => execute(),
  HumanMutationExecutionNotStartedError: class extends Error {
    override readonly cause: unknown;
    constructor(cause: unknown) {
      super("not_started");
      this.cause = cause;
    }
  },
  HumanMutationIdempotencyError: class extends Error {},
  verifyHumanMutation: mocks.verifyMutation,
}));

import { GET, POST } from "./route";

const evidence = {
  lawfulBasis: "express",
  source: "public_form",
  occurredAt: "2026-07-27T18:00:00.000Z",
  disclosureVersion: "newsletter-v1",
  collectionSurface: "/newsletter",
  evidenceReference: "submission-1",
} as const;

describe("subscriber ledger endpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadRequestContext.mockResolvedValue({ identity, application });
    mocks.loadIdentity.mockResolvedValue({ identity });
    mocks.authorizeIdentity.mockResolvedValue({ identity, application });
    mocks.verifyMutation.mockResolvedValue(undefined);
  });

  it("returns an audited provider-neutral ledger as a private download", async () => {
    mocks.exportLedger.mockResolvedValue({
      schemaVersion: 1,
      siteId: "site_reference",
      exportedAt: "2026-07-27T18:00:00.000Z",
      subscribers: [],
      events: [],
    });

    const response = await GET(
      new Request(
        "https://foundry.example/api/foundry-cms/subscribers?format=ledger",
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-disposition")).toContain(
      "foundry-subscriber-ledger.json",
    );
    expect(mocks.exportLedger).toHaveBeenCalledWith({ actor: identity });
  });

  it("does not expose identities when the human is unauthorized", async () => {
    mocks.listIdentities.mockRejectedValueOnce(
      new AccessDeniedError("capability_not_authorized"),
    );

    const response = await GET(
      new Request("https://foundry.example/api/foundry-cms/subscribers"),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "not_authorized",
    });
  });

  it("rejects incomplete consent evidence before command dispatch", async () => {
    const response = await POST(
      new Request("https://foundry.example/api/foundry-cms/subscribers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "record_consent",
          email: "person@example.com",
          evidence: { ...evidence, disclosureVersion: undefined },
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(mocks.authorizeIdentity).not.toHaveBeenCalled();
  });

  it("dispatches explicit resubscription with the recorded mutation marker", async () => {
    mocks.resubscribe.mockResolvedValue({
      id: "subscriber-1",
      email: "person@example.com",
      state: "active",
    });

    const response = await POST(
      new Request("https://foundry.example/api/foundry-cms/subscribers", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "subscriber-resubscribe-1",
        },
        body: JSON.stringify({
          action: "resubscribe",
          email: "person@example.com",
          evidence,
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(
      response.headers.get("x-foundry-mutation-result"),
    ).toBe("recorded");
    expect(mocks.resubscribe).toHaveBeenCalledWith({
      actor: identity,
      email: "person@example.com",
      evidence,
    });
  });
});
