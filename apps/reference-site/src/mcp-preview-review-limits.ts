/**
 * Pieces of the draft-review feature that more than one file needs.
 *
 * They live apart from `mcp-preview-review-runtime.ts` because that file is
 * server-only: the review screen's controls run in the browser, and a database
 * test needs the Overview statement without pulling the runtime in.
 */

/** The longest reason a person may type when they ask for changes. */
export const previewChangeReasonLimit = 1000;

/**
 * Previews for one site that nobody has answered yet, newest first.
 *
 * It names only previews whose workspace still sits at the revision the
 * preview was made from. `?1` is the site, `?2` the row limit.
 */
export const previewsWaitingForReviewQuery =
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
   LIMIT ?2`;
