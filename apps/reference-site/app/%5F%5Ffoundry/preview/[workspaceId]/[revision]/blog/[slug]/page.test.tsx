import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { createContentWorkspaceId } from "@humber-foundry/application";
import {
  createBlogPostId,
  createRichTextDocumentFromPlainText,
  type SiteDefinition,
  type SiteHref,
} from "@humber-foundry/site-definition";

import { twoPageSiteDefinition } from "@/src/test-support/two-page-site-definition";

const mocks = vi.hoisted(() => ({
  loadRevisionPreview: vi.fn(),
}));

// See the home preview route's test for why "server-only" and React's
// `cache` need mocking even though this test never runs the real
// `loadRevisionPreview`.
vi.mock("server-only", () => ({}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    cache<T extends (...args: never[]) => unknown>(callback: T): T {
      return callback as T;
    },
  };
});
vi.mock("next/navigation", () => ({
  notFound() {
    throw new Error("not_found");
  },
}));
vi.mock("@/src/revision-preview-page", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/src/revision-preview-page")>();
  return { ...actual, loadRevisionPreview: mocks.loadRevisionPreview };
});

import BlogPostPreviewPage, { generateMetadata } from "./page";

const postId = createBlogPostId("00000000-0000-4000-8000-000000000198");

/**
 * A revision with a second page, a navigation item that links to it, a
 * navigation item that is a `mailto:` address, and one blog post.
 */
function previewRevision(): {
  workspaceId: ReturnType<typeof createContentWorkspaceId>;
  revision: number;
  createdAt: string;
  definition: SiteDefinition;
  inputs: {
    contentHash: string;
    schemaVersion: string;
    rendererVersion: string;
    productionBase: string;
  };
} {
  const definition: SiteDefinition = {
    ...twoPageSiteDefinition,
    site: {
      ...twoPageSiteDefinition.site,
      navigation: [
        ...twoPageSiteDefinition.site.navigation,
        {
          id: "nav_about",
          label: "About",
          href: "page:page_about" as SiteHref,
        },
        {
          id: "nav_contact_email",
          label: "Email us",
          href: "mailto:hello@example.com" as SiteHref,
        },
      ],
    },
    blog: {
      id: "blog",
      posts: [
        {
          id: postId,
          revision: 1,
          collectionState: "active",
          targetVisibility: "public",
          slug: "preview-post",
          title: "Preview post",
          excerpt: "A post viewed inside the revision preview.",
          seo: {
            title: "Preview post | Foundry",
            description: "A post viewed inside the revision preview.",
            keywords: [],
            shareImage: null,
          },
          mainImage: null,
          body: createRichTextDocumentFromPlainText("Preview post body."),
        },
      ],
    },
  };
  return {
    workspaceId: createContentWorkspaceId("workspace_blog_197"),
    revision: 11,
    createdAt: "2026-09-19T00:00:00.000Z",
    definition,
    inputs: {
      contentHash: "a".repeat(64),
      schemaVersion: definition.schemaVersion,
      rendererVersion: "renderer-197",
      productionBase: "b".repeat(40),
    },
  };
}

function propsFor(slug: string) {
  return {
    params: Promise.resolve({
      workspaceId: "workspace_blog_197",
      revision: "11",
      slug,
    }),
    searchParams: Promise.resolve({
      capability: "cap-197",
      bookmark: "bookmark-197",
    }),
  };
}

describe("blog post revision preview route", () => {
  it("loads the revision, finds the post, and keeps a page link inside the same preview", async () => {
    mocks.loadRevisionPreview.mockResolvedValue(previewRevision());

    const markup = renderToStaticMarkup(
      await BlogPostPreviewPage(propsFor("preview-post")),
    );

    expect(markup).toContain("<h1>Preview post</h1>");
    expect(markup).toContain("Preview post body.");
    // The regression this ticket fixes: a page: link inside a blog post
    // preview used to render the live public path (`/about`) because
    // BlogPostRenderer never received the preview's pageHref builder. It
    // must now stay inside this exact revision's preview.
    expect(markup).toContain(
      'href="/__foundry/preview/workspace_blog_197/11/about' +
        '?capability=cap-197&amp;bookmark=bookmark-197"',
    );
    expect(markup).not.toContain('href="/about"');
  });

  it("leaves the Blog link inside the preview and never carries the capability off-site", async () => {
    mocks.loadRevisionPreview.mockResolvedValue(previewRevision());

    const markup = renderToStaticMarkup(
      await BlogPostPreviewPage(propsFor("preview-post")),
    );

    expect(markup).toContain(
      'href="/__foundry/preview/workspace_blog_197/11' +
        '?capability=cap-197&amp;bookmark=bookmark-197#blog_index_title"',
    );
    expect(markup).not.toContain('href="/blog"');
  });

  it("leaves a mailto link unchanged, carrying no preview capability or bookmark", async () => {
    mocks.loadRevisionPreview.mockResolvedValue(previewRevision());

    const markup = renderToStaticMarkup(
      await BlogPostPreviewPage(propsFor("preview-post")),
    );

    expect(markup).toContain('href="mailto:hello@example.com"');
    expect(markup).not.toContain("mailto:hello@example.com?");
    expect(markup).not.toContain("mailto:hello@example.com%3Fcapability");
  });

  it("emits the post's own metadata", async () => {
    mocks.loadRevisionPreview.mockResolvedValue(previewRevision());

    const metadata = await generateMetadata(propsFor("preview-post"));

    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(metadata.title).toBe("Preview post | Foundry");
  });

  it("shows the preview's not-found state for an unknown slug", async () => {
    mocks.loadRevisionPreview.mockResolvedValue(previewRevision());

    await expect(
      BlogPostPreviewPage(propsFor("missing-post")),
    ).rejects.toThrow("not_found");
  });
});
