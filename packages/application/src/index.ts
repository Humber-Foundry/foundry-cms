import type { SiteDefinition, SiteId } from "@foundry/site-definition";

export * from "./human-access";
export { isValidGitBranchName } from "./git-branch-name.mjs";
export * from "./in-memory-human-access-store";
export * from "./subscriber-ledger";
export * from "./in-memory-subscriber-ledger-store";
export * from "./public-form";
export * from "./content-revisions";
export * from "./content-publication";
export * from "./public-form-notification";
export * from "./public-form-privacy";

export interface PublishedSiteRepository {
  findBySiteId(siteId: SiteId): Promise<SiteDefinition | null>;
}

export type PublishedSiteQueries = Readonly<{
  getPublishedSite(): Promise<SiteDefinition>;
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
      const definition = await publishedSites.findBySiteId(siteId);

      if (definition === null) {
        throw new SiteNotFoundError(siteId);
      }

      return definition;
    },
  });

  return Object.freeze({
    siteId,
    queries,
  });
}

export function createInMemoryPublishedSiteRepository(
  definitions: ReadonlyArray<SiteDefinition>,
): PublishedSiteRepository {
  const definitionsBySite = new Map(
    definitions.map((definition) => [definition.site.id, definition]),
  );

  return Object.freeze({
    async findBySiteId(siteId: SiteId) {
      return definitionsBySite.get(siteId) ?? null;
    },
  });
}
