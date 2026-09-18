import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import {
  createContentActorId,
  createContentWorkspaceId,
  type ArchivedBlogPostSummary,
  type ContentRevision,
} from "@humber-foundry/application";
import { referenceSiteDefinition } from "@humber-foundry/site-definition";

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
        }),
      );
    });
    return host;
  }

  it("shows a stalled archive in plain words with its next actions", async () => {
    render([stalledArchivedPost()]);

    await expect
      .element(page.getByText("Archiving — coming off the site"))
      .toBeInTheDocument();
    await expect
      .element(
        page.getByText(
          "Archive pending; the post remains live until this finishes. This can take a few minutes. If it does not finish, use Continue archiving below.",
        ),
      )
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Continue archiving" }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Recover access" }))
      .toBeInTheDocument();
    // Restoring is only offered once a post has finished archiving.
    const restoreButtons = document.querySelectorAll<HTMLButtonElement>(
      "button",
    );
    const restore = Array.from(restoreButtons).find(
      (button) => button.textContent === "Restore as draft",
    );
    expect(restore?.disabled).toBe(true);
  });

  it("reports the server's reason in place when recovering access fails", async () => {
    const submitted: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        submitted.push({ url: String(input), body: init?.body });
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

  it("reports the server's reason in place when continuing a stalled withdrawal fails", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        Response.json({ error: "archive_request_not_found" }, {
          status: 422,
        }),
    );

    render([stalledArchivedPost()]);

    await userEvent.click(
      page.getByRole("button", { name: "Continue archiving" }),
    );

    await expect
      .element(
        page.getByText(
          "This archive could not be found. Refresh the page and try again.",
        ),
      )
      .toBeInTheDocument();
  });

  it("does not offer to continue or recover access once a post has fully archived", async () => {
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
    expect(buttonLabels).not.toContain("Continue archiving");
    expect(buttonLabels).not.toContain("Recover access");
  });
});
