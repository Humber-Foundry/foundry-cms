import { describe, expect, it } from "vitest";

import {
  applySiteDefinitionEdits,
  createBlogPostId,
  createRichTextDocumentFromPlainText,
  referenceSiteDefinition,
  updateEditableSiteField,
  type BlogPost,
  type SiteDefinition,
} from "./index";
import {
  resolveBlogIndexSeo,
  resolveBlogPostSeo,
  resolveHomeSeo,
  seoKeywordLimit,
  toSeoShareImage,
} from "./seo";

const postId = createBlogPostId("11111111-1111-4111-8111-111111111111");

function buildPost(overrides: Partial<BlogPost> = {}): BlogPost {
  return {
    id: postId,
    revision: 1,
    collectionState: "active",
    targetVisibility: "public",
    slug: "harbour-notes",
    title: "Harbour notes",
    excerpt: "Three things we learned rebuilding the launch page.",
    seo: { title: "", description: "", keywords: [], shareImage: null },
    body: createRichTextDocumentFromPlainText("Body copy."),
    ...overrides,
  };
}

function buildDefinition(
  post: BlogPost,
  canonicalOrigin = "https://example.com",
): SiteDefinition {
  return {
    ...referenceSiteDefinition,
    site: { ...referenceSiteDefinition.site, canonicalOrigin },
    blog: { ...referenceSiteDefinition.blog, posts: [post] },
  };
}

function withHomeHero(definition: SiteDefinition): SiteDefinition {
  return {
    ...definition,
    home: {
      ...definition.home,
      media: [
        {
          occurrenceId: "occurrence_home_hero",
          revision: 1,
          asset: {
            assetId: "asset_home_hero",
            width: 1200,
            height: 630,
            contentType: "image/jpeg",
          },
          crop: null,
        },
      ],
    },
  };
}

describe("resolveBlogPostSeo", () => {
  it("falls back to the post excerpt when the SEO description is blank", () => {
    const post = buildPost();

    const resolved = resolveBlogPostSeo(buildDefinition(post), post);

    expect(resolved.description).toBe(
      "Three things we learned rebuilding the launch page.",
    );
  });

  it("builds the canonical URL from the site origin and the post slug", () => {
    const post = buildPost();

    const resolved = resolveBlogPostSeo(buildDefinition(post), post);

    expect(resolved.canonicalUrl).toBe("https://example.com/blog/harbour-notes");
  });

  it("emits no canonical URL when the site has no canonical origin", () => {
    const post = buildPost();

    const resolved = resolveBlogPostSeo(buildDefinition(post, ""), post);

    expect(resolved.canonicalUrl).toBeNull();
  });

  it("makes a share image path absolute", () => {
    const post = buildPost({
      seo: {
        title: "",
        description: "",
        keywords: [],
        shareImage: { url: "/api/media/asset_notes", alt: "The launch page" },
      },
    });

    const resolved = resolveBlogPostSeo(buildDefinition(post), post);

    expect(resolved.shareImage).toEqual({
      url: "https://example.com/api/media/asset_notes",
      alt: "The launch page",
    });
  });

  it("falls back to the home hero image when the post has no share image", () => {
    const post = buildPost();
    const definition = withHomeHero(buildDefinition(post));

    const resolved = resolveBlogPostSeo(definition, post);

    expect(resolved.shareImage).toEqual({
      url: "https://example.com/api/media/asset_home_hero",
      alt: "",
    });
  });

  it("keeps an absolute share image address unchanged", () => {
    const post = buildPost({
      seo: {
        title: "",
        description: "",
        keywords: [],
        shareImage: { url: "https://cdn.example.net/card.png", alt: "Card" },
      },
    });

    const resolved = resolveBlogPostSeo(buildDefinition(post), post);

    expect(resolved.shareImage?.url).toBe("https://cdn.example.net/card.png");
  });

  it("appends the site name when the SEO title is blank", () => {
    const post = buildPost();

    const resolved = resolveBlogPostSeo(buildDefinition(post), post);

    expect(resolved.title).toBe("Harbour notes — Foundry Reference");
  });

  it("uses the owner's SEO title exactly as written", () => {
    const post = buildPost({
      seo: {
        title: "Three harbour lessons",
        description: "",
        keywords: [],
        shareImage: null,
      },
    });

    const resolved = resolveBlogPostSeo(buildDefinition(post), post);

    expect(resolved.title).toBe("Three harbour lessons");
  });

  it("carries the post keywords through", () => {
    const post = buildPost({
      seo: {
        title: "",
        description: "",
        keywords: ["harbour", "launch"],
        shareImage: null,
      },
    });

    const resolved = resolveBlogPostSeo(buildDefinition(post), post);

    expect(resolved.keywords).toEqual(["harbour", "launch"]);
  });

  it("drops a share image path when the site has no canonical origin", () => {
    const post = buildPost({
      seo: {
        title: "",
        description: "",
        keywords: [],
        shareImage: { url: "/api/media/asset_notes", alt: "" },
      },
    });

    const resolved = resolveBlogPostSeo(buildDefinition(post, ""), post);

    expect(resolved.shareImage).toBeNull();
  });
});

describe("resolveHomeSeo", () => {
  it("falls back to the site name and description", () => {
    const definition = buildDefinition(buildPost());
    const blank = {
      ...definition,
      home: {
        ...definition.home,
        seo: { title: "", description: "", keywords: [], shareImage: null },
      },
    };

    const resolved = resolveHomeSeo(blank);

    expect(resolved.title).toBe("Foundry Reference");
    expect(resolved.description).toBe(definition.site.description);
  });

  it("points the canonical URL at the site root", () => {
    const resolved = resolveHomeSeo(buildDefinition(buildPost()));

    expect(resolved.canonicalUrl).toBe("https://example.com/");
  });

  it("uses the owner's home SEO values when they are filled", () => {
    const definition = buildDefinition(buildPost());

    const resolved = resolveHomeSeo(definition);

    expect(resolved.title).toBe(definition.home.seo.title);
    expect(resolved.description).toBe(definition.home.seo.description);
  });
});

describe("resolveBlogIndexSeo", () => {
  it("names the blog and points the canonical URL at /blog", () => {
    const resolved = resolveBlogIndexSeo(buildDefinition(buildPost()));

    expect(resolved.title).toBe("Blog — Foundry Reference");
    expect(resolved.canonicalUrl).toBe("https://example.com/blog");
  });
});

describe("editing a share image as two fields", () => {
  const homeSeoPath = (part: string) =>
    `${referenceSiteDefinition.home.id}.seo.shareImage.${part}`;

  it("keeps both parts whichever order the owner's edits arrive in", () => {
    const urlThenAlt = applySiteDefinitionEdits(referenceSiteDefinition, [
      { path: homeSeoPath("url"), value: "/api/media/asset_card" },
      { path: homeSeoPath("alt"), value: "A boat at anchor" },
    ]);
    const altThenUrl = applySiteDefinitionEdits(referenceSiteDefinition, [
      { path: homeSeoPath("alt"), value: "A boat at anchor" },
      { path: homeSeoPath("url"), value: "/api/media/asset_card" },
    ]);

    expect(urlThenAlt.ok).toBe(true);
    expect(altThenUrl.ok).toBe(true);
    const expected = { url: "/api/media/asset_card", alt: "A boat at anchor" };
    expect(
      urlThenAlt.ok ? urlThenAlt.definition.home.seo.shareImage : null,
    ).toEqual(expected);
    expect(
      altThenUrl.ok ? altThenUrl.definition.home.seo.shareImage : null,
    ).toEqual(expected);
  });

  it("removes the share image when the address is cleared", () => {
    const added = applySiteDefinitionEdits(referenceSiteDefinition, [
      { path: homeSeoPath("url"), value: "/api/media/asset_card" },
      { path: homeSeoPath("alt"), value: "A boat at anchor" },
    ]);
    expect(added.ok).toBe(true);
    if (!added.ok) return;

    const cleared = applySiteDefinitionEdits(added.definition, [
      { path: homeSeoPath("url"), value: "" },
    ]);

    expect(cleared.ok).toBe(true);
    expect(cleared.ok ? cleared.definition.home.seo.shareImage : "x").toBeNull();
  });

  it("does not save alt text on its own", () => {
    const result = applySiteDefinitionEdits(referenceSiteDefinition, [
      { path: homeSeoPath("alt"), value: "A boat at anchor" },
    ]);

    expect(result.ok).toBe(true);
    expect(result.ok ? result.definition.home.seo.shareImage : "x").toBeNull();
  });
});

describe("editing the canonical origin", () => {
  const path = `${referenceSiteDefinition.site.id}.canonicalOrigin`;

  it("is an editable field the owner can set", () => {
    const result = applySiteDefinitionEdits(referenceSiteDefinition, [
      { path, value: "https://harbour.example" },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.site.canonicalOrigin).toBe(
      "https://harbour.example",
    );
    expect(resolveHomeSeo(result.definition).canonicalUrl).toBe(
      "https://harbour.example/",
    );
  });

  it("may be cleared, which withholds every address", () => {
    const result = applySiteDefinitionEdits(referenceSiteDefinition, [
      { path, value: "" },
    ]);

    expect(result.ok).toBe(true);
    expect(
      result.ok ? resolveHomeSeo(result.definition).canonicalUrl : "x",
    ).toBeNull();
  });

  it("drops a trailing slash so no URL is built with two", () => {
    const result = applySiteDefinitionEdits(referenceSiteDefinition, [
      { path, value: "https://harbour.example/" },
    ]);

    expect(result.ok).toBe(true);
    expect(
      result.ok ? result.definition.site.canonicalOrigin : "x",
    ).toBe("https://harbour.example");
  });

  it("rejects an address that is not a bare origin", () => {
    for (const value of [
      "harbour.example",
      "https://harbour.example/blog",
      "javascript:alert(1)",
    ]) {
      const result = applySiteDefinitionEdits(referenceSiteDefinition, [
        { path, value },
      ]);
      expect(result.ok, value).toBe(false);
    }
  });
});

describe("editing keywords", () => {
  const path = `${referenceSiteDefinition.home.id}.seo.keywords`;

  it("reads a comma-separated list the way an owner types it", () => {
    const result = applySiteDefinitionEdits(referenceSiteDefinition, [
      { path, value: "boats, , boats , harbour" },
    ]);

    expect(result.ok).toBe(true);
    expect(result.ok ? result.definition.home.seo.keywords : []).toEqual([
      "boats",
      "harbour",
    ]);
  });

  it("says how many keywords are allowed instead of a schema complaint", () => {
    const tooMany = Array.from(
      { length: seoKeywordLimit + 1 },
      (_unused, index) => `keyword-${index}`,
    ).join(", ");
    const result = applySiteDefinitionEdits(referenceSiteDefinition, [
      { path, value: tooMany },
    ]);

    expect(result.ok).toBe(false);
    expect(result.ok ? {} : result.errors).toEqual({
      [path]: `Use at most ${seoKeywordLimit} keywords, separated by commas.`,
    });
  });

  it("accepts a list exactly at the limit", () => {
    const atLimit = Array.from(
      { length: seoKeywordLimit },
      (_unused, index) => `keyword-${index}`,
    ).join(", ");

    expect(
      applySiteDefinitionEdits(referenceSiteDefinition, [
        { path, value: atLimit },
      ]).ok,
    ).toBe(true);
  });

  it("refuses a single over-long list through the single-field path", () => {
    const tooMany = Array.from(
      { length: seoKeywordLimit + 1 },
      (_unused, index) => `keyword-${index}`,
    ).join(", ");

    expect(
      updateEditableSiteField(referenceSiteDefinition, {
        path,
        value: tooMany,
      }),
    ).toBeNull();
  });
});

describe("assembling a share image from two boxes", () => {
  it("is no picture when the address is blank, whatever the description says", () => {
    expect(toSeoShareImage("  ", "A harbour")).toBeNull();
  });

  it("trims both parts", () => {
    expect(toSeoShareImage(" /api/media/asset_hero ", " A harbour ")).toEqual({
      url: "/api/media/asset_hero",
      alt: "A harbour",
    });
  });
});
