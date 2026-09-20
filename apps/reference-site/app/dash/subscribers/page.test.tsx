import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  loadRequestContext: vi.fn(),
  listIdentities: vi.fn(),
  loadStateCounts: vi.fn(),
  loadPendingSignupCount: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));
vi.mock("@/src/dashboard-page-context", () => ({
  requireAuthorizedDashboardAccess: mocks.access,
}));
vi.mock("@/src/subscriber-ledger-runtime", () => ({
  loadSubscriberLedgerRequestContext: mocks.loadRequestContext,
  loadSubscriberStateCounts: mocks.loadStateCounts,
}));
vi.mock("@/src/newsletter-signup-runtime", () => ({
  loadPendingSignupCount: mocks.loadPendingSignupCount,
}));

import DashboardSubscribersPage from "./page";

const ownerMembership = { id: "membership-owner", role: "owner" };
const editorMembership = { id: "membership-editor", role: "editor" };
const identity = {
  binding: { issuer: "https://access.example", subject: "owner" },
  email: "owner@example.com",
  nonce: "owner-nonce",
};
const ownerAccess = {
  state: "authorized",
  identity,
  membership: ownerMembership,
};
const editorAccess = {
  state: "authorized",
  identity,
  membership: editorMembership,
};

const subscribers = [
  {
    id: "subscriber-1",
    siteId: "site_reference",
    identityKey: "a".repeat(64),
    email: "confirmed@example.com",
    state: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    latestConsentAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "subscriber-2",
    siteId: "site_reference",
    identityKey: "b".repeat(64),
    email: "left@example.com",
    state: "unsubscribed",
    createdAt: "2026-01-02T00:00:00.000Z",
    updatedAt: "2026-01-03T00:00:00.000Z",
    latestConsentAt: "2026-01-02T00:00:00.000Z",
  },
  {
    id: "subscriber-3",
    siteId: "site_reference",
    identityKey: "c".repeat(64),
    email: null,
    state: "erased",
    createdAt: "2026-01-04T00:00:00.000Z",
    updatedAt: "2026-01-05T00:00:00.000Z",
    latestConsentAt: null,
  },
];

describe("the Subscribers dashboard screen", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadPendingSignupCount.mockResolvedValue(2);
  });

  it("shows an Owner every address, its state and its consent date, from the audited query", async () => {
    mocks.access.mockResolvedValue(ownerAccess);
    mocks.loadRequestContext.mockResolvedValue({
      identity,
      application: {
        queries: {
          listIdentities: mocks.listIdentities,
        },
      },
    });
    mocks.listIdentities.mockResolvedValue(subscribers);

    const markup = renderToStaticMarkup(await DashboardSubscribersPage());

    expect(mocks.listIdentities).toHaveBeenCalledWith({ actor: identity });
    expect(markup).toContain("confirmed@example.com");
    expect(markup).toContain("left@example.com");
    expect(markup).toContain("Address removed");
    expect(markup).toContain("Confirmed");
    expect(markup).toContain("Unsubscribed");
    expect(markup).toContain("Suppressed");
    expect(markup).toContain("Waiting to confirm");
    expect(markup).toContain("Download as CSV");
    // A record with no consent event shows a dash, never the word null.
    expect(markup).toContain("—");
    expect(markup).not.toContain(">null<");
    // Never a raw ledger state string on screen.
    expect(markup).not.toContain("hard_bounced");
    expect(markup).not.toContain("erased");
    expect(markup).not.toContain('">active<');
    // The counts-only path was never even asked for.
    expect(mocks.loadStateCounts).not.toHaveBeenCalled();
  });

  it("shows an Owner the pending-signup count from the signup store, not the ledger", async () => {
    mocks.access.mockResolvedValue(ownerAccess);
    mocks.loadRequestContext.mockResolvedValue({
      identity,
      application: { queries: { listIdentities: mocks.listIdentities } },
    });
    mocks.listIdentities.mockResolvedValue([]);
    mocks.loadPendingSignupCount.mockResolvedValue(5);

    const markup = renderToStaticMarkup(await DashboardSubscribersPage());

    expect(mocks.loadPendingSignupCount).toHaveBeenCalledTimes(1);
    expect(markup).toContain("Waiting to confirm");
    expect(markup).toMatch(/Waiting to confirm[\s\S]*?>5</);
  });

  it("shows an Editor the same four counts and never an address", async () => {
    mocks.access.mockResolvedValue(editorAccess);
    mocks.loadStateCounts.mockResolvedValue({
      confirmed: 1,
      unsubscribed: 1,
      suppressed: 1,
    });

    const markup = renderToStaticMarkup(await DashboardSubscribersPage());

    expect(markup).toContain("Confirmed");
    expect(markup).toContain("Unsubscribed");
    expect(markup).toContain("Suppressed");
    expect(markup).toContain("Waiting to confirm");
    expect(markup).toContain(
      "Only an Owner can see an email address or download this list.",
    );
    expect(markup).not.toContain("@example.com");
    expect(markup).not.toContain("Download as CSV");
    expect(markup).not.toContain("<table");
    // The Owner-only, audited query was never called for an Editor.
    expect(mocks.loadRequestContext).not.toHaveBeenCalled();
    expect(mocks.listIdentities).not.toHaveBeenCalled();
    // The counts-only query is given proof of authorized dashboard access,
    // not called by anybody who has not gone through it.
    expect(mocks.loadStateCounts).toHaveBeenCalledWith(editorAccess);
  });

  it("carries no address anywhere in the markup for an Editor, even encoded", async () => {
    mocks.access.mockResolvedValue(editorAccess);
    mocks.loadStateCounts.mockResolvedValue({
      confirmed: 3,
      unsubscribed: 0,
      suppressed: 0,
    });

    const markup = renderToStaticMarkup(await DashboardSubscribersPage());
    expect(markup).not.toContain("@");
  });
});
