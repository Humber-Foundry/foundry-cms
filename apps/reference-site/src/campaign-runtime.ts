import "server-only";

import {
  AccessDeniedError,
  canonicalJson,
  createBlogPostRevisionId,
  createCampaignApplication,
  createInMemoryCampaignStore,
  createInMemorySubscriberLedgerStore,
  createSubscriberLedgerAudienceResolver,
  sha256Text,
  type CampaignApplication,
  type CampaignStore,
} from "@foundry/application";
import {
  upgradeSiteDefinition,
  type BlogPost,
  type SiteId,
} from "@foundry/site-definition";

import { createD1CampaignStore } from "./d1-campaign-store";
import type { D1DatabaseBinding } from "./d1-human-access-store";
import { createD1SubscriberLedgerStore } from "./d1-subscriber-ledger-store";
import {
  loadHumanAccessRequestContext,
} from "./human-access-runtime";
import { loadHumanAccessEnvironment } from "./human-access-environment";
import { referenceSiteApplication } from "./reference-installation";

const localCampaignStore = createInMemoryCampaignStore();
const localSubscriberStore = createInMemorySubscriberLedgerStore();
const rendererVersion = "foundry-campaign-renderer-v1";

async function localPostRevision(
  siteId: SiteId,
  revisionId: string,
): Promise<BlogPost | null> {
  const definition =
    await referenceSiteApplication.queries.getPublishedSite();
  for (const post of definition.blog.posts) {
    const contentHash = await sha256Text(canonicalJson(post));
    const candidate = await createBlogPostRevisionId(
      siteId,
      post.id,
      post.revision,
      contentHash,
    );
    if (candidate === revisionId) return post;
  }
  return null;
}

async function d1PostRevision(
  database: D1DatabaseBinding,
  siteId: SiteId,
  revisionId: string,
): Promise<BlogPost | null> {
  const row = await database
    .prepare(
      `SELECT cr.definition_json, bra.post_id, bra.post_revision
       FROM blog_post_render_artifacts bra
       JOIN content_revisions cr
         ON cr.workspace_id = bra.workspace_id
        AND cr.revision = bra.content_revision
       JOIN content_workspaces cw ON cw.workspace_id = cr.workspace_id
       WHERE cw.site_id = ?1 AND bra.post_revision_id = ?2
       ORDER BY bra.created_at DESC LIMIT 1`,
    )
    .bind(siteId, revisionId)
    .first<{
      definition_json: string;
      post_id: string;
      post_revision: number;
    }>();
  if (row === null) return null;
  const definition = upgradeSiteDefinition(JSON.parse(row.definition_json));
  return definition.blog.posts.find(
    (post) =>
      post.id === row.post_id && post.revision === row.post_revision,
  ) ?? null;
}

export async function loadCampaignRequestContext(
  requestHeaders: Headers,
): Promise<Readonly<{
  identity: Awaited<
    ReturnType<typeof loadHumanAccessRequestContext>
  >["identity"];
  application: CampaignApplication;
}>> {
  const human = await loadHumanAccessRequestContext(requestHeaders);
  if (human.state !== "authorized") {
    throw new AccessDeniedError("capability_not_authorized");
  }
  let store: CampaignStore = localCampaignStore;
  let resolveAudience = createSubscriberLedgerAudienceResolver({
    siteId: referenceSiteApplication.siteId,
    store: localSubscriberStore,
  });
  let findPostRevision = localPostRevision;
  if (process.env.NODE_ENV !== "development") {
    const environment = await loadHumanAccessEnvironment();
    if (environment.FOUNDRY_DB === undefined) {
      throw new Error("campaign_database_unavailable");
    }
    store = createD1CampaignStore(environment.FOUNDRY_DB);
    resolveAudience = createSubscriberLedgerAudienceResolver({
      siteId: referenceSiteApplication.siteId,
      store: createD1SubscriberLedgerStore(environment.FOUNDRY_DB),
    });
    findPostRevision = (siteId, revisionId) =>
      d1PostRevision(environment.FOUNDRY_DB!, siteId, revisionId);
  }
  return {
    identity: human.identity,
    application: createCampaignApplication({
      siteId: referenceSiteApplication.siteId,
      store,
      authorize: (actor, capability) =>
        "binding" in actor
          ? human.application.queries.requireCapability({
              actor,
              capability:
                capability === "campaign.author"
                  ? "content.write"
                  : capability,
            })
          : Promise.reject(
              new AccessDeniedError("capability_not_authorized"),
            ),
      findPostRevision,
      resolveAudience,
      rendererVersion,
      schemaVersion: "1.3.0",
    }),
  };
}
