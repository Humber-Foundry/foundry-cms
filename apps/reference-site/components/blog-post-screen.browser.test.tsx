import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import {
  createContentActorId,
  createContentWorkspaceId,
  type BlogPostOperationalSummary,
  type ContentRevision,
} from "@humber-foundry/application";
import {
  createBlogPostId,
  createRichTextDocumentFromPlainText,
  referenceSiteDefinition,
  type BlogPost,
} from "@humber-foundry/site-definition";

import { BlogPostScreen } from "./blog-post-screen";

const workspaceId = createContentWorkspaceId("workspace_blog_post_screen");

const postId = createBlogPostId("00000000-0000-4000-8000-00000000f002");

function post(): BlogPost {
  return {
    id: postId,
    revision: 1,
    collectionState: "active",
    targetVisibility: "unpublished",
    slug: "tide-notes",
    title: "Tide notes",
    excerpt: "What the tides taught us.",
    seo: { title: "", description: "", keywords: [], shareImage: null },
    mainImage: null,
    body: createRichTextDocumentFromPlainText("What the tides taught us."),
  };
}

const revision: ContentRevision = {
  workspaceId,
  revision: 4,
  definition: {
    ...referenceSiteDefinition,
    blog: { ...referenceSiteDefinition.blog, posts: [post()] },
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

function summary(): BlogPostOperationalSummary {
  return {
    siteId: referenceSiteDefinition.site.id,
    postId,
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
    pendingScheduleProposal: null,
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

const scheduleNeedsPreview =
  "Scheduling needs a preview of this exact version. Preview this post, " +
  "then schedule it. Editing the post after that clears its schedule, so " +
  "schedule it again after any later edit.";

describe("one blog post's own screen", () => {
  let root: ReturnType<typeof createRoot> | undefined;

  afterEach(() => {
    vi.unstubAllGlobals();
    if (root !== undefined) flushSync(() => root!.unmount());
    document.body.replaceChildren();
  });

  function render(
    postSummary: BlogPostOperationalSummary = summary(),
    pendingScheduleRequestAgentName: string | null = null,
  ) {
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    flushSync(() => {
      root!.render(
        createElement(BlogPostScreen, {
          revision,
          post: post(),
          csrfToken: "csrf-token",
          siteImages: [],
          verifiedPublicPostIds: [],
          summary: postSummary,
          pendingScheduleRequestAgentName,
        }),
      );
    });
    return host;
  }

  function stubPublishingReadiness(
    onRequest?: (url: string, init?: RequestInit) => Response | null,
  ) {
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
        return onRequest?.(url, init) ?? Response.json({});
      },
    );
  }

  it("shows where the post stands, its preview control and its writing box", async () => {
    stubPublishingReadiness();

    render();

    await expect
      .element(page.getByText("Draft — not on your site"))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Preview ↗" }))
      .toBeInTheDocument();
    // The screen says the owner can publish from here, so the control is here.
    await expect
      .element(page.getByRole("button", { name: "Publish" }))
      .toBeInTheDocument();
    const title = document.querySelector<HTMLInputElement>(
      'input[name="title"]',
    );
    expect(title?.value).toBe("Tide notes");
  });

  it("names the app's publish request and declines it from this screen", async () => {
    const submitted: Array<{ url: string; body: string }> = [];
    stubPublishingReadiness((url, init) => {
      submitted.push({ url, body: String(init?.body) });
      // A non-2xx result is enough to check the request the button sent
      // without the success path's page load, which this test cannot follow.
      return Response.json(
        { error: "schedule_proposal_not_found" },
        { status: 422 },
      );
    });

    render(
      {
        ...summary(),
        pendingScheduleProposal: {
          id: "proposal-0001",
          siteId: referenceSiteDefinition.site.id,
          postId,
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
        },
      },
      "Draft Assistant",
    );

    await expect
      .element(page.getByText(/Draft Assistant asked to publish this at/u))
      .toBeInTheDocument();

    await userEvent.click(
      page.getByRole("button", { name: "Decline the app's publish request" }),
    );

    await waitFor(() => submitted.length > 0);
    expect(submitted[0]!.url).toBe("/api/foundry-cms/blog-operations");
    expect(JSON.parse(submitted[0]!.body)).toMatchObject({
      operation: "decline_schedule_proposal",
      postId,
      proposalId: "proposal-0001",
    });
  });

  it("offers the schedule only after a preview was opened in this session", async () => {
    const submitted: Array<{ url: string; body: string }> = [];
    vi.stubGlobal("open", vi.fn(() => null));
    stubPublishingReadiness((url, init) => {
      submitted.push({ url, body: String(init?.body) });
      return Response.json({
        previewUrl: "/__foundry/preview/workspace_blog_post_screen/4?capability=x",
      });
    });

    render();

    await expect
      .element(page.getByText(scheduleNeedsPreview))
      .toBeInTheDocument();
    expect(
      Array.from(document.querySelectorAll("summary")).map(
        (element) => element.textContent,
      ),
    ).not.toContain("Schedule this post");

    await userEvent.click(page.getByRole("button", { name: "Preview ↗" }));

    await waitFor(() => submitted.length > 0);
    expect(submitted[0]!.url).toBe("/api/foundry-cms/revisions");
    expect(JSON.parse(submitted[0]!.body)).toMatchObject({
      operation: "open_preview",
      workspaceId,
      revision: 4,
    });
    await expect
      .element(page.getByText("Schedule this post"))
      .toBeInTheDocument();
  });
});
