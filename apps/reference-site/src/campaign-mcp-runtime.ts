import {
  AccessDeniedError,
  createCampaignApplication,
  type CampaignApplication,
  type CampaignAudienceDefinition,
  type CampaignMcpActor,
  type CampaignStore,
} from "@foundry/application";
import type { BlogPost, SiteId } from "@foundry/site-definition";

export function createCampaignMcpRuntime({
  actor,
  scopes,
  store,
  findPostRevision,
  resolveAudience,
  rendererCommit,
}: {
  actor: CampaignMcpActor;
  scopes: ReadonlySet<"content.draft">;
  store: CampaignStore;
  findPostRevision(
    siteId: SiteId,
    revisionId: string,
  ): Promise<BlogPost | null>;
  resolveAudience(
    definition: CampaignAudienceDefinition,
  ): Promise<Readonly<{ eligibleSubscriberCount: number }>>;
  rendererCommit: string;
}): CampaignApplication {
  return createCampaignApplication({
    siteId: actor.siteId,
    store,
    authorize: async (candidate) => {
      if (
        !("type" in candidate) ||
        candidate.type !== "mcp" ||
        candidate.connectionId !== actor.connectionId ||
        candidate.siteId !== actor.siteId ||
        !scopes.has("content.draft")
      ) {
        throw new AccessDeniedError("capability_not_authorized");
      }
      return { id: `mcp:${actor.connectionId}` };
    },
    findPostRevision,
    resolveAudience,
    rendererVersion: rendererCommit,
    schemaVersion: "1.3.0",
  });
}
