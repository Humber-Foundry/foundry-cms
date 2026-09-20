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
import { mcpConnectionDisplayName } from "./mcp-connection-display";

export { previewChangeReasonLimit } from "./mcp-preview-review-limits";

/** Shown when the connection record no longer names the client. */
const unnamedAgent = "A connected app";

export type McpPreviewReviewDecision = Readonly<{
  decision: "approved" | "changes_requested";
  approvalId: string | null;
  reason: string | null;
  decidedAt: string;
}>;

export type McpPreviewWaitingForReview = Readonly<{
  previewId: string;
  agentName: string;
  preparedAt: string;
}>;

type PreviewRow = {
  actor_id: string;
  workspace_id: string;
  revision: number;
  artifact_hash: string;
  created_at?: string | null;
  oauth_client_id?: string | null;
  decision?: "approved" | "changes_requested" | null;
  approval_id?: string | null;
  reason?: string | null;
  decided_at?: string | null;
};

/**
 * A name for the connected app, taken from the web address it gave when it
 * connected. The app chose that address itself, so the name is the app's own
 * claim and never a verified identity. Every screen that shows it must say so.
 */
function claimedAgentName(clientId: string | null | undefined) {
  return clientId === null || clientId === undefined || clientId === ""
    ? unnamedAgent
    : mcpConnectionDisplayName(clientId);
}

function decisionOf(row: PreviewRow): McpPreviewReviewDecision | null {
  if (
    row.decision === undefined ||
    row.decision === null ||
    row.decided_at === undefined ||
    row.decided_at === null
  ) {
    return null;
  }
  return {
    decision: row.decision,
    approvalId: row.approval_id ?? null,
    reason: row.reason ?? null,
    decidedAt: row.decided_at,
  };
}

/**
 * The exact preview a person was asked to review, with the change summary,
 * who prepared it and any decision already recorded against it.
 *
 * It returns `null` unless the stored revision is still the current one and
 * still hashes to the artifact the agent prepared. A person can only approve
 * what the preview route will still render.
 */
export async function loadMcpPreviewForHuman(input: {
  previewId: string;
  siteId: SiteId;
}) {
  if (input.previewId.length < 1 || input.previewId.length > 200) return null;
  const environment = await loadHumanAccessEnvironment();
  if (environment.FOUNDRY_DB === undefined) return null;
  const row = await environment.FOUNDRY_DB
    .prepare(
      `SELECT artifact.actor_id, artifact.workspace_id, artifact.revision,
              artifact.artifact_hash, artifact.created_at,
              connection.oauth_client_id,
              review.decision, review.approval_id, review.reason,
              review.decided_at
       FROM mcp_preview_artifacts AS artifact
       LEFT JOIN mcp_connections AS connection
         ON connection.id = artifact.connection_id
       LEFT JOIN mcp_preview_reviews AS review
         ON review.preview_id = artifact.preview_id
       WHERE artifact.preview_id = ?1 AND artifact.site_id = ?2`,
    )
    .bind(input.previewId, input.siteId)
    .first<PreviewRow>();
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
      agentName: claimedAgentName(row.oauth_client_id),
      preparedAt: row.created_at ?? revision.createdAt,
      decided: decisionOf(row),
      ...summary,
    },
  };
}

/**
 * Store one person's decision about one preview.
 *
 * The row is written once. A second decision on the same preview fails,
 * because the table's primary key is the preview and its rows never change.
 */
export async function recordPreviewReviewDecision(input: {
  previewId: string;
  siteId: SiteId;
  workspaceId: string;
  revision: number;
  decision: "approved" | "changes_requested";
  approvalId: string | null;
  reason: string | null;
  decidedBy: string;
  decidedAt: string;
}): Promise<boolean> {
  const environment = await loadHumanAccessEnvironment();
  if (environment.FOUNDRY_DB === undefined) return false;
  const result = await environment.FOUNDRY_DB
    .prepare(
      `INSERT INTO mcp_preview_reviews (
         preview_id, site_id, workspace_id, revision, decision,
         approval_id, reason, decided_by, decided_at
       )
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
       ON CONFLICT (preview_id) DO NOTHING`,
    )
    .bind(
      input.previewId,
      input.siteId,
      input.workspaceId,
      input.revision,
      input.decision,
      input.approvalId,
      input.reason,
      input.decidedBy,
      input.decidedAt,
    )
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

/**
 * Previews an agent prepared that nobody has decided about yet.
 *
 * The list stays cheap for the Overview screen: it names only previews whose
 * workspace still sits at the revision the preview was made from.
 */
export async function loadPreviewsWaitingForReview(input: {
  siteId: SiteId;
  limit?: number;
}): Promise<ReadonlyArray<McpPreviewWaitingForReview>> {
  const environment = await loadHumanAccessEnvironment();
  if (environment.FOUNDRY_DB === undefined) return [];
  const result = await environment.FOUNDRY_DB
    .prepare(
      `SELECT artifact.preview_id, artifact.created_at,
              connection.oauth_client_id
       FROM mcp_preview_artifacts AS artifact
       JOIN content_workspaces AS workspace
         ON workspace.workspace_id = artifact.workspace_id
        AND workspace.current_revision = artifact.revision
        AND workspace.lifecycle = 'open'
       LEFT JOIN mcp_connections AS connection
         ON connection.id = artifact.connection_id
       LEFT JOIN mcp_preview_reviews AS review
         ON review.preview_id = artifact.preview_id
       WHERE artifact.site_id = ?1 AND review.preview_id IS NULL
       ORDER BY artifact.created_at DESC
       LIMIT ?2`,
    )
    .bind(input.siteId, input.limit ?? 20)
    .all<{
      preview_id: string;
      created_at: string;
      oauth_client_id: string | null;
    }>();
  return (result.results ?? []).map((row) => ({
    previewId: row.preview_id,
    agentName: claimedAgentName(row.oauth_client_id),
    preparedAt: row.created_at,
  }));
}
