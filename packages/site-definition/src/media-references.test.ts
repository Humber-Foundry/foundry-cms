import { describe, expect, it } from "vitest";

import {
  RICH_TEXT_VERSION,
  createBlogPostId,
  referenceSiteDefinition,
  type BlogPost,
  type SiteDefinition,
} from "./index";
import {
  mediaAssetIdFromPublishedPath,
  mediaImageSrc,
  resolveMediaImageSrc,
  siteDefinitionMediaAssetIds,
} from "./media-references";

function withSections(
  sections: SiteDefinition["home"]["sections"],
): SiteDefinition {
  return {
    ...referenceSiteDefinition,
    home: { ...referenceSiteDefinition.home, sections },
  };
}

function postWithImages(
  overrides: Partial<BlogPost> = {},
): BlogPost {
  return {
    id: createBlogPostId("11111111-1111-4111-8111-111111111111"),
    revision: 1,
    collectionState: "active",
    targetVisibility: "public",
    slug: "images",
    title: "Images",
    excerpt: "A post with photos.",
    seo: {
      title: "",
      description: "",
      keywords: [],
      shareImage: { url: "/api/media/asset_thumbnail", alt: "Card" },
    },
    mainImage: { url: "/api/media/asset_main", alt: "Header" },
    body: {
      version: RICH_TEXT_VERSION,
      type: "document",
      children: [
        { type: "image", src: "/api/media/asset_inline", alt: "In body" },
      ],
    },
    ...overrides,
  };
}

function withPosts(posts: ReadonlyArray<BlogPost>): SiteDefinition {
  return {
    ...referenceSiteDefinition,
    blog: { ...referenceSiteDefinition.blog, posts },
  };
}

describe("mediaAssetIdFromPublishedPath", () => {
  it("reads the asset id from a published media path", () => {
    expect(mediaAssetIdFromPublishedPath("/api/media/asset_photo_1")).toBe(
      "asset_photo_1",
    );
  });

  it("decodes a percent-encoded asset id", () => {
    expect(
      mediaAssetIdFromPublishedPath(
        `/api/media/${encodeURIComponent("asset id")}`,
      ),
    ).toBe("asset id");
  });

  it("returns null for a static path or external URL", () => {
    expect(mediaAssetIdFromPublishedPath("/foundry-workshop.svg")).toBeNull();
    expect(
      mediaAssetIdFromPublishedPath("https://example.com/a.png"),
    ).toBeNull();
    expect(mediaAssetIdFromPublishedPath("/api/media/a/b")).toBeNull();
  });
});

describe("mediaImageSrc", () => {
  it("stores a chosen gallery photo as its published media path", () => {
    expect(mediaImageSrc("asset_photo_1")).toBe("/api/media/asset_photo_1");
  });

  it("round-trips through mediaAssetIdFromPublishedPath", () => {
    expect(mediaAssetIdFromPublishedPath(mediaImageSrc("asset_photo_1"))).toBe(
      "asset_photo_1",
    );
  });
});

describe("siteDefinitionMediaAssetIds", () => {
  it("collects placed occurrence assets", () => {
    const definition: SiteDefinition = {
      ...referenceSiteDefinition,
      home: {
        ...referenceSiteDefinition.home,
        media: [
          {
            occurrenceId: "occurrence_home_hero",
            revision: 1,
            asset: {
              assetId: "asset_hero",
              width: 1200,
              height: 630,
              contentType: "image/jpeg",
            },
            crop: null,
          },
        ],
      },
    };
    expect([...siteDefinitionMediaAssetIds(definition)]).toContain("asset_hero");
  });

  it("collects assets referenced by page-component image fields", () => {
    const definition = withSections([
      {
        id: "section_story",
        type: "registered",
        component: "imageCopyStory",
        props: {
          eyebrow: "Eyebrow",
          title: "Title",
          body: "Body",
          imageSrc: "/api/media/asset_story_photo",
          imageAlt: "Alt",
          imagePosition: "start",
        },
      },
    ]);
    expect([...siteDefinitionMediaAssetIds(definition)]).toContain(
      "asset_story_photo",
    );
  });

  it("ignores static image paths", () => {
    const definition = withSections([
      {
        id: "section_story",
        type: "registered",
        component: "photoBand",
        props: {
          imageSrc: "/foundry-gathering.svg",
          imageAlt: "Alt",
          caption: "Caption",
        },
      },
    ]);
    expect(siteDefinitionMediaAssetIds(definition).size).toBe(0);
  });

  it("collects a published post's main image, thumbnail and inline images", () => {
    const ids = [...siteDefinitionMediaAssetIds(withPosts([postWithImages()]))];
    expect(ids).toContain("asset_main");
    expect(ids).toContain("asset_thumbnail");
    expect(ids).toContain("asset_inline");
  });

  it("does not serve an unpublished post's photos", () => {
    const ids = siteDefinitionMediaAssetIds(
      withPosts([postWithImages({ targetVisibility: "unpublished" })]),
    );
    expect(ids.has("asset_main")).toBe(false);
    expect(ids.has("asset_thumbnail")).toBe(false);
    expect(ids.has("asset_inline")).toBe(false);
  });
});

describe("resolveMediaImageSrc", () => {
  it("returns a static path unchanged for both deliveries", () => {
    expect(resolveMediaImageSrc("/foundry-workshop.svg", "published")).toBe(
      "/foundry-workshop.svg",
    );
    expect(
      resolveMediaImageSrc("/foundry-workshop.svg", "authenticated", "token"),
    ).toBe("/foundry-workshop.svg");
  });

  it("serves a gallery asset from the public route when published", () => {
    expect(resolveMediaImageSrc("/api/media/asset_1", "published")).toBe(
      "/api/media/asset_1",
    );
  });

  it("serves a gallery asset from the authenticated route while editing", () => {
    expect(
      resolveMediaImageSrc("/api/media/asset_1", "authenticated", "cap-token"),
    ).toBe("/api/foundry-cms/media?assetId=asset_1&accessToken=cap-token");
  });

  it("emits an empty access token when none is supplied", () => {
    expect(resolveMediaImageSrc("/api/media/asset_1", "authenticated")).toBe(
      "/api/foundry-cms/media?assetId=asset_1&accessToken=",
    );
  });
});
