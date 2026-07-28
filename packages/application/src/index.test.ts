import { describe, expect, it } from "vitest";

import {
  createSiteId,
  referenceSiteDefinition,
} from "@foundry/site-definition";

import {
  SiteNotFoundError,
  createInMemoryPublishedSiteRepository,
  createPublishedSiteBundle,
  createSiteApplication,
} from "./index";

describe("site-scoped published-site query", () => {
  it("returns the published definition for the application's site only", async () => {
    const application = createSiteApplication({
      siteId: referenceSiteDefinition.site.id,
      publishedSites: createInMemoryPublishedSiteRepository([
        createPublishedSiteBundle(referenceSiteDefinition),
      ]),
    });

    await expect(application.queries.getPublishedSite()).resolves.toEqual(
      referenceSiteDefinition,
    );
    expect(application.siteId).toBe(referenceSiteDefinition.site.id);
    expect(application.queries.getPublishedSite).toHaveLength(0);
  });

  it("fails closed when the scoped site does not exist", async () => {
    const application = createSiteApplication({
      siteId: createSiteId("site_missing"),
      publishedSites: createInMemoryPublishedSiteRepository([]),
    });

    await expect(application.queries.getPublishedSite()).rejects.toEqual(
      new SiteNotFoundError(createSiteId("site_missing")),
    );
  });

  it("carries deterministic Markdown in the published site bundle", async () => {
    const application = createSiteApplication({
      siteId: referenceSiteDefinition.site.id,
      publishedSites: createInMemoryPublishedSiteRepository([
        createPublishedSiteBundle(referenceSiteDefinition),
      ]),
    });

    await expect(
      application.queries.getPublishedRichTextArtifacts(),
    ).resolves.toEqual([
      expect.objectContaining({
        filePath: "content/rich-text/section_contact/body.md",
        markdown: expect.stringContaining("Bring the rough notes"),
      }),
    ]);
  });
});
