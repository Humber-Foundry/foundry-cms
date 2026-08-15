import { describe, expect, it } from "vitest";

import type { ResolvedSeo } from "@humber-foundry/site-definition";

import { publicMetadata } from "./public-metadata";

const resolved: ResolvedSeo = {
  title: "Harbour notes — Foundry Reference",
  description: "Three things we learned rebuilding the launch page.",
  canonicalUrl: "https://example.com/blog/harbour-notes",
  keywords: ["harbour", "launch"],
  shareImage: {
    url: "https://example.com/api/media/asset_notes",
    alt: "The launch page",
  },
};

describe("publicMetadata", () => {
  it("emits the title and description", () => {
    const metadata = publicMetadata(resolved, {
      siteName: "Foundry Reference",
      kind: "article",
    });

    expect(metadata.title).toBe("Harbour notes — Foundry Reference");
    expect(metadata.description).toBe(
      "Three things we learned rebuilding the launch page.",
    );
  });

  it("emits the canonical URL", () => {
    const metadata = publicMetadata(resolved, {
      siteName: "Foundry Reference",
      kind: "article",
    });

    expect(metadata.alternates?.canonical).toBe(
      "https://example.com/blog/harbour-notes",
    );
    expect(metadata.metadataBase?.toString()).toBe("https://example.com/");
  });

  it("emits Open Graph tags that repeat the resolved values", () => {
    const metadata = publicMetadata(resolved, {
      siteName: "Foundry Reference",
      kind: "article",
    });

    expect(metadata.openGraph).toEqual({
      type: "article",
      siteName: "Foundry Reference",
      title: "Harbour notes — Foundry Reference",
      description: "Three things we learned rebuilding the launch page.",
      url: "https://example.com/blog/harbour-notes",
      images: [
        {
          url: "https://example.com/api/media/asset_notes",
          alt: "The launch page",
        },
      ],
    });
  });

  it("asks for a large Twitter card when a share image exists", () => {
    const metadata = publicMetadata(resolved, {
      siteName: "Foundry Reference",
      kind: "article",
    });

    expect(metadata.twitter).toEqual({
      card: "summary_large_image",
      title: "Harbour notes — Foundry Reference",
      description: "Three things we learned rebuilding the launch page.",
      images: [
        {
          url: "https://example.com/api/media/asset_notes",
          alt: "The launch page",
        },
      ],
    });
  });

  it("asks for a plain Twitter card when there is no share image", () => {
    const metadata = publicMetadata(
      { ...resolved, shareImage: null },
      { siteName: "Foundry Reference", kind: "article" },
    );

    expect(metadata.twitter).toEqual({
      card: "summary",
      title: "Harbour notes — Foundry Reference",
      description: "Three things we learned rebuilding the launch page.",
    });
  });

  it("emits the keywords the owner entered", () => {
    const metadata = publicMetadata(resolved, {
      siteName: "Foundry Reference",
      kind: "article",
    });

    expect(metadata.keywords).toEqual(["harbour", "launch"]);
  });

  it("omits keywords when the owner entered none", () => {
    const metadata = publicMetadata(
      { ...resolved, keywords: [] },
      { siteName: "Foundry Reference", kind: "website" },
    );

    expect(metadata.keywords).toBeUndefined();
  });

  it("omits every address when the site has no canonical origin", () => {
    const metadata = publicMetadata(
      { ...resolved, canonicalUrl: null, shareImage: null },
      { siteName: "Foundry Reference", kind: "website" },
    );

    expect(metadata.metadataBase).toBeUndefined();
    expect(metadata.alternates).toBeUndefined();
    expect(metadata.openGraph).toEqual({
      type: "website",
      siteName: "Foundry Reference",
      title: "Harbour notes — Foundry Reference",
      description: "Three things we learned rebuilding the launch page.",
    });
  });
});
