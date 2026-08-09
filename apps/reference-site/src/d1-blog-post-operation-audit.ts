import type {
  BlogPostOperationAuditEvent,
} from "@humber-foundry/application";
import type { BlogPostId, SiteId } from "@humber-foundry/site-definition";

import type { D1DatabaseBinding } from "./d1-human-access-store";

export function createBlogPostAuditEventId(input: {
  commandType: string;
  requestId: string;
  outcome: "accepted" | "rejected";
}) {
  const component = (value: string) => `${value.length}:${value}`;
  return `blog-audit-v1|${component(input.commandType)}|${
    component(input.requestId)
  }|${component(input.outcome)}`;
}

export function prepareAcceptedBlogPostAudit(
  database: D1DatabaseBinding,
  event: {
    siteId: SiteId | string;
    postId: BlogPostId | string | null;
    actorId: string;
    commandType: string;
    requestId: string;
    eventId?: string;
    beforeState: unknown;
    afterState: unknown;
    occurredAt: string;
  },
  guardSql = "1",
  guardBindings: ReadonlyArray<unknown> = [],
) {
  return database
    .prepare(
      `INSERT INTO blog_post_operation_audit_events (
         event_id, site_id, post_id, actor_id, command_type, request_id,
         outcome, reason_code, before_state_json, after_state_json,
         occurred_at
       )
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, 'accepted', 'accepted',
              ?7, ?8, ?9
       WHERE ${guardSql}
       ON CONFLICT (site_id, command_type, request_id, outcome)
       DO NOTHING`,
    )
    .bind(
      event.eventId ??
        createBlogPostAuditEventId({
          commandType: event.commandType,
          requestId: event.requestId,
          outcome: "accepted",
        }),
      event.siteId,
      event.postId,
      event.actorId,
      event.commandType,
      event.requestId,
      event.beforeState === null
        ? null
        : JSON.stringify(event.beforeState),
      event.afterState === null
        ? null
        : JSON.stringify(event.afterState),
      event.occurredAt,
      ...guardBindings,
    );
}

export async function recordD1BlogPostAudit(
  database: D1DatabaseBinding,
  event: BlogPostOperationAuditEvent,
) {
  await database
    .prepare(
      `INSERT INTO blog_post_operation_audit_events (
         event_id, site_id, post_id, actor_id, command_type, request_id,
         outcome, reason_code, before_state_json, after_state_json,
         occurred_at
       ) VALUES (
         ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11
       )
       ON CONFLICT (site_id, command_type, request_id, outcome)
       DO NOTHING`,
    )
    .bind(
      createBlogPostAuditEventId(event),
      event.siteId,
      event.postId,
      event.actorId,
      event.commandType,
      event.requestId,
      event.outcome,
      event.reasonCode,
      event.beforeState === null
        ? null
        : JSON.stringify(event.beforeState),
      event.afterState === null
        ? null
        : JSON.stringify(event.afterState),
      event.occurredAt,
    )
    .run();
}
