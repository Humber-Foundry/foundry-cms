import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  mutationToken: vi.fn(),
  preview: vi.fn(),
  record: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  notFound() {
    throw new Error("not_found");
  },
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("@/src/dashboard-page-context", () => ({
  requireAuthorizedDashboardAccess: mocks.access,
  loadMutationToken: mocks.mutationToken,
}));
vi.mock("@/src/mcp-preview-review-runtime", () => ({
  loadMcpPreviewForHuman: mocks.preview,
  recordPreviewReviewDecision: mocks.record,
}));
import McpPreviewReviewPage from "./page";

const membership = { id: "membership-owner", siteId: "site_foundry" };

function review(overrides: Record<string, unknown> = {}) {
  return {
    revision: {
      workspaceId: "workspace_mcp_70",
      revision: 4,
      bookmark: "bookmark-70",
      definition: { pages: [] },
    },
    review: {
      previewId: "preview_11111111-2222-3333-4444-555555555555",
      actorId: "agent-70",
      agentName: "helper.example",
      preparedAt: "2026-09-18T10:00:00.000Z",
      decided: null,
      pages: [
        {
          pageId: "page_about",
          title: "About us",
          path: "/about",
          state: "created",
          changedFields: [],
        },
      ],
      changedDocuments: ["About us — new page at /about"],
      designChanges: [],
      publicEffect:
        "Visitors get a new page at /about. " +
        "This review does not approve or publish anything.",
      ...overrides,
    },
  };
}

async function markupFor(selected: unknown) {
  mocks.access.mockResolvedValue({ state: "authorized", membership });
  mocks.mutationToken.mockResolvedValue("token-70");
  mocks.preview.mockResolvedValue(selected);
  return renderToStaticMarkup(
    await McpPreviewReviewPage({
      params: Promise.resolve({
        previewId: "preview_11111111-2222-3333-4444-555555555555",
      }),
    }),
  );
}

describe("Draft review screen", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("names who prepared the draft, what changed and what visitors get", async () => {
    const markup = await markupFor(review());

    expect(markup).toContain("helper.example");
    // Where the name comes from is explained by the shared help control, so
    // the closed panel's words are not in the markup — its trigger is.
    expect(markup).toContain("Where does this name come from?");
    expect(markup).toContain("About us");
    expect(markup).toContain("Visitors get a new page at /about.");
    // The sentence that says the review approves nothing belongs on a screen
    // with no Approve control. This screen has one.
    expect(markup).not.toContain("does not approve or publish anything");
  });

  it("offers Approve and Ask for changes, and links to the exact preview", async () => {
    const markup = await markupFor(review());

    expect(markup).toContain("Approve this draft");
    expect(markup).toContain("Ask for changes");
    expect(markup).toContain(
      "/dash/review/preview_11111111-2222-3333-4444-555555555555/preview",
    );
    // Approve stays off until the person opens the preview in this session.
    expect(markup).toContain("disabled");
    expect(markup).toContain("Approve turns on after you open the preview.");
  });

  it("approves nothing when the page is opened", async () => {
    const markup = await markupFor(review());

    // The page reaches the review runtime, so this proves the read path is the
    // only one it uses: it looks the preview up and records no decision.
    expect(mocks.preview).toHaveBeenCalledTimes(1);
    expect(mocks.record).not.toHaveBeenCalled();
    // Nothing on the screen can post by itself either.
    expect(markup).not.toContain("<form");
  });

  it("shows the reason a person typed as text, not as markup", async () => {
    const markup = await markupFor(
      review({
        decided: {
          decision: "changes_requested",
          approvalId: null,
          reason: "Fix the <script>alert(1)</script> heading",
          decidedAt: "2026-09-18T11:00:00.000Z",
        },
      }),
    );

    expect(markup).not.toContain("<script>");
    expect(markup).toContain("&lt;script&gt;");
    expect(markup).not.toContain("Approve this draft");
  });

  it("shows a way back to Overview at the top, on every answer state (#227)", async () => {
    const undecided = await markupFor(review());
    expect(undecided).toContain('class="dash-back-link" href="/dash"');
    expect(undecided).toContain("Back to Overview");

    const decided = await markupFor(
      review({
        decided: {
          decision: "approved",
          approvalId: "approval-1",
          reason: null,
          decidedAt: "2026-09-18T11:00:00.000Z",
        },
      }),
    );
    expect(decided).toContain('class="dash-back-link" href="/dash"');
  });

  it("has no Done control until the draft is answered, then one that returns to Overview (#227)", async () => {
    const undecided = await markupFor(review());
    expect(undecided).not.toContain(">Done<");

    const decided = await markupFor(
      review({
        decided: {
          decision: "approved",
          approvalId: "approval-1",
          reason: null,
          decidedAt: "2026-09-18T11:00:00.000Z",
        },
      }),
    );
    expect(decided).toContain(">Done<");
    expect(decided).toContain('dash-button-primary" href="/dash"');
  });

  it("is not found when the preview no longer matches the current draft", async () => {
    mocks.access.mockResolvedValue({ state: "authorized", membership });
    mocks.mutationToken.mockResolvedValue("token-70");
    mocks.preview.mockResolvedValue(null);

    await expect(
      McpPreviewReviewPage({
        params: Promise.resolve({ previewId: "preview-gone" }),
      }),
    ).rejects.toThrow("not_found");
  });
});
