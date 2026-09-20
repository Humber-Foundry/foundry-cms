import { beforeEach, describe, expect, it, vi } from "vitest";

import { createContentWorkspaceId } from "@humber-foundry/application";
import {
  homePage,
  referenceSiteDefinition,
  resolveSiteHref,
  type SiteHref,
} from "@humber-foundry/site-definition";

import { twoPageSiteDefinition } from "./test-support/two-page-site-definition";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  getRevision: vi.fn(),
  isRevisionCurrent: vi.fn(),
  loadApplication: vi.fn(),
  loadIdentity: vi.fn(),
  loadMcpPreview: vi.fn(),
  verifyCapability: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    cache<T extends (...args: never[]) => unknown>(callback: T): T {
      const values = new Map<string, ReturnType<T>>();
      return ((...args: Parameters<T>) => {
        const key = JSON.stringify(args);
        if (!values.has(key)) {
          values.set(key, callback(...args) as ReturnType<T>);
        }
        return values.get(key);
      }) as T;
    },
  };
});
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", () => ({
  notFound() {
    throw new Error("not_found");
  },
}));
vi.mock("./human-access-runtime", () => ({
  authorizeAuthenticatedHumanIdentity: mocks.authorize,
  loadHumanIdentityRequestContext: mocks.loadIdentity,
}));
vi.mock("./content-revision-runtime", () => ({
  loadContentRevisionApplication: mocks.loadApplication,
}));
vi.mock("./preview-capability-runtime", () => ({
  verifyRevisionPreviewCapability: mocks.verifyCapability,
}));
vi.mock("./mcp-preview-review-runtime", () => ({
  loadMcpPreviewForHuman: mocks.loadMcpPreview,
}));

import {
  buildRevisionPreviewLinks,
  loadRevisionPreview,
} from "./revision-preview-page";

describe("revision preview page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("memoizes one authenticated revision for metadata and body", async () => {
    const identity = {
      binding: { issuer: "issuer", subject: "subject" },
      email: "editor@example.com",
    };
    const revision = {
      workspaceId: "workspace_home",
      revision: 3,
      createdAt: "2026-07-27T12:00:00.000Z",
      definition: {
        pages: [
          {
            slug: "",
            seo: {
              title: "Edited SEO title",
              description: "Edited SEO description",
              keywords: [],
              shareImage: null,
            },
          },
        ],
      },
      inputs: {
        contentHash: "content-hash",
        schemaVersion: "1.2.0",
        rendererVersion: "renderer-a",
        productionBase: "production-a",
      },
    };
    mocks.loadIdentity.mockResolvedValue({ identity });
    mocks.authorize.mockResolvedValue({
      state: "authorized",
      identity,
      membership: { id: "membership-editor" },
    });
    mocks.getRevision.mockResolvedValue(revision);
    mocks.isRevisionCurrent.mockResolvedValue(true);
    mocks.loadApplication.mockResolvedValue({
      queries: {
        getRevision: mocks.getRevision,
        isRevisionCurrent: mocks.isRevisionCurrent,
      },
    });
    const props = {
      params: Promise.resolve({
        workspaceId: "workspace_home",
        revision: "3",
      }),
      searchParams: Promise.resolve({
        capability: "preview-capability",
        bookmark: "d1-bookmark",
      }),
    };

    const metadataRevision = await loadRevisionPreview(props);
    const bodyRevision = await loadRevisionPreview(props);

    expect(metadataRevision).toBe(bodyRevision);
    expect(homePage(metadataRevision.definition).seo).toEqual({
      title: "Edited SEO title",
      description: "Edited SEO description",
      keywords: [],
      shareImage: null,
    });
    expect(mocks.loadIdentity).toHaveBeenCalledTimes(1);
    expect(mocks.authorize).toHaveBeenCalledTimes(1);
    expect(mocks.verifyCapability).toHaveBeenCalledTimes(1);
    expect(mocks.getRevision).toHaveBeenCalledTimes(1);
    expect(mocks.isRevisionCurrent).toHaveBeenCalledTimes(1);
  });

  it("keeps MCP review on the authenticated revision capability path", async () => {
    const identity = {
      binding: { issuer: "issuer", subject: "subject" },
      email: "owner@example.com",
    };
    const revision = {
      workspaceId: "workspace_mcp_review",
      revision: 2,
      bookmark: "mcp-bookmark",
      createdAt: "2026-07-29T20:00:00.000Z",
      definition: referenceSiteDefinition,
      inputs: {
        contentHash: "c".repeat(64),
        schemaVersion: referenceSiteDefinition.schemaVersion,
        rendererVersion: "renderer-55",
        productionBase: "a".repeat(40),
      },
    };
    const review = {
      previewId: "preview-mcp-55",
      actorId: "agent-55",
      pages: [],
      changedDocuments: ["Site settings — Site name"],
      designChanges: [],
      publicEffect:
        "Settings that every page shares change. " +
        "This review does not approve or publish anything.",
    };
    mocks.loadIdentity.mockResolvedValue({ identity });
    mocks.authorize.mockResolvedValue({
      state: "authorized",
      identity,
      membership: {
        id: "membership-owner",
        siteId: referenceSiteDefinition.site.id,
      },
    });
    mocks.loadMcpPreview.mockResolvedValue({ revision, review });

    await expect(
      loadRevisionPreview({
        params: Promise.resolve({
          workspaceId: revision.workspaceId,
          revision: String(revision.revision),
        }),
        searchParams: Promise.resolve({
          capability: "short-lived-capability",
          bookmark: revision.bookmark,
          previewId: review.previewId,
        }),
      }),
    ).resolves.toEqual({ ...revision, mcpReview: review });
    expect(mocks.verifyCapability).toHaveBeenCalledWith({
      capability: "short-lived-capability",
      identity,
      workspaceId: revision.workspaceId,
      revision: revision.revision,
    });
    expect(mocks.loadMcpPreview).toHaveBeenCalledWith({
      previewId: review.previewId,
      siteId: referenceSiteDefinition.site.id,
    });
    expect(mocks.loadApplication).not.toHaveBeenCalled();
  });
});

/**
 * The reference definition plus a second page, for proving links between
 * pages inside a preview. Uses the shared two-page fixture from PR #188.
 */
function withSecondPage() {
  const definition = twoPageSiteDefinition;
  return {
    definition,
    home: homePage(definition),
    about: definition.pages[1]!,
  };
}

describe("buildRevisionPreviewLinks", () => {
  const revision = {
    workspaceId: createContentWorkspaceId("workspace_home"),
    revision: 5,
  };
  const searchParams = { capability: "cap-123", bookmark: "bookmark-abc" };

  it("keeps the home preview address unchanged, byte for byte", () => {
    const links = buildRevisionPreviewLinks(revision, searchParams);
    expect(links.previewPath).toBe("/__foundry/preview/workspace_home/5");
    expect(links.homeHref).toBe(
      "/__foundry/preview/workspace_home/5?capability=cap-123&bookmark=bookmark-abc",
    );
    expect(links.blogHref).toBe(`${links.homeHref}#blog_index_title`);
    expect(links.blogPostHref("my-post")).toBe(
      "/__foundry/preview/workspace_home/5/blog/my-post" +
        "?capability=cap-123&bookmark=bookmark-abc",
    );
  });

  it("carries the access token and MCP preview id forward on the home address", () => {
    const links = buildRevisionPreviewLinks(revision, {
      ...searchParams,
      accessToken: "token-xyz",
      previewId: "preview-1",
    });
    expect(links.homeHref).toContain("accessToken=token-xyz");
    expect(links.homeHref).toContain("previewId=preview-1");
    expect(links.accessToken).toBe("token-xyz");
  });

  it("builds another page's preview address under the same revision and query", () => {
    const { about } = withSecondPage();
    const links = buildRevisionPreviewLinks(revision, searchParams);
    expect(links.pageHref(about)).toBe(
      "/__foundry/preview/workspace_home/5/about" +
        "?capability=cap-123&bookmark=bookmark-abc",
    );
  });

  it("resolves a page: link to the target page's preview, not its live public path", () => {
    const { definition, home, about } = withSecondPage();
    const links = buildRevisionPreviewLinks(revision, searchParams);
    const address = resolveSiteHref(definition, `page:${about.id}`, {
      currentPage: home,
      pageHref: links.pageHref,
      blogHref: links.blogHref,
    });
    expect(address).toBe(links.pageHref(about));
    expect(address.startsWith(links.previewPath)).toBe(true);
    expect(address).not.toBe("/about");
  });

  it("leaves a link back to the current page's preview scoped to this revision only", () => {
    const { definition, about } = withSecondPage();
    const links = buildRevisionPreviewLinks(revision, searchParams);
    // A crafted or stale link naming a page id this revision does not have
    // resolves to no address at all, never a guess at another revision's
    // page — resolveSiteHref only ever looks inside the given definition.
    const address = resolveSiteHref(definition, "page:page_from_elsewhere", {
      currentPage: about,
      pageHref: links.pageHref,
      blogHref: links.blogHref,
    });
    expect(address).toBe("");
  });

  it("leaves an external link and a mailto link unchanged", () => {
    const { definition } = withSecondPage();
    const links = buildRevisionPreviewLinks(revision, searchParams);
    const context = {
      currentPage: null,
      pageHref: links.pageHref,
      blogHref: links.blogHref,
    };
    expect(
      resolveSiteHref(definition, "mailto:owner@example.com", context),
    ).toBe("mailto:owner@example.com");
    // `$defs/href` never stores a raw external URL (ADR-0022), but
    // `resolveSiteHref` still must not rewrite one it is defensively given
    // into a preview address — it is not a target the preview understands.
    expect(
      resolveSiteHref(
        definition,
        "https://example.com/offsite" as SiteHref,
        context,
      ),
    ).toBe("https://example.com/offsite");
  });
});
