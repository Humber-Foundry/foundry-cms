import "server-only";

import {
  createCanonicalPreviewArtifactHash,
  createContentActorId,
  createContentChangeSummary,
  createContentWorkspaceId,
} from "@humber-foundry/application";
import type { SiteId } from "@humber-foundry/site-definition";

import { loadContentRevisionApplication } from "./content-revision-runtime";
import { loadHumanAccessEnvironment } from "./human-access-environment";

export async function loadMcpPreviewForHuman(input: {
  previewId: string;
  siteId: SiteId;
}) {
  if (input.previewId.length < 1 || input.previewId.length > 200) return null;
  const environment = await loadHumanAccessEnvironment();
  if (environment.FOUNDRY_DB === undefined) return null;
  const row = await environment.FOUNDRY_DB
    .prepare(
      `SELECT actor_id, workspace_id, revision, artifact_hash
       FROM mcp_preview_artifacts
       WHERE preview_id = ?1 AND site_id = ?2`,
    )
    .bind(input.previewId, input.siteId)
    .first<{
      actor_id: string;
      workspace_id: string;
      revision: number;
      artifact_hash: string;
    }>();
  if (row === null) return null;
  const actorId = createContentActorId(`mcp-${row.actor_id}`);
  const workspaceId = createContentWorkspaceId(row.workspace_id);
  const application = await loadContentRevisionApplication(
    workspaceId,
    actorId,
  );
  const revision = await application.queries.getRevisionWithBookmark(
    row.revision,
  );
  if (
    revision === null ||
    !(await application.queries.isRevisionCurrent(revision)) ||
    (await createCanonicalPreviewArtifactHash(revision)) !== row.artifact_hash
  ) {
    return null;
  }
  const base = await application.queries.getRevision(0);
  if (base === null) return null;
  const summary = createContentChangeSummary({
    base: base.definition,
    draft: revision.definition,
  });
  return {
    revision,
    review: {
      previewId: input.previewId,
      actorId: row.actor_id,
      ...summary,
    },
  };
}
