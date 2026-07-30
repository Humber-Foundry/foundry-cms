import {
  serializeSiteDefinitionRichTextForPublication,
  type PublishedRichTextArtifact,
  type SiteDefinition,
  type SiteId,
} from "@foundry/site-definition";

export * from "./human-access";
export { isValidGitBranchName } from "./git-branch-name.mjs";
export * from "./in-memory-human-access-store";
export * from "./subscriber-ledger";
export * from "./in-memory-subscriber-ledger-store";
export * from "./campaign";
export * from "./campaign-bulk-delivery";
export * from "./in-memory-campaign-bulk-state-store";
export * from "./in-memory-campaign-store";
export * from "./public-form";
export * from "./content-revisions";
export * from "./deterministic-hash";
export * from "./blog-artifacts";
export * from "./blog-post-operations";
export * from "./content-publication";
export * from "./public-form-notification";
export * from "./public-form-privacy";
export * from "./media-assets";
export * from "./in-memory-media-assets";
export * from "./mcp-read";
export * from "./mcp-drafts";

export interface PublishedSiteRepository {
  findBySiteId(siteId: SiteId): Promise<PublishedSiteBundle | null>;
}

export type PublishedSiteBundle = Readonly<{
  definition: SiteDefinition;
  richTextArtifacts: ReadonlyArray<PublishedRichTextArtifact>;
}>;

export type PublishedSiteQueries = Readonly<{
  getPublishedSite(): Promise<SiteDefinition>;
  getPublishedRichTextArtifacts(): Promise<
    ReadonlyArray<PublishedRichTextArtifact>
  >;
}>;

export type SiteApplication = Readonly<{
  siteId: SiteId;
  queries: PublishedSiteQueries;
}>;

export class SiteNotFoundError extends Error {
  readonly siteId: SiteId;

  constructor(siteId: SiteId) {
    super(`No published Site Definition exists for site "${siteId}".`);
    this.name = "SiteNotFoundError";
    this.siteId = siteId;
  }
}

export function createSiteApplication({
  siteId,
  publishedSites,
}: {
  siteId: SiteId;
  publishedSites: PublishedSiteRepository;
}): SiteApplication {
  const queries: PublishedSiteQueries = Object.freeze({
    async getPublishedSite() {
      const published = await publishedSites.findBySiteId(siteId);

      if (published === null) {
        throw new SiteNotFoundError(siteId);
      }

      return published.definition;
    },
    async getPublishedRichTextArtifacts() {
      const published = await publishedSites.findBySiteId(siteId);

      if (published === null) {
        throw new SiteNotFoundError(siteId);
      }

      return published.richTextArtifacts;
    },
  });

  return Object.freeze({
    siteId,
    queries,
  });
}

export function createInMemoryPublishedSiteRepository(
  bundles: ReadonlyArray<PublishedSiteBundle>,
): PublishedSiteRepository {
  const definitionsBySite = new Map(
    bundles.map((bundle) => [bundle.definition.site.id, bundle]),
  );

  return Object.freeze({
    async findBySiteId(siteId: SiteId) {
      return definitionsBySite.get(siteId) ?? null;
    },
  });
}

export function createPublishedSiteBundle(
  definition: SiteDefinition,
): PublishedSiteBundle {
  return Object.freeze({
    definition,
    richTextArtifacts:
      serializeSiteDefinitionRichTextForPublication(definition),
  });
}
