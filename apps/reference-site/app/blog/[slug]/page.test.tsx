import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPublishedSite: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  notFound() {
    throw new Error("not_found");
  },
}));
vi.mock("@/foundry/site-definition.server", () => ({
  installedSite: {
    application: { queries: { getPublishedSite: mocks.getPublishedSite } },
  },
}));

import {
  createBlogPostId,
  createRichTextDocumentFromPlainText,
  homePage,
  referenceSiteDefinition,
  type SiteDefinition,
  type SiteHref,
  type SitePage,
} from "@humber-foundry/site-definition";

import BlogPostPage, { generateMetadata } from "./page";

/**
 * The reference definition, plus a second page and a navigation link that
 * targets it, plus one published post. The nav link proves this route's
 * `page:` links keep resolving to the live public path — #197 only changes
 * what the blog post *preview* route does with `pageHref`, never this one.
 */
function definitionWithPublishedPost(): SiteDefinition {
  const home = homePage(referenceSiteDefinition);
  const about: SitePage = {
    id: "page_about",
    slug: "about",
    title: "About",
    seo: { title: "", description: "", keywords: [], shareImage: null },
    sections: [],
  };
  const post = {
    id: createBlogPostId("00000000-0000-4000-8000-000000000197"),
    revision: 1,
    collectionState: "active" as const,
    targetVisibility: "public" as const,
    slug: "public-post",
    title: "Public post",
    excerpt: "A published post.",
    seo: {
      title: "Public post | Foundry",
      description: "A published post.",
      keywords: [],
      shareImage: null,
    },
    mainImage: null,
    body: createRichTextDocumentFromPlainText("Published body."),
  };
  return {
    ...referenceSiteDefinition,
    site: {
      ...referenceSiteDefinition.site,
      navigation: [
        ...referenceSiteDefinition.site.navigation,
        {
          id: "nav_about",
          label: "About",
          href: "page:page_about" as SiteHref,
        },
      ],
    },
    pages: [home, about],
    blog: { id: "blog", posts: [post] },
  };
}

describe("public blog post route", () => {
  it("renders a published post with the live public page path, unchanged", async () => {
    mocks.getPublishedSite.mockResolvedValue(definitionWithPublishedPost());

    const markup = renderToStaticMarkup(
      await BlogPostPage({
        params: Promise.resolve({ slug: "public-post" }),
      }),
    );

    expect(markup).toContain("<h1>Public post</h1>");
    expect(markup).toContain("Published body.");
    // The nav link to the second page resolves to its live public path, not
    // a preview address — this route never receives a preview `pageHref`.
    expect(markup).toContain('href="/about"');
    expect(markup).not.toContain("__foundry/preview");
    expect(markup).toContain('href="/blog"');
  });

  it("emits the post's own metadata", async () => {
    mocks.getPublishedSite.mockResolvedValue(definitionWithPublishedPost());

    const metadata = await generateMetadata({
      params: Promise.resolve({ slug: "public-post" }),
    });

    expect(metadata.title).toBe("Public post | Foundry");
  });

  it("shows the not-found state for an unknown slug", async () => {
    mocks.getPublishedSite.mockResolvedValue(definitionWithPublishedPost());

    await expect(
      BlogPostPage({ params: Promise.resolve({ slug: "missing-post" }) }),
    ).rejects.toThrow("not_found");
  });

  it("shows the not-found state for an unpublished post's slug", async () => {
    const definition = definitionWithPublishedPost();
    mocks.getPublishedSite.mockResolvedValue({
      ...definition,
      blog: {
        ...definition.blog,
        posts: definition.blog.posts.map((post) => ({
          ...post,
          targetVisibility: "unpublished" as const,
        })),
      },
    });

    await expect(
      BlogPostPage({ params: Promise.resolve({ slug: "public-post" }) }),
    ).rejects.toThrow("not_found");
  });
});
