import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import {
  createContentActorId,
  createContentWorkspaceId,
  type ArchivedBlogPostSummary,
  type BlogPostOperationalSummary,
  type BlogPostScheduleProposal,
  type ContentRevision,
} from "@humber-foundry/application";
import {
  createBlogPostId,
  createRichTextDocumentFromPlainText,
  referenceSiteDefinition,
  type BlogPost,
} from "@humber-foundry/site-definition";

import { BlogPostControls } from "./blog-post-controls";

const workspaceId = createContentWorkspaceId("workspace_blog_dashboard");

const revision: ContentRevision = {
  workspaceId,
  revision: 4,
  definition: {
    ...referenceSiteDefinition,
    blog: { ...referenceSiteDefinition.blog, posts: [] },
  },
  inputs: {
    contentHash: "a".repeat(64),
    schemaVersion: referenceSiteDefinition.schemaVersion,
    rendererVersion: "1".repeat(40),
    productionBase: "published:site_reference@1.0.0",
  },
  createdAt: "2026-09-01T00:00:00.000Z",
  createdBy: createContentActorId("membership-editor"),
};

function stalledArchivedPost(): ArchivedBlogPostSummary {
  return {
    siteId: referenceSiteDefinition.site.id,
    postId: "post-tide-notes",
    workspaceId,
    contentRevision: 4,
    postRevision: 2,
    postRevisionId: "post-revision-2",
    collectionState: "archiving",
    workflowState: "editing",
    liveRevisionId: "revision-live-1",
    version: 3,
    title: "Tide notes",
    slug: "tide-notes",
    excerpt: "What the tides taught us.",
    archivedAt: null,
    archiveRequestId: "archive-request-0001",
  };
}

const pendingPostId = createBlogPostId(
  "00000000-0000-4000-8000-00000000f001",
);

function pendingSchedulePost(): BlogPost {
  return {
    id: pendingPostId,
    revision: 1,
    collectionState: "active",
    targetVisibility: "public",
    slug: "tide-notes",
    title: "Tide notes",
    excerpt: "What the tides taught us.",
    seo: { title: "", description: "", keywords: [], shareImage: null },
    mainImage: null,
    body: createRichTextDocumentFromPlainText("What the tides taught us."),
  };
}

function pendingScheduleProposal(): BlogPostScheduleProposal {
  return {
    id: "proposal-0001",
    siteId: referenceSiteDefinition.site.id,
    postId: pendingPostId,
    workspaceId,
    contentRevision: 4,
    postRevisionId: "post-revision-1",
    authorityVersion: 1,
    localDateTime: "2026-10-01T09:00",
    ianaTimeZone: "America/Vancouver",
    utcOffsetChoice: "-07:00",
    executeAtUtc: "2026-10-01T16:00:00.000Z",
    timeZoneDatabaseVersion: "2026a",
    createdBy: createContentActorId("mcp-connection-agent"),
    proposalAuditId: "audit-0001",
    createdAt: "2026-09-20T00:00:00.000Z",
  };
}

function pendingScheduleSummary(): BlogPostOperationalSummary {
  return {
    siteId: referenceSiteDefinition.site.id,
    postId: pendingPostId,
    workspaceId,
    contentRevision: 4,
    postRevision: 1,
    postRevisionId: "post-revision-1",
    collectionState: "active",
    workflowState: "editing",
    liveRevisionId: null,
    version: 1,
    archiveRequestId: null,
    activeSchedule: null,
    latestExecution: null,
    pendingScheduleProposal: pendingScheduleProposal(),
  };
}

/** Waits for `read` to return a truthy value, so no test depends on a fixed delay. */
async function waitFor(read: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    if (read()) return;
    if (Date.now() > deadline) throw new Error("condition_not_reached");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function confirmButton(): HTMLButtonElement | undefined {
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((button) => button.textContent === "Confirm and continue archiving");
}

describe("blog post controls browser acceptance", () => {
  let root: ReturnType<typeof createRoot> | undefined;

  afterEach(() => {
    vi.unstubAllGlobals();
    if (root !== undefined) flushSync(() => root!.unmount());
    document.body.replaceChildren();
  });

  function render(archivedPosts: ReadonlyArray<ArchivedBlogPostSummary>) {
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    flushSync(() => {
      root!.render(
        createElement(BlogPostControls, {
          revision,
          csrfToken: "csrf-token",
          siteImages: [],
          verifiedPublicPostIds: [],
          postSummaries: new Map(),
          archivedPosts,
          pendingScheduleRequestAgentNames: new Map(),
        }),
      );
    });
    return host;
  }

  it("shows a stalled archive in plain words, with confirm disabled until previewed", async () => {
    render([stalledArchivedPost()]);

    await expect
      .element(page.getByText("Archiving — coming off the site"))
      .toBeInTheDocument();
    await expect
      .element(
        page.getByText(
          "Preview the site without this post before you can confirm. This shows what visitors will see once the post is fully off the site.",
        ),
      )
      .toBeInTheDocument();
    await expect
      .element(
        page.getByRole("button", {
          name: "Preview the site without this post ↗",
        }),
      )
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Recover access" }))
      .toBeInTheDocument();
    expect(confirmButton()?.disabled).toBe(true);
    // Restoring is only offered once a post has finished archiving.
    const restore = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent === "Restore as draft");
    expect(restore?.disabled).toBe(true);
  });

  it("enables confirm only after the withdrawal preview was opened in this session", async () => {
    const submitted: Array<{ url: string; body: string }> = [];
    vi.stubGlobal("open", vi.fn(() => null));
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        // The Blog list's connection-status note reads publishing readiness
        // on its own, on mount, separate from this test's steps. It is not
        // one of the requests this test is about.
        if (url === "/api/foundry-cms/publishing-readiness") {
          return Response.json({
            publishing: {
              state: "connected",
              missingSettings: [],
              setupGuide: "docs/operations/github-publishing-readiness.md",
            },
          });
        }
        submitted.push({ url, body: String(init?.body) });
        if (url === "/api/foundry-cms/blog-operations") {
          return Response.json({
            archiveRequestId: "archive-request-0001",
            withdrawal: { workspaceId: "workspace_withdrawal_1", revision: 9 },
          });
        }
        return Response.json({
          previewUrl:
            "/__foundry/preview/workspace_withdrawal_1/9?capability=x",
        });
      },
    );

    render([stalledArchivedPost()]);

    expect(confirmButton()?.disabled).toBe(true);

    await userEvent.click(
      page.getByRole("button", {
        name: "Preview the site without this post ↗",
      }),
    );

    await waitFor(() => confirmButton()?.disabled === false);

    expect(submitted).toHaveLength(2);
    expect(submitted[0]!.url).toBe("/api/foundry-cms/blog-operations");
    expect(JSON.parse(submitted[0]!.body)).toMatchObject({
      operation: "recover_archive_withdrawal_access",
      postId: "post-tide-notes",
      archiveRequestId: "archive-request-0001",
    });
    expect(submitted[1]!.url).toBe("/api/foundry-cms/revisions");
    expect(JSON.parse(submitted[1]!.body)).toMatchObject({
      operation: "open_preview",
      workspaceId: "workspace_withdrawal_1",
      revision: 9,
    });
    // The preview hint is gone once a preview for this exact withdrawal has
    // been opened.
    expect(
      Array.from(document.querySelectorAll("p")).some(
        (paragraph) =>
          paragraph.textContent ===
          "Preview the site without this post before you can confirm. This shows what visitors will see once the post is fully off the site.",
      ),
    ).toBe(false);
  });

  it("reports the server's reason in place when the preview cannot be opened, and confirm stays disabled", async () => {
    vi.stubGlobal("open", vi.fn(() => null));
    vi.stubGlobal(
      "fetch",
      async () =>
        Response.json({ error: "human_authority_required" }, { status: 422 }),
    );

    render([stalledArchivedPost()]);

    await userEvent.click(
      page.getByRole("button", {
        name: "Preview the site without this post ↗",
      }),
    );

    await expect
      .element(
        page.getByText(
          "You do not have access to finish this. Ask an owner or editor to help.",
        ),
      )
      .toBeInTheDocument();
    expect(confirmButton()?.disabled).toBe(true);
  });

  it("reports the server's reason in place when recovering access fails", async () => {
    const submitted: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        // The Blog list's connection-status note reads publishing readiness
        // on its own, on mount, separate from this test's steps. It is not
        // one of the requests this test is about.
        if (url === "/api/foundry-cms/publishing-readiness") {
          return Response.json({
            publishing: {
              state: "connected",
              missingSettings: [],
              setupGuide: "docs/operations/github-publishing-readiness.md",
            },
          });
        }
        submitted.push({ url, body: init?.body });
        return Response.json(
          { error: "human_authority_required" },
          { status: 422 },
        );
      },
    );

    render([stalledArchivedPost()]);

    await userEvent.click(
      page.getByRole("button", { name: "Recover access" }),
    );

    await expect
      .element(
        page.getByText(
          "You do not have access to finish this. Ask an owner or editor to help.",
        ),
      )
      .toBeInTheDocument();
    expect(submitted).toHaveLength(1);
    const [{ url, body }] = submitted as Array<
      { url: string; body: string }
    >;
    expect(url).toBe("/api/foundry-cms/blog-operations");
    expect(JSON.parse(body)).toMatchObject({
      operation: "recover_archive_withdrawal_access",
      postId: "post-tide-notes",
      archiveRequestId: "archive-request-0001",
    });
  });

  it("never sends an approve request before the withdrawal preview was opened, and reports a confirm failure in place", async () => {
    vi.stubGlobal("open", vi.fn(() => null));
    let call = 0;
    const submitted: Array<{ url: string; body: string }> = [];
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        // The Blog list's connection-status note reads publishing readiness
        // on its own, on mount, separate from this test's numbered steps.
        if (url === "/api/foundry-cms/publishing-readiness") {
          return Response.json({
            publishing: {
              state: "connected",
              missingSettings: [],
              setupGuide: "docs/operations/github-publishing-readiness.md",
            },
          });
        }
        submitted.push({ url, body: String(init?.body) });
        call += 1;
        if (call === 1) {
          return Response.json({
            archiveRequestId: "archive-request-0001",
            withdrawal: { workspaceId: "workspace_withdrawal_1", revision: 9 },
          });
        }
        if (call === 2) {
          return Response.json({
            previewUrl:
              "/__foundry/preview/workspace_withdrawal_1/9?capability=x",
          });
        }
        if (call === 3) {
          return Response.json({ id: "approval-withdrawal-1" });
        }
        return Response.json(
          { error: "archive_request_not_found" },
          { status: 422 },
        );
      },
    );

    render([stalledArchivedPost()]);

    await userEvent.click(
      page.getByRole("button", {
        name: "Preview the site without this post ↗",
      }),
    );
    await waitFor(() => confirmButton()?.disabled === false);

    // No approve request has gone out merely from opening the preview.
    expect(
      submitted.some((request) => request.url === "/api/foundry-cms/publications"),
    ).toBe(false);

    await userEvent.click(confirmButton()!);

    await expect
      .element(
        page.getByText(
          "This archive could not be found. Refresh the page and try again.",
        ),
      )
      .toBeInTheDocument();
    expect(submitted).toHaveLength(4);
    expect(submitted[2]!.url).toBe("/api/foundry-cms/publications");
    expect(JSON.parse(submitted[2]!.body)).toMatchObject({
      operation: "approve",
      workspaceId: "workspace_withdrawal_1",
      revision: 9,
      previewConfirmed: true,
    });
    expect(submitted[3]!.url).toBe("/api/foundry-cms/blog-operations");
    expect(JSON.parse(submitted[3]!.body)).toMatchObject({
      operation: "continue_archive_withdrawal",
      postId: "post-tide-notes",
      archiveRequestId: "archive-request-0001",
      withdrawalApprovalId: "approval-withdrawal-1",
    });
  });

  it("does not offer to preview, confirm, or recover access once a post has fully archived", async () => {
    render([
      {
        ...stalledArchivedPost(),
        collectionState: "archived",
        liveRevisionId: null,
      },
    ]);

    await expect
      .element(page.getByText("Archived", { exact: true }))
      .toBeInTheDocument();
    const buttonLabels = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).map((button) => button.textContent);
    expect(buttonLabels).not.toContain("Preview the site without this post ↗");
    expect(buttonLabels).not.toContain("Confirm and continue archiving");
    expect(buttonLabels).not.toContain("Recover access");
  });

  /**
   * Issue #222: neither the site-publish notice nor a pending schedule
   * request may put a button inside the sentence of text — the button
   * belongs in its own row or action group. This post's `targetVisibility`
   * is "public" but is not yet in `verifiedPublicPostIds`, which is exactly
   * the state `blogHasPendingSitePublish` reports as pending, and it also
   * carries a pending schedule proposal, so both banners render together.
   */
  function renderWithPendingSchedule() {
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    flushSync(() => {
      root!.render(
        createElement(BlogPostControls, {
          revision: {
            ...revision,
            definition: {
              ...revision.definition,
              blog: {
                ...revision.definition.blog,
                posts: [pendingSchedulePost()],
              },
            },
          },
          csrfToken: "csrf-token",
          siteImages: [],
          verifiedPublicPostIds: [],
          postSummaries: new Map([[pendingPostId, pendingScheduleSummary()]]),
          archivedPosts: [],
          pendingScheduleRequestAgentNames: new Map([
            [pendingPostId, "Draft Assistant"],
          ]),
        }),
      );
    });
    return host;
  }

  it("never nests the site-publish or decline button inside a sentence of text", async () => {
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/foundry-cms/publishing-readiness") {
          return Response.json({
            publishing: {
              state: "connected",
              missingSettings: [],
              setupGuide: "docs/operations/github-publishing-readiness.md",
            },
          });
        }
        return Response.json({});
      },
    );

    renderWithPendingSchedule();

    await expect
      .element(
        page.getByText(
          "A post here is marked for the next site publish and is not live until then.",
        ),
      )
      .toBeInTheDocument();
    const publishLink = document.querySelector<HTMLAnchorElement>(
      'a[href="/dash/pages"]',
    );
    expect(publishLink?.textContent).toBe("Publish the site");
    // The button sits in its own row, never inside the sentence's <p>.
    expect(publishLink?.closest("p")).toBeNull();

    await expect
      .element(
        page.getByText(
          /Draft Assistant asked to publish this at/u,
        ),
      )
      .toBeInTheDocument();
    const declineButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent === "Decline");
    expect(declineButton).toBeDefined();
    // The Decline button sits in the post's action row next to Edit and
    // Preview, never inside the sentence's <p>.
    expect(declineButton!.closest("p")).toBeNull();
    expect(declineButton!.closest(".post-list-actions")).not.toBeNull();
    // No paragraph anywhere in the Blog list carries a button as a child —
    // the owner's rule for every screen this ticket covers.
    expect(document.querySelectorAll("p button")).toHaveLength(0);
  });

  it("declines the pending schedule request from its action-row button", async () => {
    const submitted: Array<{ url: string; body: string }> = [];
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/foundry-cms/publishing-readiness") {
          return Response.json({
            publishing: {
              state: "connected",
              missingSettings: [],
              setupGuide: "docs/operations/github-publishing-readiness.md",
            },
          });
        }
        submitted.push({ url, body: String(init?.body) });
        // A non-2xx result is enough to check the request the button sent
        // without triggering the success path's page navigation, which the
        // browser test environment cannot follow.
        return Response.json(
          { error: "archive_request_not_found" },
          { status: 422 },
        );
      },
    );

    renderWithPendingSchedule();

    await userEvent.click(page.getByRole("button", { name: "Decline" }));

    await waitFor(() => submitted.length > 0);
    expect(submitted[0]!.url).toBe("/api/foundry-cms/blog-operations");
    expect(JSON.parse(submitted[0]!.body)).toMatchObject({
      operation: "decline_schedule_proposal",
      postId: pendingPostId,
      proposalId: "proposal-0001",
    });
  });
});
