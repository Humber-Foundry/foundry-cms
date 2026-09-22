import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  operationsContext: vi.fn(),
  submission: vi.fn(),
  mutationToken: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", () => ({
  notFound() {
    throw new Error("not_found");
  },
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("@/src/human-access-runtime", () => ({
  loadHumanAccessRequestContext: mocks.access,
}));
vi.mock("@/src/public-form-messages-runtime", () => ({
  createPublicFormOperationsContext: mocks.operationsContext,
  // Empty plan: `summarizePublicFormSubmission` answers safe defaults for an
  // unknown form id, which is all this screen's own markup needs.
  installedPublicFormInboxPlan: {},
}));
vi.mock("@/src/human-mutation-runtime", () => ({
  createHumanMutationToken: mocks.mutationToken,
}));

import FormSubmissionPage from "./page";

const identity = {
  binding: { issuer: "https://access.example", subject: "owner" },
  email: "owner@example.com",
  nonce: "owner-nonce",
};
const ownerMembership = { id: "membership-owner", role: "owner" };

function submission(overrides: Record<string, unknown> = {}) {
  return {
    formId: "contact",
    receiptId: "receipt-1",
    acceptedAt: "2026-09-18T10:00:00.000Z",
    classification: "accepted",
    payloadDeleted: false,
    fields: { message: "Hello" },
    ...overrides,
  };
}

describe("the one-message dashboard screen (#227)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.access.mockResolvedValue({
      state: "authorized",
      identity,
      membership: ownerMembership,
    });
    mocks.operationsContext.mockResolvedValue({
      queries: { submission: mocks.submission },
    });
    mocks.mutationToken.mockResolvedValue("token-1");
  });

  it("shows the shared back link to Messages, above the heading", async () => {
    mocks.submission.mockResolvedValue(submission());

    const markup = renderToStaticMarkup(
      await FormSubmissionPage({
        params: Promise.resolve({ receiptId: "receipt-1" }),
      }),
    );

    // The shared component's own class, not the old hand-written anchor.
    expect(markup).toContain('class="dash-back-link" href="/dash/forms"');
    expect(markup).toContain("Back to Messages");
    // The back link renders before the message heading.
    expect(markup.indexOf("dash-back-link")).toBeLessThan(
      markup.indexOf("<h1"),
    );
  });
});
