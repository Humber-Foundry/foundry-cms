import type {
  BlogPostOperationalState,
  RestoredBlogPostDraft,
} from "@humber-foundry/application";

import type { D1ContentRevisionInitializationExtension } from "./d1-content-revision-store";
import type { D1DatabaseBinding } from "./d1-human-access-store";
import { createBlogPostAuditEventId } from "./d1-blog-post-operation-audit";

export function createD1BlogPostRestoreInitializationExtension(input: {
  database: D1DatabaseBinding;
  archivedPost: BlogPostOperationalState;
  actorId: string;
  sourcePostRevisionId: string;
  requestId: string;
}): D1ContentRevisionInitializationExtension {
  return {
    blogPostAdvanceAuthority: "archived-restore",
    prepareStatements({ revision, artifacts }) {
      const artifact = artifacts.find(
        ({ postId }) => postId === input.archivedPost.postId,
      );
      const post = revision.definition.blog.posts.find(
        ({ id }) => id === input.archivedPost.postId,
      );
      if (artifact === undefined || post === undefined) {
        throw new Error("restore_revision_missing");
      }
      const restored: RestoredBlogPostDraft = {
        ...input.archivedPost,
        workspaceId: revision.workspaceId,
        contentRevision: revision.revision,
        postRevision: post.revision,
        postRevisionId: artifact.postRevisionId,
        collectionState: "active",
        workflowState: "editing",
        liveRevisionId: null,
        version: input.archivedPost.version + 1,
        targetVisibility: "unpublished",
        sourcePostRevisionId: input.sourcePostRevisionId,
      };
      const responseJson = JSON.stringify(restored);
      return [
      input.database
        .prepare(
          `UPDATE blog_post_collection_states
           SET collection_state = 'active',
               workflow_state = 'editing',
               version = version + 1,
               updated_at = ?1
           WHERE site_id = ?2 AND post_id = ?3
             AND collection_state = 'archived'
             AND restore_request_id = ?4
             AND restore_selected_post_revision_id = ?5
             AND restore_actor_id = ?6
             AND NOT EXISTS (
               SELECT 1 FROM blog_post_operation_audit_events
               WHERE site_id = ?2
                 AND command_type = 'blog.post.restore'
                 AND request_id = ?4 AND outcome = 'accepted'
             )
             AND EXISTS (
               SELECT 1 FROM blog_posts
               WHERE site_id = ?2 AND post_id = ?3
                 AND current_revision = ?7
                 AND current_revision_id = ?8
             )
             AND EXISTS (
               SELECT 1 FROM human_memberships
               WHERE site_id = ?2 AND id = ?6
                 AND status = 'active'
                 AND role IN ('owner', 'editor')
             )`,
        )
        .bind(
          revision.createdAt,
          input.archivedPost.siteId,
          input.archivedPost.postId,
          input.requestId,
          input.sourcePostRevisionId,
          input.actorId,
          post.revision,
          artifact.postRevisionId,
        ),
      input.database
        .prepare(
          `INSERT INTO blog_post_archive_records (
             site_id, post_id, selected_post_revision_id, actor_id,
             request_id, outcome, publication_id, archive_reason,
             previous_schedule_id, previous_live_revision_id, occurred_at
           )
           SELECT ?1, ?2, ?3, ?4, ?5, 'restored', NULL,
                  archive_reason, previous_schedule_id,
                  previous_live_revision_id, ?6
           FROM blog_post_collection_states
           WHERE site_id = ?1 AND post_id = ?2
             AND collection_state = 'active'
             AND restore_request_id = ?5
           ON CONFLICT (site_id, post_id, request_id, outcome)
           DO NOTHING`,
        )
        .bind(
          input.archivedPost.siteId,
          input.archivedPost.postId,
          input.sourcePostRevisionId,
          input.actorId,
          input.requestId,
          revision.createdAt,
        ),
      input.database
        .prepare(
          `INSERT INTO blog_post_restore_records (
             site_id, post_id, source_post_revision_id,
             restored_workspace_id, restored_content_revision,
             restored_post_revision_id, actor_id, request_id, occurred_at,
             response_json
           )
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
           ON CONFLICT (site_id, post_id, request_id) DO NOTHING`,
        )
        .bind(
          input.archivedPost.siteId,
          input.archivedPost.postId,
          input.sourcePostRevisionId,
          revision.workspaceId,
          revision.revision,
          artifact.postRevisionId,
          input.actorId,
          input.requestId,
          revision.createdAt,
          responseJson,
        ),
      input.database
        .prepare(
          `INSERT INTO blog_post_operation_audit_events (
             event_id, site_id, post_id, actor_id, command_type, request_id,
             outcome, reason_code, before_state_json, after_state_json,
             occurred_at
           )
           VALUES (
             ?1, ?2, ?3, ?4, 'blog.post.restore', ?5,
             'accepted', 'accepted', ?6, ?7, ?8
           )
           ON CONFLICT (site_id, command_type, request_id, outcome)
           DO NOTHING`,
        )
        .bind(
          createBlogPostAuditEventId({
            commandType: "blog.post.restore",
            requestId: input.requestId,
            outcome: "accepted",
          }),
          input.archivedPost.siteId,
          input.archivedPost.postId,
          input.actorId,
          input.requestId,
          JSON.stringify(input.archivedPost),
          responseJson,
          revision.createdAt,
        ),
      ];
    },
  };
}
