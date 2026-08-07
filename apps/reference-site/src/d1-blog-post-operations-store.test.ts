import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createBlogPostOperationsApplication,
  createContentActorId,
  createContentApprovalFingerprint,
  createContentApprovalId,
  createContentPublicationApplication,
  createContentPublicationId,
  createContentRevisionApplication,
  createContentWorkspaceId,
  createHumanMembershipId,
  type ContentPublisher,
} from "@foundry/application";
import {
  createBlogPostId,
  createRichTextDocumentFromPlainText,
  createSiteId,
  referenceSiteDefinition,
} from "@foundry/site-definition";

import { createD1BlogPostOperationsStore } from "./d1-blog-post-operations-store";
import {
  createBlogPostAuditEventId,
} from "./d1-blog-post-operation-audit";
import {
  archiveBlogPostWithWithdrawal,
  recoverArchiveBlogPostWithdrawalAccess,
  restoreArchivedBlogPostAsDraft,
} from "./blog-post-operations-runtime";
import { createD1ContentPublicationStore } from "./d1-content-publication-store";
import {
  createD1ContentRevisionStore,
  findContentRevision,
  hydrateManagedBlogPosts,
} from "./d1-content-revision-store";
import {
  type TestD1Database,
  useMigratedTestDatabase,
} from "./test-support/migrated-test-database";

vi.mock("server-only", () => ({}));

describe("D1 blog post operations store", () => {
  const actorId = createContentActorId("membership-editor");
  const membershipId = createHumanMembershipId("membership-editor");
  const workspaceId = createContentWorkspaceId("workspace_scheduled_blog");
  const postId = createBlogPostId(
    "00000000-0000-4000-8000-000000000045",
  );
  const now = "2026-11-01T08:00:00.000Z";
  const beforeNow = "2026-11-01T07:59:59.000Z";
  let operationTime = beforeNow;
  let database: TestD1Database;
  let revisionApplication: ReturnType<
    typeof createContentRevisionApplication
  >;

  const testDatabase = useMigratedTestDatabase(
    [
      "0001_human_access.sql",
      "0005_content_revisions.sql",
      "0007_content_publication.sql",
      "0008_media_assets.sql",
      "0009_content_publication_history_evidence.sql",
      "0010_content_publication_restore_identity.sql",
      "0011_blog_post_transition_audit.sql",
      "0012_content_approval_revision_hash.sql",
      "0013_blog_post_verified_state.sql",
      "0014_blog_post_artifact_fingerprints.sql",
      "0015_blog_post_render_artifacts.sql",
      "0017_mcp_readonly_connections.sql",
      "0018_mcp_draft_scopes.sql",
      "0019_mcp_preview_artifacts.sql",
      "0020_mcp_mutation_receipts.sql",
      "0022_blog_post_scheduling_archive.sql",
      "0024_mcp_publication_scopes.sql",
    ],
    { compatibilityDate: "2026-07-26" },
  );

  beforeEach(async () => {
    operationTime = beforeNow;
    database = testDatabase.database;
    await database.batch([
      database
        .prepare(
          `INSERT INTO human_users (id, email, created_at)
           VALUES ('user-editor', 'editor@example.com', ?1)`,
        )
        .bind(beforeNow),
      database
        .prepare(
          `INSERT INTO human_external_identities (
             site_id, issuer, subject, user_id, created_at
           ) VALUES (?1, 'https://access.example.com', 'editor',
                     'user-editor', ?2)`,
        )
        .bind(referenceSiteDefinition.site.id, beforeNow),
      database
        .prepare(
          `INSERT INTO human_memberships (
             id, site_id, user_id, email, identity_issuer,
             identity_subject, role, status, created_at, updated_at
           ) VALUES (
             ?1, ?2, 'user-editor', 'editor@example.com',
             'https://access.example.com', 'editor', 'editor', 'active',
             ?3, ?3
           )`,
        )
        .bind(actorId, referenceSiteDefinition.site.id, beforeNow),
    ]);
    revisionApplication = createContentRevisionApplication({
      siteDefinition: referenceSiteDefinition,
      store: createD1ContentRevisionStore(
        database,
        referenceSiteDefinition.site.id,
        workspaceId,
      ),
      workspaceId,
      actorId,
      rendererVersion: "renderer-v1",
      productionBase:
        `git:${"a".repeat(40)}@content:${"b".repeat(64)}`,
      now: () => operationTime,
    });
    await revisionApplication.commands.create({
      actorId,
      workspaceId,
      idempotencyKey: "create-scheduled-workspace",
    });
    await revisionApplication.commands.createBlogPost({
      actorId,
      workspaceId,
      siteId: referenceSiteDefinition.site.id,
      schemaVersion: referenceSiteDefinition.schemaVersion,
      baseRevision: 0,
      post: {
        id: postId,
        slug: "scheduled-post",
        title: "Scheduled post",
        excerpt: "A durable scheduled post.",
        seo: {
          title: "Scheduled post | Foundry",
          description: "A durable scheduled post.",
        },
        body: createRichTextDocumentFromPlainText("Scheduled body."),
      },
      idempotencyKey: "create-scheduled-blog-post",
    });
  });

  async function approveCurrent() {
    const revision = await revisionApplication.queries.getCurrent();
    const approval = {
      id: createContentApprovalId(`approval_${"4".repeat(32)}`),
      workspaceId,
      revision: revision.revision,
      fingerprint: await createContentApprovalFingerprint(
        revision,
        "channel-a",
      ),
      approvedBy: membershipId,
      approvedAt: now,
      invalidatedAt: null,
    };
    await createD1ContentPublicationStore(database).saveApproval(approval);
    return approval;
  }

  it("scopes deterministic audit event identifiers to each site", async () => {
    const store = createD1BlogPostOperationsStore(database);
    const sharedEvent = {
      postId: null,
      actorId,
      commandType: "blog.post.command.unknown",
      requestId: "same-request-across-sites",
      outcome: "rejected" as const,
      reasonCode: "unsupported_operation",
      beforeState: null,
      afterState: null,
      occurredAt: now,
    };

    await store.recordAudit({
      ...sharedEvent,
      siteId: referenceSiteDefinition.site.id,
    });
    await store.recordAudit({
      ...sharedEvent,
      siteId: createSiteId("site_another"),
    });

    expect(
      await database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM blog_post_operation_audit_events
           WHERE event_id = ?1`,
        )
        .bind(
          createBlogPostAuditEventId(sharedEvent),
        )
        .first(),
    ).toEqual({ count: 2 });

    await store.recordAudit({
      ...sharedEvent,
      siteId: referenceSiteDefinition.site.id,
      commandType: "blog.post.archive",
      requestId: "withdrawal.continue:key",
    });
    await store.recordAudit({
      ...sharedEvent,
      siteId: referenceSiteDefinition.site.id,
      commandType: "blog.post.archive.withdrawal.continue",
      requestId: "key",
    });
    expect(
      await database
        .prepare(
          `SELECT COUNT(DISTINCT event_id) AS count
           FROM blog_post_operation_audit_events
           WHERE site_id = ?1
             AND command_type IN (
               'blog.post.archive',
               'blog.post.archive.withdrawal.continue'
             )`,
        )
        .bind(referenceSiteDefinition.site.id)
        .first(),
    ).toEqual({ count: 2 });
  });

  it("reloads active human authority before schedule activation", async () => {
    const approval = await approveCurrent();
    await database
      .prepare(
        `UPDATE human_memberships
         SET status = 'suspended', updated_at = ?1
         WHERE site_id = ?2 AND id = ?3`,
      )
      .bind(now, referenceSiteDefinition.site.id, actorId)
      .run();
    const app = createBlogPostOperationsApplication({
      store: createD1BlogPostOperationsStore(database),
      now: () => operationTime,
      timeZoneDatabaseVersion: () => "2026a",
    });

    await expect(app.commands.activateSchedule({
      actorId,
      siteId: referenceSiteDefinition.site.id,
      postId,
      approvalId: approval.id,
      resolvedTime: {
        localDateTime: "2026-11-01T01:00:00",
        ianaTimeZone: "America/Vancouver",
        utcOffsetChoice: "-07:00",
        executeAtUtc: now,
      },
      idempotencyKey: "activation-after-membership-suspension",
    })).rejects.toMatchObject({ code: "human_authority_required" });
    expect(
      await database
        .prepare(
          `SELECT reason_code
           FROM blog_post_operation_audit_events
           WHERE site_id = ?1
             AND command_type = 'blog.post.schedule.activate'
             AND request_id = 'activation-after-membership-suspension'
             AND outcome = 'rejected'`,
        )
        .bind(referenceSiteDefinition.site.id)
        .first(),
    ).toEqual({ reason_code: "human_authority_required" });
  });

  it("rejects schedule activation when human authority is revoked before the D1 commit", async () => {
    const approval = await approveCurrent();
    const durableStore = createD1BlogPostOperationsStore(database);
    const app = createBlogPostOperationsApplication({
      store: {
        ...durableStore,
        async saveSchedule(schedule, idempotencyKey) {
          await database
            .prepare(
              `UPDATE human_memberships
               SET status = 'suspended', updated_at = ?1
               WHERE site_id = ?2 AND id = ?3`,
            )
            .bind(now, referenceSiteDefinition.site.id, actorId)
            .run();
          return durableStore.saveSchedule(schedule, idempotencyKey);
        },
      },
      now: () => operationTime,
      timeZoneDatabaseVersion: () => "2026a",
    });

    await expect(app.commands.activateSchedule({
      actorId,
      siteId: referenceSiteDefinition.site.id,
      postId,
      approvalId: approval.id,
      resolvedTime: {
        localDateTime: "2026-11-01T01:00:00",
        ianaTimeZone: "America/Vancouver",
        utcOffsetChoice: "-07:00",
        executeAtUtc: now,
      },
      idempotencyKey: "activation-revoked-before-commit",
    })).rejects.toMatchObject({ code: "human_authority_required" });
    expect(
      await database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM blog_post_schedules
           WHERE idempotency_key = 'activation-revoked-before-commit'`,
        )
        .first(),
    ).toEqual({ count: 0 });
  });

  it("rejects MCP schedule activation when its publication grant is revoked before the D1 commit", async () => {
    const approval = await approveCurrent();
    const mcpActorId = createContentActorId("mcp-agent-56");
    await database.batch([
      database
        .prepare(
          `INSERT INTO mcp_connections (
             id, actor_id, site_id, oauth_client_id, redirect_uri,
             scopes_json, status, created_by_membership_id, created_at
           ) VALUES (
             'connection-schedule-56', 'agent-56', ?1, 'client-56',
             'https://client.example/callback', '["site.read"]',
             'active', ?2, ?3
           )`,
        )
        .bind(referenceSiteDefinition.site.id, actorId, beforeNow),
      database.prepare(
        `INSERT INTO mcp_connection_scopes (connection_id, scope)
         VALUES
           ('connection-schedule-56', 'site.read'),
           ('connection-schedule-56', 'content.draft'),
           ('connection-schedule-56', 'publication.schedule')`,
      ),
    ]);
    const durableStore = createD1BlogPostOperationsStore(database);
    const authority = {
      kind: "mcp" as const,
      connectionId: "connection-schedule-56",
      actorId: "agent-56",
      operation: "foundry.publication.schedule" as const,
      // The MCP application layer derives the complete scope set from
      // revision 0 and the approved revision before the command reaches the
      // store. `mcp-publications.test.ts` proves that derivation; here the
      // store must persist the given set verbatim so execution-time
      // revalidation re-checks every scope the operation actually needed.
      requiredScopes: ["publication.schedule", "content.draft"],
    };
    const durableApp = createBlogPostOperationsApplication({
      store: durableStore,
      now: () => operationTime,
      timeZoneDatabaseVersion: () => "2026a",
    });
    const persisted = await durableApp.commands.activateSchedule({
      actorId: mcpActorId,
      siteId: referenceSiteDefinition.site.id,
      postId,
      approvalId: approval.id,
      resolvedTime: {
        localDateTime: "2026-11-01T01:00:00",
        ianaTimeZone: "America/Vancouver",
        utcOffsetChoice: "-07:00",
        executeAtUtc: now,
      },
      idempotencyKey: "mcp-schedule-persisted-authority",
      authority,
    });
    await expect(
      durableStore.findMcpScheduleAuthority(persisted.id),
    ).resolves.toEqual(authority);
    const app = createBlogPostOperationsApplication({
      store: {
        ...durableStore,
        async saveSchedule(schedule, idempotencyKey, authority) {
          await database
            .prepare(
              `UPDATE mcp_connections
               SET status = 'revoked', revoked_at = ?1
               WHERE id = 'connection-schedule-56'`,
            )
            .bind(now)
            .run();
          return durableStore.saveSchedule(
            schedule,
            idempotencyKey,
            authority,
          );
        },
      },
      now: () => operationTime,
      timeZoneDatabaseVersion: () => "2026a",
    });

    await expect(
      app.commands.activateSchedule({
        actorId: mcpActorId,
        siteId: referenceSiteDefinition.site.id,
        postId,
        approvalId: approval.id,
        resolvedTime: {
          localDateTime: "2026-11-01T01:00:00",
          ianaTimeZone: "America/Vancouver",
          utcOffsetChoice: "-07:00",
          executeAtUtc: now,
        },
        idempotencyKey: "mcp-schedule-revoked-before-commit",
        authority,
      }),
    ).rejects.toMatchObject({
      code: "mcp_schedule_authority_required",
    });
    await expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM blog_post_schedules
           WHERE idempotency_key =
                 'mcp-schedule-revoked-before-commit'`,
        )
        .first(),
    ).resolves.toEqual({ count: 0 });
  });

  it("rejects a schedule that is not strictly after its persisted activation timestamp", async () => {
    const approval = await approveCurrent();
    const store = createD1BlogPostOperationsStore(database);
    const [post, evidence] = await Promise.all([
      store.findPost(referenceSiteDefinition.site.id, postId),
      store.findApproval(approval.id),
    ]);

    await expect(store.saveSchedule({
      id: "schedule_d1_strict_future_boundary",
      siteId: referenceSiteDefinition.site.id,
      postId,
      workspaceId,
      contentRevision: approval.revision,
      postRevisionId: post!.postRevisionId,
      approvalId: approval.id,
      approvalFingerprint: evidence!.fingerprint,
      authorityPostRevisionId: post!.postRevisionId,
      authorityVersion: post!.version,
      localDateTime: "2026-11-01T01:00:00",
      ianaTimeZone: "America/Vancouver",
      utcOffsetChoice: "-07:00",
      executeAtUtc: now,
      timeZoneDatabaseVersion: "2026a",
      createdBy: actorId,
      activatedBy: actorId,
      activationAuditId:
        "blog.post.schedule.activation:schedule_d1_strict_future_boundary",
      activatedAt: now,
      state: "active",
      detail: null,
    }, "d1-strict-future-boundary")).rejects.toMatchObject({
      code: "schedule_activation_failed",
    });
    expect(
      await database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM blog_post_schedules
           WHERE id = 'schedule_d1_strict_future_boundary'`,
        )
        .first(),
    ).toEqual({ count: 0 });
    expect(
      await database
        .prepare(
          `SELECT workflow_state
           FROM blog_post_collection_states
           WHERE site_id = ?1 AND post_id = ?2`,
        )
        .bind(referenceSiteDefinition.site.id, postId)
        .first(),
    ).toBeNull();
  });

  it("rejects schedule cancellation when human authority is revoked before the D1 commit", async () => {
    const approval = await approveCurrent();
    const durableStore = createD1BlogPostOperationsStore(database);
    const setup = createBlogPostOperationsApplication({
      store: durableStore,
      now: () => operationTime,
      timeZoneDatabaseVersion: () => "2026a",
    });
    const schedule = await setup.commands.activateSchedule({
      actorId,
      siteId: referenceSiteDefinition.site.id,
      postId,
      approvalId: approval.id,
      resolvedTime: {
        localDateTime: "2026-11-01T01:00:00",
        ianaTimeZone: "America/Vancouver",
        utcOffsetChoice: "-07:00",
        executeAtUtc: now,
      },
      idempotencyKey: "activation-before-cancel-revocation",
    });
    const app = createBlogPostOperationsApplication({
      store: {
        ...durableStore,
        async cancelSchedule(input) {
          await database
            .prepare(
              `UPDATE human_memberships
               SET status = 'suspended', updated_at = ?1
               WHERE site_id = ?2 AND id = ?3`,
            )
            .bind(now, referenceSiteDefinition.site.id, actorId)
            .run();
          return durableStore.cancelSchedule(input);
        },
      },
      now: () => operationTime,
      timeZoneDatabaseVersion: () => "2026a",
    });

    await expect(app.commands.cancelSchedule({
      actorId,
      siteId: referenceSiteDefinition.site.id,
      postId,
      scheduleId: schedule.id,
      idempotencyKey: "cancellation-revoked-before-commit",
    })).rejects.toMatchObject({ code: "human_authority_required" });
    await expect(durableStore.findSchedule(schedule.id)).resolves.toMatchObject({
      state: "active",
    });
  });

  it("rejects MCP schedule cancellation revoked before the D1 commit", async () => {
    // The grant is live when the command admits the cancellation and gone by
    // the time the statement runs. That statement revalidates the connection
    // in the same write, so the schedule stays active.
    const approval = await approveCurrent();
    const mcpActorId = createContentActorId("mcp-agent-cancel");
    await database.batch([
      database
        .prepare(
          `INSERT INTO mcp_connections (
             id, actor_id, site_id, oauth_client_id, redirect_uri,
             scopes_json, status, created_by_membership_id, created_at
           ) VALUES (
             'connection-cancel', 'agent-cancel', ?1, 'client-cancel',
             'https://client.example/callback', '["site.read"]',
             'active', ?2, ?3
           )`,
        )
        .bind(referenceSiteDefinition.site.id, actorId, beforeNow),
      database.prepare(
        `INSERT INTO mcp_connection_scopes (connection_id, scope)
         VALUES
           ('connection-cancel', 'site.read'),
           ('connection-cancel', 'content.draft'),
           ('connection-cancel', 'publication.schedule')`,
      ),
    ]);
    const authority = {
      kind: "mcp" as const,
      connectionId: "connection-cancel",
      actorId: "agent-cancel",
      operation: "foundry.publication.schedule" as const,
      requiredScopes: ["publication.schedule", "content.draft"],
    };
    const durableStore = createD1BlogPostOperationsStore(database);
    const setup = createBlogPostOperationsApplication({
      store: durableStore,
      now: () => operationTime,
      createId: (kind) => `${kind}_mcp_cancel`,
      timeZoneDatabaseVersion: () => "2026a",
    });
    const schedule = await setup.commands.activateSchedule({
      actorId: mcpActorId,
      siteId: referenceSiteDefinition.site.id,
      postId,
      approvalId: approval.id,
      resolvedTime: {
        localDateTime: "2026-11-01T01:00:00",
        ianaTimeZone: "America/Vancouver",
        utcOffsetChoice: "-07:00",
        executeAtUtc: now,
      },
      idempotencyKey: "activation-before-mcp-cancel-revocation",
      authority,
    });
    const app = createBlogPostOperationsApplication({
      store: {
        ...durableStore,
        async cancelSchedule(input) {
          await database
            .prepare(
              `UPDATE mcp_connections
               SET status = 'revoked', revoked_at = ?1
               WHERE id = 'connection-cancel'`,
            )
            .bind(now)
            .run();
          return durableStore.cancelSchedule(input);
        },
      },
      now: () => operationTime,
      createId: (kind) => `${kind}_mcp_cancel`,
      timeZoneDatabaseVersion: () => "2026a",
    });

    await expect(app.commands.cancelSchedule({
      actorId: mcpActorId,
      siteId: referenceSiteDefinition.site.id,
      postId,
      scheduleId: schedule.id,
      idempotencyKey: "mcp-cancellation-revoked-before-commit",
      authority,
    })).rejects.toMatchObject({
      // The cancellation statement matched no row, and re-reading the grant
      // names the lost connection rather than blaming the schedule's state.
      code: "mcp_schedule_authority_required",
    });
    await expect(
      durableStore.findSchedule(schedule.id),
    ).resolves.toMatchObject({ state: "active" });
  });

  it("rejects archive when human authority is revoked before the D1 commit", async () => {
    const durableStore = createD1BlogPostOperationsStore(database);
    const post = await durableStore.findPost(
      referenceSiteDefinition.site.id,
      postId,
    );
    const app = createBlogPostOperationsApplication({
      store: {
        ...durableStore,
        async archive(input) {
          await database
            .prepare(
              `UPDATE human_memberships
               SET status = 'suspended', updated_at = ?1
               WHERE site_id = ?2 AND id = ?3`,
            )
            .bind(now, referenceSiteDefinition.site.id, actorId)
            .run();
          return durableStore.archive(input);
        },
      },
      now: () => operationTime,
      timeZoneDatabaseVersion: () => "2026a",
    });

    await expect(app.commands.archive({
      actorId,
      siteId: referenceSiteDefinition.site.id,
      postId,
      selectedPostRevisionId: post!.postRevisionId,
      idempotencyKey: "archive-revoked-before-commit",
    })).rejects.toMatchObject({ code: "human_authority_required" });
    await expect(durableStore.findPost(
      referenceSiteDefinition.site.id,
      postId,
    )).resolves.toMatchObject({ collectionState: "active" });
  });

  it("durably claims one execution and replays it across application instances", async () => {
    const approval = await approveCurrent();
    const app = createBlogPostOperationsApplication({
      store: createD1BlogPostOperationsStore(database),
      now: () => operationTime,
      createId: (kind) => `${kind}_first`,
      timeZoneDatabaseVersion: () => "2026a",
    });
    const schedule = await app.commands.activateSchedule({
      actorId,
      siteId: referenceSiteDefinition.site.id,
      postId,
      approvalId: approval.id,
      resolvedTime: {
        localDateTime: "2026-11-01T01:00:00",
        ianaTimeZone: "America/Vancouver",
        utcOffsetChoice: "-07:00",
        executeAtUtc: now,
      },
      idempotencyKey: "activate-durable-schedule",
    });
    expect(schedule).toMatchObject({
      createdBy: actorId,
      activatedBy: actorId,
      activationAuditId:
        `blog.post.schedule.activation:${schedule.id}`,
    });
    expect(
      await database
        .prepare(
          `SELECT workflow_state, version
           FROM blog_post_collection_states
           WHERE site_id = ?1 AND post_id = ?2`,
        )
        .bind(referenceSiteDefinition.site.id, postId)
        .first(),
    ).toEqual({ workflow_state: "scheduled", version: 2 });
    const replayedActivation =
      await createBlogPostOperationsApplication({
        store: createD1BlogPostOperationsStore(database),
        now: () => operationTime,
        createId: (kind) => `${kind}_ambiguous_retry`,
        timeZoneDatabaseVersion: () => "2026a",
      }).commands.activateSchedule({
        actorId,
        siteId: referenceSiteDefinition.site.id,
        postId,
        approvalId: approval.id,
        resolvedTime: {
          localDateTime: "2026-11-01T01:00:00",
          ianaTimeZone: "America/Vancouver",
          utcOffsetChoice: "-07:00",
          executeAtUtc: now,
        },
        idempotencyKey: "activate-durable-schedule",
      });
    expect(replayedActivation).toEqual(schedule);

    operationTime = now;
    const first = await app.commands.claimDueSchedule(schedule.siteId, schedule.id);
    const reloaded = createBlogPostOperationsApplication({
      store: createD1BlogPostOperationsStore(database),
      now: () => operationTime,
      createId: (kind) => `${kind}_second`,
      timeZoneDatabaseVersion: () => "2026a",
    });
    operationTime = now;
    const replay = await reloaded.commands.claimDueSchedule(schedule.siteId, schedule.id);

    expect(replay.execution).toEqual(first.execution);
    expect(first.lease).not.toBeNull();
    expect(replay.lease).toBeNull();
    expect(
      await reloaded.queries.getExecution(
        referenceSiteDefinition.site.id,
        first.execution.executionId,
      ),
    ).not.toHaveProperty("leaseToken");
    expect(
      await database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM blog_post_schedule_executions
           WHERE schedule_id = ?1`,
        )
        .bind(schedule.id)
        .first<{ count: number }>(),
    ).toEqual({ count: 1 });
    expect(
      await database
        .prepare(
          `SELECT outcome, reason_code
           FROM blog_post_operation_audit_events
           WHERE request_id = 'activate-durable-schedule'`,
        )
        .first(),
    ).toEqual({ outcome: "accepted", reason_code: "accepted" });
    expect(
      await database
        .prepare(
          `SELECT actor_id, command_type, outcome
           FROM blog_post_operation_audit_events
           WHERE request_id = ?1`,
        )
        .bind(first.execution.executionId)
        .first(),
    ).toEqual({
      actor_id: "system:scheduler",
      command_type: "blog.post.schedule.claim",
      outcome: "accepted",
    });
  });

  it("keeps the winning expired-lease reclaim bound to its reservation", async () => {
    const approval = await approveCurrent();
    const app = createBlogPostOperationsApplication({
      store: createD1BlogPostOperationsStore(database),
      now: () => operationTime,
      createId: (kind) => `${kind}_concurrent_reclaim`,
      timeZoneDatabaseVersion: () => "2026a",
    });
    const schedule = await app.commands.activateSchedule({
      actorId,
      siteId: referenceSiteDefinition.site.id,
      postId,
      approvalId: approval.id,
      resolvedTime: {
        localDateTime: "2026-11-01T01:00:00",
        ianaTimeZone: "America/Vancouver",
        utcOffsetChoice: "-07:00",
        executeAtUtc: now,
      },
      idempotencyKey: "activate-concurrent-reclaim",
    });
    operationTime = now;
    await app.commands.claimDueSchedule(schedule.siteId, schedule.id);
    operationTime = "2026-11-01T08:06:00.000Z";
    const reclaimers = [
      createBlogPostOperationsApplication({
        store: createD1BlogPostOperationsStore(database),
        now: () => operationTime,
        timeZoneDatabaseVersion: () => "2026a",
      }),
      createBlogPostOperationsApplication({
        store: createD1BlogPostOperationsStore(database),
        now: () => operationTime,
        timeZoneDatabaseVersion: () => "2026a",
      }),
    ];

    const results = await Promise.all(
      reclaimers.map(({ commands }) =>
        commands.claimDueSchedule(schedule.siteId, schedule.id)
      ),
    );
    const winner = results.find(({ lease }) => lease !== null);
    expect(winner?.lease).not.toBeNull();
    expect(results.filter(({ lease }) => lease !== null)).toHaveLength(1);
    expect(
      await database
        .prepare(
          `SELECT attempt, lease_token
           FROM blog_post_schedule_publication_reservations
           WHERE execution_id = ?1`,
        )
        .bind(winner!.execution.executionId)
        .first(),
    ).toEqual({
      attempt: winner!.execution.attempt,
      lease_token: winner!.lease!.leaseToken,
    });
  });

  it("persists non-executable proposals and explicit human cancellation", async () => {
    const approval = await approveCurrent();
    const store = createD1BlogPostOperationsStore(database);
    const app = createBlogPostOperationsApplication({
      store,
      now: () => operationTime,
      createId: (kind) => `${kind}_proposal_cancel`,
      timeZoneDatabaseVersion: () => "2026a",
    });
    const resolvedTime = {
      localDateTime: "2026-11-01T01:00:00",
      ianaTimeZone: "America/Vancouver",
      utcOffsetChoice: "-07:00",
      executeAtUtc: now,
    };

    const proposal = await app.commands.proposeSchedule({
      actorId,
      siteId: referenceSiteDefinition.site.id,
      postId,
      resolvedTime,
      idempotencyKey: "durable-proposal",
    });

    await expect(app.commands.proposeSchedule({
      actorId,
      siteId: referenceSiteDefinition.site.id,
      postId,
      resolvedTime,
      idempotencyKey: "durable-proposal",
    })).resolves.toEqual(proposal);
    expect(await store.listDueSchedules(now, 10)).toEqual([]);
    expect(
      await database
        .prepare(
          `SELECT COUNT(*) AS count FROM blog_post_schedule_proposals`,
        )
        .first<{ count: number }>(),
    ).toEqual({ count: 1 });
    expect(
      await database
        .prepare(
          `SELECT proposal.proposal_audit_id, audit.event_id
           FROM blog_post_schedule_proposals AS proposal
           JOIN blog_post_operation_audit_events AS audit
             ON audit.site_id = proposal.site_id
            AND audit.event_id = proposal.proposal_audit_id
           WHERE proposal.id = ?1`,
        )
        .bind(proposal.id)
        .first(),
    ).toEqual({
      proposal_audit_id: proposal.proposalAuditId,
      event_id: proposal.proposalAuditId,
    });
    for (const table of [
      "blog_post_schedule_execution_outcomes",
      "blog_post_schedule_execution_events",
      "blog_post_schedule_retry_receipts",
    ]) {
      const columns = await database
        .prepare(`PRAGMA table_info(${table})`)
        .all<{ name: string; pk: number }>();
      expect(
        columns.results
          .filter(({ pk }: { pk: number }) => pk > 0)
          .sort(
            (
              left: { pk: number },
              right: { pk: number },
            ) => left.pk - right.pk,
          )
          .map(({ name }: { name: string }) => name),
      ).toEqual([
        "site_id",
        table === "blog_post_schedule_retry_receipts"
          ? "request_id"
          : table === "blog_post_schedule_execution_events"
            ? "event_id"
            : "outcome_id",
      ]);
    }

    const schedule = await app.commands.activateSchedule({
      actorId,
      siteId: referenceSiteDefinition.site.id,
      postId,
      approvalId: approval.id,
      resolvedTime,
      idempotencyKey: "activate-before-durable-cancel",
    });
    const cancellation = {
      actorId,
      siteId: referenceSiteDefinition.site.id,
      postId,
      scheduleId: schedule.id,
      idempotencyKey: "durable-human-cancel",
    };
    const cancelled = await app.commands.cancelSchedule(cancellation);

    await expect(app.commands.cancelSchedule(cancellation)).resolves.toEqual(
      cancelled,
    );
    expect(cancelled).toMatchObject({
      state: "cancelled",
      detail: "human_cancelled",
    });
    expect(
      await database
        .prepare(
          `SELECT workflow_state
           FROM blog_post_collection_states
           WHERE site_id = ?1 AND post_id = ?2`,
        )
        .bind(referenceSiteDefinition.site.id, postId)
        .first(),
    ).toEqual({ workflow_state: "approved" });
    operationTime = now;
    await expect(
      app.commands.claimDueSchedule(schedule.siteId, schedule.id),
    ).rejects.toMatchObject({ code: "schedule_inactive" });
    await revisionApplication.commands.save({
      actorId,
      workspaceId,
      schemaVersion: referenceSiteDefinition.schemaVersion,
      baseRevision: 1,
      edits: [{
        path: `${postId}.title`,
        value: "Edited after human schedule cancellation",
      }],
      idempotencyKey: "edit-after-human-schedule-cancellation",
    });
    await expect(
      app.queries.getSchedule(referenceSiteDefinition.site.id, schedule.id),
    ).resolves.toMatchObject({
      state: "cancelled",
      detail: "human_cancelled",
    });
    expect(
      await database
        .prepare(
          `SELECT workflow_state
           FROM blog_post_collection_states
           WHERE site_id = ?1 AND post_id = ?2`,
        )
        .bind(referenceSiteDefinition.site.id, postId)
        .first(),
    ).toEqual({ workflow_state: "editing" });
  });

  it("keeps durable schedule proposals human-only until issue 56", async () => {
    const scopedMcpActor = createContentActorId("mcp-scoped-proposer");
    const otherSiteMcpActor = createContentActorId(
      "mcp-other-site-proposer",
    );
    const readOnlyMcpActor = createContentActorId(
      "mcp-read-only-proposer",
    );
    await database.batch([
      database
        .prepare(
          `INSERT INTO mcp_connections (
             id, actor_id, site_id, oauth_client_id, redirect_uri,
             scopes_json, status, created_by_membership_id, created_at
           ) VALUES (
             'connection-scoped-proposer', ?1, ?2, 'client-scoped',
             'https://agent.example.com/callback',
             '["site.read"]', 'active', ?3, ?4
           )`,
        )
        .bind(
          scopedMcpActor,
          referenceSiteDefinition.site.id,
          actorId,
          now,
        ),
      database
        .prepare(
          `INSERT INTO mcp_connections (
             id, actor_id, site_id, oauth_client_id, redirect_uri,
             scopes_json, status, created_by_membership_id, created_at
           ) VALUES (
             'connection-other-site-proposer', ?1, 'site_other',
             'client-other', 'https://agent.example.com/other',
             '["site.read"]', 'active', ?2, ?3
           )`,
        )
        .bind(otherSiteMcpActor, actorId, now),
      database
        .prepare(
          `INSERT INTO mcp_connections (
             id, actor_id, site_id, oauth_client_id, redirect_uri,
             scopes_json, status, created_by_membership_id, created_at
           ) VALUES (
             'connection-read-only-proposer', ?1, ?2, 'client-read',
             'https://agent.example.com/read', '["site.read"]',
             'active', ?3, ?4
           )`,
        )
        .bind(
          readOnlyMcpActor,
          referenceSiteDefinition.site.id,
          actorId,
          now,
        ),
      database.prepare(
        `INSERT INTO mcp_connection_scopes (connection_id, scope)
         VALUES
           ('connection-scoped-proposer', 'site.read'),
           ('connection-scoped-proposer', 'content.draft'),
           ('connection-other-site-proposer', 'site.read'),
           ('connection-other-site-proposer', 'content.draft'),
           ('connection-read-only-proposer', 'site.read')`,
      ),
      database
        .prepare(
          `INSERT INTO content_workspace_collaborators (
             workspace_id, actor_id, added_at
           ) VALUES (?1, ?2, ?3)`,
        )
        .bind(workspaceId, scopedMcpActor, now),
    ]);
    let proposalSequence = 0;
    const app = createBlogPostOperationsApplication({
      store: createD1BlogPostOperationsStore(database),
      now: () => operationTime,
      createId: (kind) => `${kind}_authority_${++proposalSequence}`,
      timeZoneDatabaseVersion: () => "2026a",
    });
    const resolvedTime = {
      localDateTime: "2026-11-01T01:00:00",
      ianaTimeZone: "America/Vancouver",
      utcOffsetChoice: "-07:00",
      executeAtUtc: now,
    };

    await expect(app.commands.proposeSchedule({
      actorId: scopedMcpActor,
      siteId: referenceSiteDefinition.site.id,
      postId,
      resolvedTime,
      idempotencyKey: "scoped-mcp-proposal",
    })).rejects.toMatchObject({
      code: "schedule_proposal_authority_required",
    });
    await expect(app.commands.proposeSchedule({
      actorId: otherSiteMcpActor,
      siteId: referenceSiteDefinition.site.id,
      postId,
      resolvedTime,
      idempotencyKey: "other-site-mcp-proposal",
    })).rejects.toMatchObject({
      code: "schedule_proposal_authority_required",
    });
    await expect(app.commands.proposeSchedule({
      actorId: readOnlyMcpActor,
      siteId: referenceSiteDefinition.site.id,
      postId,
      resolvedTime,
      idempotencyKey: "read-only-mcp-proposal",
    })).rejects.toMatchObject({
      code: "schedule_proposal_authority_required",
    });
    await expect(app.commands.proposeSchedule({
      actorId: createContentActorId("integration-proposer"),
      siteId: referenceSiteDefinition.site.id,
      postId,
      resolvedTime,
      idempotencyKey: "integration-proposal",
    })).rejects.toMatchObject({
      code: "schedule_proposal_authority_required",
    });
    await database
      .prepare(
        `UPDATE mcp_connections
         SET status = 'revoked', revoked_at = ?1
         WHERE actor_id = ?2`,
      )
      .bind(now, scopedMcpActor)
      .run();
    await expect(app.commands.proposeSchedule({
      actorId: scopedMcpActor,
      siteId: referenceSiteDefinition.site.id,
      postId,
      resolvedTime,
      idempotencyKey: "revoked-mcp-proposal",
    })).rejects.toMatchObject({
      code: "schedule_proposal_authority_required",
    });
    expect(
      await database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM blog_post_schedule_proposals`,
        )
        .first(),
    ).toEqual({ count: 0 });
  });

  it("does not admit MCP actors at the durable proposal commit", async () => {
    const mcpActor = createContentActorId("mcp-revoked-at-commit");
    await database.batch([
      database
        .prepare(
        `INSERT INTO mcp_connections (
           id, actor_id, site_id, oauth_client_id, redirect_uri,
           scopes_json, status, created_by_membership_id, created_at
         ) VALUES (
           'connection-revoked-at-commit', ?1, ?2, 'client-race',
           'https://agent.example.com/race', '["site.read"]',
           'active', ?3, ?4
         )`,
      )
      .bind(
        mcpActor,
        referenceSiteDefinition.site.id,
        actorId,
        now,
      ),
      database.prepare(
        `INSERT INTO mcp_connection_scopes (connection_id, scope)
         VALUES
           ('connection-revoked-at-commit', 'site.read'),
           ('connection-revoked-at-commit', 'content.draft')`,
      ),
    ]);
    await database
      .prepare(
        `INSERT INTO content_workspace_collaborators (
           workspace_id, actor_id, added_at
         ) VALUES (?1, ?2, ?3)`,
      )
      .bind(workspaceId, mcpActor, now)
      .run();
    const durableStore = createD1BlogPostOperationsStore(database);
    let revokeBeforeCommit = true;
    const app = createBlogPostOperationsApplication({
      store: {
        ...durableStore,
        async saveScheduleProposal(proposal, idempotencyKey) {
          if (revokeBeforeCommit) {
            revokeBeforeCommit = false;
            await database
              .prepare(
                `UPDATE mcp_connections
                 SET status = 'revoked', revoked_at = ?1
                 WHERE actor_id = ?2`,
              )
              .bind(now, mcpActor)
              .run();
          }
          return durableStore.saveScheduleProposal(
            proposal,
            idempotencyKey,
          );
        },
      },
      now: () => operationTime,
      createId: (kind) => `${kind}_revoked_at_commit`,
      timeZoneDatabaseVersion: () => "2026a",
    });

    await expect(app.commands.proposeSchedule({
      actorId: mcpActor,
      siteId: referenceSiteDefinition.site.id,
      postId,
      resolvedTime: {
        localDateTime: "2026-11-01T01:00:00",
        ianaTimeZone: "America/Vancouver",
        utcOffsetChoice: "-07:00",
        executeAtUtc: now,
      },
      idempotencyKey: "mcp-revoked-before-proposal-commit",
    })).rejects.toMatchObject({
      code: "schedule_proposal_authority_required",
    });
    expect(
      await database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM blog_post_schedule_proposals`,
        )
        .first(),
    ).toEqual({ count: 0 });
  });

  it("rejects a proposal when the current revision changes before commit", async () => {
    const durableStore = createD1BlogPostOperationsStore(database);
    let injectEdit = true;
    const app = createBlogPostOperationsApplication({
      store: {
        ...durableStore,
        async saveScheduleProposal(proposal, idempotencyKey) {
          if (injectEdit) {
            injectEdit = false;
            await database
              .prepare(
                `UPDATE blog_posts
                 SET version = version + 1
                 WHERE site_id = ?1 AND post_id = ?2`,
              )
              .bind(referenceSiteDefinition.site.id, postId)
              .run();
          }
          return durableStore.saveScheduleProposal(
            proposal,
            idempotencyKey,
          );
        },
      },
      now: () => operationTime,
      createId: (kind) => `${kind}_proposal_stale`,
      timeZoneDatabaseVersion: () => "2026a",
    });

    await expect(app.commands.proposeSchedule({
      actorId,
      siteId: referenceSiteDefinition.site.id,
      postId,
      resolvedTime: {
        localDateTime: "2026-11-01T01:00:00",
        ianaTimeZone: "America/Vancouver",
        utcOffsetChoice: "-07:00",
        executeAtUtc: now,
      },
      idempotencyKey: "proposal-lost-current-revision",
    })).rejects.toMatchObject({ code: "schedule_proposal_stale" });
    expect(
      await database
        .prepare(
          `SELECT COUNT(*) AS count FROM blog_post_schedule_proposals`,
        )
        .first<{ count: number }>(),
    ).toEqual({ count: 0 });
  });

  it("schedules the approved current-workspace successor draft", async () => {
    await revisionApplication.commands.save({
      actorId,
      workspaceId,
      schemaVersion: referenceSiteDefinition.schemaVersion,
      baseRevision: 1,
      edits: [{
        path: `${postId}.title`,
        value: "Approved edited title",
      }],
      idempotencyKey: "edit-before-scheduling",
    });
    const approval = await approveCurrent();
    const approvedArtifact = (
      await createD1BlogPostOperationsStore(database)
        .findApproval(approval.id)
    )!.postArtifacts.find((artifact) => artifact.postId === postId)!;
    const currentPost = await createD1BlogPostOperationsStore(database)
      .findPost(referenceSiteDefinition.site.id, postId);
    expect(approvedArtifact.postRevisionId).not.toBe(
      currentPost?.postRevisionId,
    );
    const app = createBlogPostOperationsApplication({
      store: createD1BlogPostOperationsStore(database),
      now: () => operationTime,
      createId: (kind) => `${kind}_edited`,
      timeZoneDatabaseVersion: () => "2026a",
    });

    await expect(app.commands.activateSchedule({
      actorId,
      siteId: referenceSiteDefinition.site.id,
      postId,
      approvalId: approval.id,
      resolvedTime: {
        localDateTime: "2026-11-01T01:00:00",
        ianaTimeZone: "America/Vancouver",
        utcOffsetChoice: "-07:00",
        executeAtUtc: now,
      },
      idempotencyKey: "activate-edited-post",
    })).resolves.toMatchObject({
      workspaceId,
      contentRevision: approval.revision,
      postRevisionId: approvedArtifact.postRevisionId,
      authorityPostRevisionId: currentPost?.postRevisionId,
      state: "active",
    });
    expect(
      await database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM blog_post_schedules
           WHERE idempotency_key = 'activate-edited-post'`,
        )
        .first(),
    ).toEqual({ count: 1 });
  });

  it("treats a migrated legacy approval without blog artifacts as stale", async () => {
    const approval = await approveCurrent();
    const legacyApprovalId = createContentApprovalId(
      `approval_${"9".repeat(32)}`,
    );
    await database
      .prepare(
        `INSERT INTO content_approvals (
           id, workspace_id, revision, fingerprint, channel,
           channel_configuration_hash, content_hash, design_hash,
           revision_content_hash, blog_post_artifacts_json,
           schema_version, renderer_version, production_base,
           artifact_hash, serialization_version, approved_by, approved_at
         )
         SELECT
           ?1, workspace_id, revision, fingerprint, channel,
           channel_configuration_hash, content_hash, design_hash,
           revision_content_hash, NULL,
           schema_version, renderer_version, production_base,
           artifact_hash, serialization_version, approved_by, approved_at
         FROM content_approvals
         WHERE id = ?2`,
      )
      .bind(legacyApprovalId, approval.id)
      .run();
    const store = createD1BlogPostOperationsStore(database);
    expect(await store.findApproval(legacyApprovalId)).toMatchObject({
      id: legacyApprovalId,
      postArtifacts: [],
    });
    const app = createBlogPostOperationsApplication({
      store,
      now: () => operationTime,
      createId: (kind) => `${kind}_legacy_approval`,
      timeZoneDatabaseVersion: () => "2026a",
    });

    await expect(app.commands.activateSchedule({
      actorId,
      siteId: referenceSiteDefinition.site.id,
      postId,
      approvalId: legacyApprovalId,
      resolvedTime: {
        localDateTime: "2026-11-01T01:00:00",
        ianaTimeZone: "America/Vancouver",
        utcOffsetChoice: "-07:00",
        executeAtUtc: now,
      },
      idempotencyKey: "activate-legacy-approval",
    })).rejects.toMatchObject({ code: "approval_stale" });
    expect(
      await database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM blog_post_schedules
           WHERE idempotency_key = 'activate-legacy-approval'`,
        )
        .first(),
    ).toEqual({ count: 0 });
  });

  it("rejects stale authority at the D1 activation commit boundary", async () => {
    const approval = await approveCurrent();
    const durableStore = createD1BlogPostOperationsStore(database);
    let injectEdit = true;
    const app = createBlogPostOperationsApplication({
      store: {
        ...durableStore,
        async saveSchedule(schedule, idempotencyKey) {
          if (injectEdit) {
            injectEdit = false;
            await revisionApplication.commands.save({
              actorId,
              workspaceId,
              schemaVersion: referenceSiteDefinition.schemaVersion,
              baseRevision: 1,
              edits: [{
                path: `${postId}.title`,
                value: "Concurrent authority invalidation",
              }],
              idempotencyKey: "concurrent-edit-before-schedule-commit",
            });
          }
          return durableStore.saveSchedule(schedule, idempotencyKey);
        },
      },
      now: () => operationTime,
      createId: (kind) => `${kind}_stale_commit`,
      timeZoneDatabaseVersion: () => "2026a",
    });

    await expect(
      app.commands.activateSchedule({
        actorId,
        siteId: referenceSiteDefinition.site.id,
        postId,
        approvalId: approval.id,
        resolvedTime: {
          localDateTime: "2026-11-01T01:30:00",
          ianaTimeZone: "America/Vancouver",
          utcOffsetChoice: "-07:00",
          executeAtUtc: "2026-11-01T08:30:00.000Z",
        },
        idempotencyKey: "activate-stale-commit",
      }),
    ).rejects.toMatchObject({ code: "approval_stale" });
    expect(
      await database
        .prepare(
          `SELECT COUNT(*) AS count FROM blog_post_schedules
           WHERE state = 'active'`,
        )
        .first<{ count: number }>(),
    ).toEqual({ count: 0 });
  });

  it("rejects approved/current revision drift at the D1 activation boundary", async () => {
    const approval = await approveCurrent();
    const durableStore = createD1BlogPostOperationsStore(database);
    await database
      .prepare(
        `INSERT INTO blog_post_revisions (
           revision_id, site_id, post_id, revision, workspace_id,
           content_revision, snapshot_json, created_at, created_by,
           content_hash, schema_version, renderer_version,
           serialization_version, rendered_bytes_hash,
           artifact_fingerprint
         )
         SELECT
           'post-revision-concurrent-activation', site_id, post_id,
           revision + 100, workspace_id, content_revision, snapshot_json,
           created_at, created_by, content_hash, schema_version,
           renderer_version, serialization_version, rendered_bytes_hash,
           artifact_fingerprint
         FROM blog_post_revisions
         WHERE revision_id = (
           SELECT current_revision_id
           FROM blog_posts
           WHERE site_id = ?1 AND post_id = ?2
         )`,
      )
      .bind(referenceSiteDefinition.site.id, postId)
      .run();
    const app = createBlogPostOperationsApplication({
      store: {
        ...durableStore,
        async saveSchedule(schedule, idempotencyKey) {
          await database
            .prepare(
              `UPDATE blog_posts
               SET current_revision_id =
                     'post-revision-concurrent-activation',
                   current_revision = current_revision + 100
               WHERE site_id = ?1 AND post_id = ?2`,
            )
            .bind(schedule.siteId, schedule.postId)
            .run();
          return durableStore.saveSchedule(schedule, idempotencyKey);
        },
      },
      now: () => operationTime,
      createId: (kind) => `${kind}_fingerprint_drift`,
      timeZoneDatabaseVersion: () => "2026a",
    });

    await expect(app.commands.activateSchedule({
      actorId,
      siteId: referenceSiteDefinition.site.id,
      postId,
      approvalId: approval.id,
      resolvedTime: {
        localDateTime: "2026-11-01T01:00:00",
        ianaTimeZone: "America/Vancouver",
        utcOffsetChoice: "-07:00",
        executeAtUtc: now,
      },
      idempotencyKey: "activate-after-current-revision-drift",
    })).rejects.toMatchObject({ code: "approval_stale" });
    expect(
      await database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM blog_post_schedules
           WHERE idempotency_key =
             'activate-after-current-revision-drift'`,
        )
        .first(),
    ).toEqual({ count: 0 });
  });

  it("rejects approved/current revision drift at the D1 claim boundary", async () => {
    const approval = await approveCurrent();
    const store = createD1BlogPostOperationsStore(database);
    const app = createBlogPostOperationsApplication({
      store,
      now: () => operationTime,
      createId: (kind) => `${kind}_claim_fingerprint_drift`,
      timeZoneDatabaseVersion: () => "2026a",
    });
    const schedule = await app.commands.activateSchedule({
      actorId,
      siteId: referenceSiteDefinition.site.id,
      postId,
      approvalId: approval.id,
      resolvedTime: {
        localDateTime: "2026-11-01T01:00:00",
        ianaTimeZone: "America/Vancouver",
        utcOffsetChoice: "-07:00",
        executeAtUtc: now,
      },
      idempotencyKey: "activate-before-claim-fingerprint-drift",
    });
    await database.batch([
      database
        .prepare(
          `INSERT INTO blog_post_revisions (
             revision_id, site_id, post_id, revision, workspace_id,
             content_revision, snapshot_json, created_at, created_by,
             content_hash, schema_version, renderer_version,
             serialization_version, rendered_bytes_hash,
             artifact_fingerprint
           )
           SELECT
             'post-revision-concurrent-claim', site_id, post_id,
             revision + 100, workspace_id, content_revision, snapshot_json,
             created_at, created_by, content_hash, schema_version,
             renderer_version, serialization_version, rendered_bytes_hash,
             artifact_fingerprint
           FROM blog_post_revisions
           WHERE revision_id = ?1`,
        )
        .bind(schedule.postRevisionId),
      database
        .prepare(
          `UPDATE blog_posts
           SET current_revision_id = 'post-revision-concurrent-claim',
               current_revision = current_revision + 100
           WHERE site_id = ?1 AND post_id = ?2`,
        )
        .bind(schedule.siteId, schedule.postId),
    ]);
    operationTime = now;

    await expect(
      app.commands.claimDueSchedule(schedule.siteId, schedule.id),
    ).rejects.toMatchObject({ code: "approval_stale" });
    await expect(store.findSchedule(schedule.id)).resolves.toMatchObject({
      state: "active",
    });
  });

  it("rejects schedule activation when the verified aggregate advances before commit", async () => {
    const approval = await approveCurrent();
    const durableStore = createD1BlogPostOperationsStore(database);
    let injectAggregateAdvance = true;
    const app = createBlogPostOperationsApplication({
      store: {
        ...durableStore,
        async saveSchedule(schedule, idempotencyKey) {
          if (injectAggregateAdvance) {
            injectAggregateAdvance = false;
            await database
              .prepare(
                `UPDATE blog_posts
                 SET version = version + 1
                 WHERE site_id = ?1 AND post_id = ?2`,
              )
              .bind(referenceSiteDefinition.site.id, postId)
              .run();
          }
          return durableStore.saveSchedule(schedule, idempotencyKey);
        },
      },
      now: () => operationTime,
      createId: (kind) => `${kind}_aggregate_drift`,
      timeZoneDatabaseVersion: () => "2026a",
    });

    await expect(app.commands.activateSchedule({
      actorId,
      siteId: referenceSiteDefinition.site.id,
      postId,
      approvalId: approval.id,
      resolvedTime: {
        localDateTime: "2026-11-01T01:00:00",
        ianaTimeZone: "America/Vancouver",
        utcOffsetChoice: "-07:00",
        executeAtUtc: now,
      },
      idempotencyKey: "activate-after-aggregate-drift",
    })).rejects.toMatchObject({ code: "approval_stale" });
    expect(
      await database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM blog_post_schedules
           WHERE idempotency_key = 'activate-after-aggregate-drift'`,
        )
        .first<{ count: number }>(),
    ).toEqual({ count: 0 });
  });

  it("does not claim a schedule while production is already advancing", async () => {
    const approval = await approveCurrent();
    const app = createBlogPostOperationsApplication({
      store: createD1BlogPostOperationsStore(database),
      now: () => operationTime,
      createId: (kind) => `${kind}_competing_publication`,
      timeZoneDatabaseVersion: () => "2026a",
    });
    const schedule = await app.commands.activateSchedule({
      actorId,
      siteId: referenceSiteDefinition.site.id,
      postId,
      approvalId: approval.id,
      resolvedTime: {
        localDateTime: "2026-11-01T01:00:00",
        ianaTimeZone: "America/Vancouver",
        utcOffsetChoice: "-07:00",
        executeAtUtc: now,
      },
      idempotencyKey: "activate-before-competing-publication",
    });
    await createD1ContentPublicationStore(database).claimPublication({
      id: createContentPublicationId(`publish_${"7".repeat(32)}`),
      workspaceId,
      revision: approval.revision,
      approvalId: approval.id,
      fingerprint: approval.fingerprint.value,
      idempotencyKey: "competing-publication-request",
      requestedBy: membershipId,
      contributors: [actorId],
      expectedHead: "a".repeat(40),
      status: "requested",
      commitSha: null,
      deploymentId: null,
      deploymentRequestedAt: null,
      detail: null,
      leaseToken: "publication-lease",
      leaseExpiresAt: "2026-11-01T08:05:00.000Z",
      requestedAt: now,
      updatedAt: now,
    });

    operationTime = now;
    await expect(
      app.commands.claimDueSchedule(schedule.siteId, schedule.id),
    ).rejects.toMatchObject({
      code: "production_operation_in_progress",
    });
    expect(await app.queries.getSchedule(
      referenceSiteDefinition.site.id,
      schedule.id,
    )).toMatchObject({
      state: "active",
    });
  });

  it("rejects a normal publication that preempts an attributed schedule key", async () => {
    const approval = await approveCurrent();
    const app = createBlogPostOperationsApplication({
      store: createD1BlogPostOperationsStore(database),
      now: () => operationTime,
      createId: (kind) => `${kind}_attributed_key`,
      timeZoneDatabaseVersion: () => "2026a",
    });
    const schedule = await app.commands.activateSchedule({
      actorId,
      siteId: referenceSiteDefinition.site.id,
      postId,
      approvalId: approval.id,
      resolvedTime: {
        localDateTime: "2026-11-01T01:00:00",
        ianaTimeZone: "America/Vancouver",
        utcOffsetChoice: "-07:00",
        executeAtUtc: now,
      },
      idempotencyKey: "activate-attributed-publication-key",
    });
    const scheduledKey = `scheduled-publication:${schedule.id}`;

    await expect(
      createD1ContentPublicationStore(database).claimPublication({
        id: createContentPublicationId(`publish_${"5".repeat(32)}`),
        workspaceId,
        revision: approval.revision,
        approvalId: approval.id,
        fingerprint: approval.fingerprint.value,
        idempotencyKey: scheduledKey,
        requestedBy: membershipId,
        contributors: [actorId],
        expectedHead: "a".repeat(40),
        status: "requested",
        commitSha: null,
        deploymentId: null,
        deploymentRequestedAt: null,
        detail: null,
        leaseToken: "ordinary-publication-lease",
        leaseExpiresAt: "2026-11-01T08:05:00.000Z",
        requestedAt: now,
        updatedAt: now,
      }),
    ).rejects.toMatchObject({
      code: "publication_reservation_lost",
    });
    expect(
      await database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM content_publications
           WHERE idempotency_key = ?1`,
        )
        .bind(scheduledKey)
        .first(),
    ).toEqual({ count: 0 });

    operationTime = now;
    await expect(
      app.commands.claimDueSchedule(schedule.siteId, schedule.id),
    ).resolves.toMatchObject({
      execution: { publicationIdempotencyKey: scheduledKey },
      lease: expect.objectContaining({ leaseToken: expect.any(String) }),
    });
  });

  it("reserves publication ownership and retries its own active publication", async () => {
    const approval = await approveCurrent();
    const store = createD1BlogPostOperationsStore(database);
    const app = createBlogPostOperationsApplication({
      store,
      now: () => operationTime,
      createId: (kind) => `${kind}_owned_publication`,
      timeZoneDatabaseVersion: () => "2026a",
    });
    const schedule = await app.commands.activateSchedule({
      actorId,
      siteId: referenceSiteDefinition.site.id,
      postId,
      approvalId: approval.id,
      resolvedTime: {
        localDateTime: "2026-11-01T01:00:00",
        ianaTimeZone: "America/Vancouver",
        utcOffsetChoice: "-07:00",
        executeAtUtc: now,
      },
      idempotencyKey: "activate-owned-publication",
    });
    operationTime = now;
    const claim = await app.commands.claimDueSchedule(schedule.siteId, schedule.id);
    await createD1ContentPublicationStore(database).claimPublication({
      id: createContentPublicationId(`publish_${"8".repeat(32)}`),
      workspaceId,
      revision: approval.revision,
      approvalId: approval.id,
      fingerprint: approval.fingerprint.value,
      idempotencyKey: claim.execution.publicationIdempotencyKey,
      requestedBy: membershipId,
      contributors: [actorId],
      expectedHead: "a".repeat(40),
      status: "unknown",
      commitSha: null,
      deploymentId: null,
      deploymentRequestedAt: null,
      detail: "deployment_result_unknown",
      leaseToken: null,
      leaseExpiresAt: null,
      requestedAt: now,
      updatedAt: now,
    }, {
      executionId: claim.execution.executionId,
      attempt: claim.execution.attempt,
      leaseToken: claim.lease!.leaseToken,
    });

    await expect(store.retryExecution({
      executionId: claim.execution.executionId,
      approvalAuthorityValid: true,
      leaseToken: "retry-owned-publication",
      leaseExpiresAt: "2026-11-01T08:11:00.000Z",
      updatedAt: "2026-11-01T08:06:00.000Z",
      actorId,
      requestId: "retry-owned-publication-request",
      retryKind: "scheduler",
    })).resolves.toMatchObject({
      execution: {
        attempt: 2,
        state: "claimed",
      },
    });
  });

  it("claims a scheduled publication under the schedule scope alone", async () => {
    // A scheduled publication claim carries a reservation proof and the
    // schedule operation, so the publication scope the claim statement demands
    // follows that operation. This connection was never granted
    // publication.publish; requiring it here would block every scheduled
    // publication an MCP connection originated.
    const approval = await approveCurrent();
    const mcpActorId = createContentActorId("mcp-agent-scheduled");
    await database.batch([
      database
        .prepare(
          `INSERT INTO mcp_connections (
             id, actor_id, site_id, oauth_client_id, redirect_uri,
             scopes_json, status, created_by_membership_id, created_at
           ) VALUES (
             'connection-scheduled-claim', 'agent-scheduled', ?1,
             'client-scheduled', 'https://client.example/callback',
             '["site.read"]', 'active', ?2, ?3
           )`,
        )
        .bind(referenceSiteDefinition.site.id, actorId, beforeNow),
      database.prepare(
        `INSERT INTO mcp_connection_scopes (connection_id, scope)
         VALUES
           ('connection-scheduled-claim', 'site.read'),
           ('connection-scheduled-claim', 'content.draft'),
           ('connection-scheduled-claim', 'publication.schedule')`,
      ),
    ]);
    const authority = {
      kind: "mcp" as const,
      connectionId: "connection-scheduled-claim",
      actorId: "agent-scheduled",
      operation: "foundry.publication.schedule" as const,
      requiredScopes: ["publication.schedule", "content.draft"],
    };
    const scheduleStore = createD1BlogPostOperationsStore(database);
    const scheduleApp = createBlogPostOperationsApplication({
      store: scheduleStore,
      now: () => operationTime,
      createId: (kind) => `${kind}_scheduled_claim`,
      timeZoneDatabaseVersion: () => "2026a",
    });
    const schedule = await scheduleApp.commands.activateSchedule({
      actorId: mcpActorId,
      siteId: referenceSiteDefinition.site.id,
      postId,
      approvalId: approval.id,
      resolvedTime: {
        localDateTime: "2026-11-01T01:00:00",
        ianaTimeZone: "America/Vancouver",
        utcOffsetChoice: "-07:00",
        executeAtUtc: now,
      },
      idempotencyKey: "activate-scheduled-claim",
      authority,
    });
    operationTime = now;
    const claim = await scheduleApp.commands.claimDueSchedule(
      schedule.siteId,
      schedule.id,
    );
    const scheduledPublication = {
      id: createContentPublicationId(`publish_${"7".repeat(32)}`),
      workspaceId,
      revision: approval.revision,
      approvalId: approval.id,
      fingerprint: approval.fingerprint.value,
      idempotencyKey: claim.execution.publicationIdempotencyKey,
      requestedBy: mcpActorId,
      contributors: [actorId],
      expectedHead: "a".repeat(40),
      status: "requested" as const,
      commitSha: null,
      deploymentId: null,
      deploymentRequestedAt: null,
      detail: null,
      leaseToken: "scheduled-claim-lease",
      leaseExpiresAt: "2026-11-01T08:10:00.000Z",
      requestedAt: now,
      updatedAt: now,
    };

    await expect(
      createD1ContentPublicationStore(database).claimPublication(
        scheduledPublication,
        {
          executionId: claim.execution.executionId,
          attempt: claim.execution.attempt,
          leaseToken: claim.lease!.leaseToken,
        },
        authority,
      ),
    ).resolves.toMatchObject({ state: "claimed" });
    await expect(
      database
        .prepare(
          `SELECT mcp_operation, mcp_required_scopes_json
           FROM content_publications
           WHERE idempotency_key = ?1`,
        )
        .bind(scheduledPublication.idempotencyKey)
        .first(),
    ).resolves.toEqual({
      mcp_operation: "foundry.publication.schedule",
      mcp_required_scopes_json: JSON.stringify([
        "content.draft",
        "publication.schedule",
      ]),
    });
  });

  it("rejects stale publication reservation proof without consuming the stable key", async () => {
    const approval = await approveCurrent();
    const store = createD1BlogPostOperationsStore(database);
    const app = createBlogPostOperationsApplication({
      store,
      now: () => operationTime,
      createId: (kind) => `${kind}_reservation_proof`,
      timeZoneDatabaseVersion: () => "2026a",
    });
    const schedule = await app.commands.activateSchedule({
      actorId,
      siteId: referenceSiteDefinition.site.id,
      postId,
      approvalId: approval.id,
      resolvedTime: {
        localDateTime: "2026-11-01T01:00:00",
        ianaTimeZone: "America/Vancouver",
        utcOffsetChoice: "-07:00",
        executeAtUtc: now,
      },
      idempotencyKey: "activate-reservation-proof",
    });
    operationTime = now;
    const claim = await app.commands.claimDueSchedule(schedule.siteId, schedule.id);
    const publication = {
      id: createContentPublicationId(`publish_${"2".repeat(32)}`),
      workspaceId,
      revision: approval.revision,
      approvalId: approval.id,
      fingerprint: approval.fingerprint.value,
      idempotencyKey: claim.execution.publicationIdempotencyKey,
      requestedBy: membershipId,
      contributors: [actorId],
      expectedHead: "a".repeat(40),
      status: "requested" as const,
      commitSha: null,
      deploymentId: null,
      deploymentRequestedAt: null,
      detail: null,
      leaseToken: "content-publication-lease",
      leaseExpiresAt: "2026-11-01T08:10:00.000Z",
      requestedAt: now,
      updatedAt: now,
    };
    const publicationStore = createD1ContentPublicationStore(database);

    await expect(publicationStore.claimPublication(publication, {
      executionId: claim.execution.executionId,
      attempt: claim.execution.attempt,
      leaseToken: "stale-scheduler-lease",
    })).rejects.toMatchObject({ code: "publication_reservation_lost" });
    expect(
      await database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM content_publications
           WHERE idempotency_key = ?1`,
        )
        .bind(publication.idempotencyKey)
        .first<{ count: number }>(),
    ).toEqual({ count: 0 });

    await expect(publicationStore.claimPublication(publication, {
      executionId: claim.execution.executionId,
      attempt: claim.execution.attempt,
      leaseToken: claim.lease!.leaseToken,
    })).resolves.toMatchObject({ state: "claimed" });
    expect(
      await database
        .prepare(
          `SELECT state, attempt, lease_token
           FROM blog_post_schedule_publication_reservations
           WHERE execution_id = ?1`,
        )
        .bind(claim.execution.executionId)
        .first(),
    ).toEqual({
      state: "reserved",
      attempt: claim.execution.attempt,
      lease_token: claim.lease!.leaseToken,
    });

    await expect(publicationStore.renewPublicationLease({
      publicationId: publication.id,
      leaseToken: publication.leaseToken,
      now: "2026-11-01T08:01:00.000Z",
      leaseExpiresAt: "2026-11-01T08:11:00.000Z",
    })).resolves.toBe(false);
    await expect(publicationStore.renewPublicationLease({
      publicationId: publication.id,
      leaseToken: publication.leaseToken,
      now: "2026-11-01T08:06:00.000Z",
      leaseExpiresAt: "2026-11-01T08:11:00.000Z",
      reservationProof: {
        executionId: claim.execution.executionId,
        attempt: claim.execution.attempt,
        leaseToken: claim.lease!.leaseToken,
      },
    })).resolves.toBe(false);

    const failedPublication = {
      ...publication,
      status: "failed" as const,
      detail: "deployment_failed",
      leaseToken: null,
      leaseExpiresAt: null,
      updatedAt: "2026-11-01T08:00:30.000Z",
    };
    await publicationStore.updatePublication(failedPublication, {
      expectedLeaseToken: publication.leaseToken,
      expectedLeaseValidAt: now,
      reservationProof: {
        executionId: claim.execution.executionId,
        attempt: claim.execution.attempt,
        leaseToken: claim.lease!.leaseToken,
      },
    });
    const unfencedRetry = {
      ...failedPublication,
      status: "requested" as const,
      detail: "deployment_retry_dispatching",
      leaseToken: "unfenced-content-retry-lease",
      leaseExpiresAt: "2026-11-01T08:10:00.000Z",
      updatedAt: "2026-11-01T08:00:45.000Z",
    };
    await expect(publicationStore.updatePublication(unfencedRetry, {
      expectedStatus: "failed",
      expectedUpdatedAt: failedPublication.updatedAt,
    })).resolves.toMatchObject({ status: "failed" });
    await expect(publicationStore.updatePublication({
      ...unfencedRetry,
      updatedAt: "2026-11-01T08:06:00.000Z",
    }, {
      expectedStatus: "failed",
      expectedUpdatedAt: failedPublication.updatedAt,
      reservationProof: {
        executionId: claim.execution.executionId,
        attempt: claim.execution.attempt,
        leaseToken: claim.lease!.leaseToken,
      },
    })).resolves.toMatchObject({ status: "failed" });

    await store.recordExecutionOutcome({
      executionId: claim.execution.executionId,
      leaseToken: claim.lease!.leaseToken,
      attempt: claim.execution.attempt,
      outcomeId: "failed-before-reservation-reclaim",
      outcome: "failed",
      detail: "deployment_failed",
      updatedAt: "2026-11-01T08:01:00.000Z",
    });
    const reclaimed = await store.retryExecution({
      executionId: claim.execution.executionId,
      approvalAuthorityValid: true,
      leaseToken: "current-reclaimed-scheduler-lease",
      leaseExpiresAt: "2026-11-01T08:10:00.000Z",
      updatedAt: "2026-11-01T08:02:00.000Z",
      actorId,
      requestId: "reclaim-publication-reservation",
      retryKind: "human",
    });
    const retryingPublication = {
      ...failedPublication,
      status: "requested" as const,
      detail: "deployment_retry_dispatching",
      leaseToken: "content-retry-lease",
      leaseExpiresAt: "2026-11-01T08:07:00.000Z",
      updatedAt: "2026-11-01T08:02:00.000Z",
    };

    await expect(publicationStore.updatePublication(retryingPublication, {
      expectedStatus: "failed",
      expectedUpdatedAt: failedPublication.updatedAt,
      reservationProof: {
        executionId: claim.execution.executionId,
        attempt: claim.execution.attempt,
        leaseToken: claim.lease!.leaseToken,
      },
    })).resolves.toMatchObject({ status: "failed" });
    await expect(publicationStore.updatePublication(retryingPublication, {
      expectedStatus: "failed",
      expectedUpdatedAt: failedPublication.updatedAt,
      reservationProof: {
        executionId: reclaimed.execution.executionId,
        attempt: reclaimed.execution.attempt,
        leaseToken: reclaimed.leaseToken,
      },
    })).resolves.toMatchObject({
      status: "requested",
      detail: "deployment_retry_dispatching",
    });
  });

  it("advances a freshly reserved scheduled publication through the durable store", async () => {
    const approval = await approveCurrent();
    const scheduleApplication = createBlogPostOperationsApplication({
      store: createD1BlogPostOperationsStore(database),
      now: () => operationTime,
      createId: (kind) => `${kind}_fresh_scheduled_publication`,
      timeZoneDatabaseVersion: () => "2026a",
    });
    const schedule = await scheduleApplication.commands.activateSchedule({
      actorId,
      siteId: referenceSiteDefinition.site.id,
      postId,
      approvalId: approval.id,
      resolvedTime: {
        localDateTime: "2026-11-01T01:00:00",
        ianaTimeZone: "America/Vancouver",
        utcOffsetChoice: "-07:00",
        executeAtUtc: now,
      },
      idempotencyKey: "activate-fresh-scheduled-publication",
    });
    operationTime = now;
    const claim =
      await scheduleApplication.commands.claimDueSchedule(schedule.siteId, schedule.id);
    const publisher = {
      async getChannelConfigurationHash() {
        return "channel-a";
      },
      async getProductionHead() {
        return "a".repeat(40);
      },
      async isReleaseLive() {
        return true;
      },
      async createCommit({ assertLease }) {
        return (await assertLease())
          ? {
              state: "committed" as const,
              commitSha: "c".repeat(40),
            }
          : {
              state: "blocked" as const,
              detail: "publication_lease_lost",
            };
      },
      async reconcileCommit() {
        return { state: "not-found" as const };
      },
      async retryReference() {
        return {
          state: "failed" as const,
          detail: "unused",
        };
      },
      async getDeploymentStatus() {
        return "unknown" as const;
      },
      async retryDeployment() {
        return { state: "failed" as const };
      },
    } satisfies ContentPublisher;
    const publicationApplication = createContentPublicationApplication({
      store: createD1ContentPublicationStore(database),
      revisions: {
        getRevision: (targetWorkspaceId, revision) =>
          findContentRevision(database, targetWorkspaceId, revision),
        getCurrent: () => revisionApplication.queries.getCurrent(),
        isCurrent: (revision) =>
          revisionApplication.queries.isRevisionCurrent(revision),
        listContributors: async () => [actorId],
      },
      publisher,
      now: () => operationTime,
    });

    const publication = await publicationApplication.commands.publish({
      workspaceId,
      approvalId: approval.id,
      requestedBy: membershipId,
      idempotencyKey: claim.execution.publicationIdempotencyKey,
      reservationProof: {
        executionId: claim.execution.executionId,
        attempt: claim.execution.attempt,
        leaseToken: claim.lease!.leaseToken,
      },
    });

    expect(publication).toMatchObject({
      status: "committed",
      commitSha: "c".repeat(40),
      detail: null,
    });
    await expect(
      createD1ContentPublicationStore(database).findPublication(
        publication.id,
      ),
    ).resolves.toMatchObject({
      status: "committed",
      commitSha: "c".repeat(40),
    });
  });

  it("keeps an owned verified publication retryable until reconciliation runs", async () => {
    const approval = await approveCurrent();
    const store = createD1BlogPostOperationsStore(database);
    const app = createBlogPostOperationsApplication({
      store,
      now: () => operationTime,
      createId: (kind) => `${kind}_verified_reconcile`,
      timeZoneDatabaseVersion: () => "2026a",
    });
    const schedule = await app.commands.activateSchedule({
      actorId,
      siteId: referenceSiteDefinition.site.id,
      postId,
      approvalId: approval.id,
      resolvedTime: {
        localDateTime: "2026-11-01T01:00:00",
        ianaTimeZone: "America/Vancouver",
        utcOffsetChoice: "-07:00",
        executeAtUtc: now,
      },
      idempotencyKey: "activate-owned-verified-reconcile",
    });
    operationTime = now;
    const claim = await app.commands.claimDueSchedule(schedule.siteId, schedule.id);
    await createD1ContentPublicationStore(database).claimPublication({
      id: createContentPublicationId(`publish_${"1".repeat(32)}`),
      workspaceId,
      revision: approval.revision,
      approvalId: approval.id,
      fingerprint: approval.fingerprint.value,
      idempotencyKey: claim.execution.publicationIdempotencyKey,
      requestedBy: membershipId,
      contributors: [actorId],
      expectedHead: "a".repeat(40),
      status: "verified-live",
      commitSha: "d".repeat(40),
      deploymentId: "deployment-owned-verified",
      deploymentRequestedAt: now,
      detail: null,
      leaseToken: null,
      leaseExpiresAt: null,
      requestedAt: now,
      updatedAt: now,
    }, {
      executionId: claim.execution.executionId,
      attempt: claim.execution.attempt,
      leaseToken: claim.lease!.leaseToken,
    });
    await database
      .prepare(
        `UPDATE blog_posts
         SET version = version + 1
         WHERE site_id = ?1 AND post_id = ?2`,
      )
      .bind(referenceSiteDefinition.site.id, postId)
      .run();

    operationTime = now;
    await expect(
      app.commands.claimDueSchedule(schedule.siteId, schedule.id),
    ).resolves.toMatchObject({
      execution: {
        executionId: claim.execution.executionId,
        state: "claimed",
      },
      lease: null,
    });
    const recovery = createBlogPostOperationsApplication({
      store,
      now: () => "2026-11-01T08:06:00.000Z",
      createId: (kind) => `${kind}_verified_reconcile_retry`,
      timeZoneDatabaseVersion: () => "2026a",
      validateApprovalAuthority: async (
        checkedApprovalId,
        ownedPublicationIdempotencyKey,
      ) =>
        checkedApprovalId === approval.id &&
        ownedPublicationIdempotencyKey ===
          claim.execution.publicationIdempotencyKey,
    });
    const reconciler = await recovery.commands.retryExecutionAsScheduler(
      referenceSiteDefinition.site.id,
      postId,
      claim.execution.executionId,
      "reconcile-owned-verified-publication",
    );
    expect(reconciler).toMatchObject({
      execution: {
        executionId: claim.execution.executionId,
        attempt: 2,
        state: "claimed",
      },
    });
    expect(
      await database
        .prepare(
          `SELECT state
           FROM blog_post_schedule_publication_reservations
           WHERE execution_id = ?1`,
        )
        .bind(claim.execution.executionId)
        .first(),
    ).toEqual({ state: "reserved" });
  });

  it("keeps lease ownership private and rejects stale scheduler outcomes", async () => {
    const approval = await approveCurrent();
    const store = createD1BlogPostOperationsStore(database);
    const app = createBlogPostOperationsApplication({
      store,
      now: () => operationTime,
      createId: (kind) => `${kind}_lease_fencing`,
      timeZoneDatabaseVersion: () => "2026a",
    });
    const schedule = await app.commands.activateSchedule({
      actorId,
      siteId: referenceSiteDefinition.site.id,
      postId,
      approvalId: approval.id,
      resolvedTime: {
        localDateTime: "2026-11-01T01:00:00",
        ianaTimeZone: "America/Vancouver",
        utcOffsetChoice: "-07:00",
        executeAtUtc: now,
      },
      idempotencyKey: "activate-lease-fencing",
    });
    operationTime = now;
    const claim = await app.commands.claimDueSchedule(schedule.siteId, schedule.id);

    expect(claim.lease).not.toBeNull();
    expect(await store.findExecution(claim.execution.executionId))
      .not.toHaveProperty("leaseToken");
    await expect(
      store.recordExecutionOutcome({
        executionId: claim.execution.executionId,
        leaseToken: "losing-claimant-token",
        attempt: claim.execution.attempt,
        outcomeId: "lease-fencing-loser",
        outcome: "completed",
        detail: null,
        updatedAt: "2026-11-01T08:01:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "execution_lease_lost" });
    await expect(
      app.commands.recordExecutionOutcome({
        lease: {
          siteId: schedule.siteId,
          postId: schedule.postId,
          execution: claim.execution,
          leaseToken: "application-losing-token",
        },
        outcomeId: "application-lease-loss",
        outcome: "completed",
        detail: null,
      }),
    ).rejects.toMatchObject({ code: "execution_lease_lost" });
    expect(
      await database
        .prepare(
          `SELECT outcome, reason_code
           FROM blog_post_operation_audit_events
           WHERE request_id = 'application-lease-loss'`,
        )
        .first(),
    ).toEqual({
      outcome: "rejected",
      reason_code: "execution_lease_lost",
    });
    const completed = await store.recordExecutionOutcome({
      executionId: claim.execution.executionId,
      leaseToken: claim.lease!.leaseToken,
      attempt: claim.execution.attempt,
      outcomeId: "lease-fencing-completed",
      outcome: "completed",
      detail: null,
      updatedAt: "2026-11-01T08:01:00.000Z",
    });
    await expect(
      store.recordExecutionOutcome({
        executionId: claim.execution.executionId,
        leaseToken: claim.lease!.leaseToken,
        attempt: claim.execution.attempt,
        outcomeId: "lease-fencing-completed",
        outcome: "completed",
        detail: null,
        updatedAt: "2026-11-01T09:00:00.000Z",
      }),
    ).resolves.toEqual(completed);
    await expect(
      store.recordExecutionOutcome({
        executionId: claim.execution.executionId,
        leaseToken: claim.lease!.leaseToken,
        attempt: claim.execution.attempt,
        outcomeId: "lease-fencing-expired",
        outcome: "completed",
        detail: null,
        updatedAt: claim.execution.leaseExpiresAt,
      }),
    ).rejects.toMatchObject({ code: "execution_lease_lost" });
  });

  it("binds outcome receipts to one durable execution attempt", async () => {
    const approval = await approveCurrent();
    const store = createD1BlogPostOperationsStore(database);
    const app = createBlogPostOperationsApplication({
      store,
      now: () => operationTime,
      createId: (kind) => `${kind}_attempt_receipt`,
      timeZoneDatabaseVersion: () => "2026a",
    });
    const schedule = await app.commands.activateSchedule({
      actorId,
      siteId: referenceSiteDefinition.site.id,
      postId,
      approvalId: approval.id,
      resolvedTime: {
        localDateTime: "2026-11-01T01:00:00",
        ianaTimeZone: "America/Vancouver",
        utcOffsetChoice: "-07:00",
        executeAtUtc: now,
      },
      idempotencyKey: "activate-attempt-receipt",
    });
    operationTime = now;
    const claim = await app.commands.claimDueSchedule(schedule.siteId, schedule.id);
    const first = await store.recordExecutionOutcome({
      executionId: claim.execution.executionId,
      leaseToken: claim.lease!.leaseToken,
      attempt: claim.execution.attempt,
      outcomeId: "attempt-one-outcome",
      outcome: "unknown",
      detail: "publication_result_unknown",
      updatedAt: "2026-11-01T08:01:00.000Z",
    });
    const retry = await store.retryExecution({
      executionId: claim.execution.executionId,
      approvalAuthorityValid: true,
      leaseToken: "attempt-two-lease",
      leaseExpiresAt: "2026-11-01T08:10:00.000Z",
      updatedAt: "2026-11-01T08:02:00.000Z",
      actorId,
      requestId: "attempt-two-retry",
      retryKind: "scheduler",
    });

    await expect(store.recordExecutionOutcome({
      executionId: claim.execution.executionId,
      leaseToken: claim.lease!.leaseToken,
      attempt: claim.execution.attempt,
      outcomeId: "attempt-one-outcome",
      outcome: "unknown",
      detail: "publication_result_unknown",
      updatedAt: "2026-11-01T09:00:00.000Z",
    })).resolves.toEqual(first);
    expect(await store.findExecution(claim.execution.executionId))
      .toMatchObject({ attempt: 2, state: "claimed" });
    await expect(store.recordExecutionOutcome({
      executionId: claim.execution.executionId,
      leaseToken: retry.leaseToken,
      attempt: retry.execution.attempt,
      outcomeId: "attempt-two-outcome",
      outcome: "completed",
      detail: null,
      updatedAt: "2026-11-01T08:03:00.000Z",
    })).resolves.toMatchObject({ attempt: 2, state: "completed" });
  });

  it("keeps a conflicting concurrent outcome from overwriting the winning receipt", async () => {
    const approval = await approveCurrent();
    const setupStore = createD1BlogPostOperationsStore(database);
    const setup = createBlogPostOperationsApplication({
      store: setupStore,
      now: () => operationTime,
      timeZoneDatabaseVersion: () => "2026a",
    });
    const schedule = await setup.commands.activateSchedule({
      actorId,
      siteId: referenceSiteDefinition.site.id,
      postId,
      approvalId: approval.id,
      resolvedTime: {
        localDateTime: "2026-11-01T01:00:00",
        ianaTimeZone: "America/Vancouver",
        utcOffsetChoice: "-07:00",
        executeAtUtc: now,
      },
      idempotencyKey: "activate-conflicting-outcome-race",
    });
    operationTime = now;
    const claim = await setup.commands.claimDueSchedule(
      schedule.siteId,
      schedule.id,
    );
    let batchArrivals = 0;
    let releaseBatches!: () => void;
    const bothBatchesArrived = new Promise<void>((resolve) => {
      releaseBatches = resolve;
    });
    const racingStore = () => {
      const racedDatabase = new Proxy(database, {
        get(target, property) {
          if (property === "batch") {
            return async (
              statements: Parameters<typeof database.batch>[0],
            ) => {
              batchArrivals += 1;
              if (batchArrivals === 2) {
                releaseBatches();
              }
              await bothBatchesArrived;
              return database.batch(statements);
            };
          }
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      return createD1BlogPostOperationsStore(racedDatabase);
    };
    const competitors = [
      createBlogPostOperationsApplication({
        store: racingStore(),
        now: () => "2026-11-01T08:01:00.000Z",
      }),
      createBlogPostOperationsApplication({
        store: racingStore(),
        now: () => "2026-11-01T08:01:00.000Z",
      }),
    ];

    const outcomes = await Promise.allSettled([
      competitors[0]!.commands.recordExecutionOutcome({
        lease: claim.lease!,
        outcomeId: "conflicting-concurrent-outcome",
        outcome: "completed",
        detail: null,
      }),
      competitors[1]!.commands.recordExecutionOutcome({
        lease: claim.lease!,
        outcomeId: "conflicting-concurrent-outcome",
        outcome: "failed",
        detail: "deployment_failed",
      }),
    ]);
    const winner = outcomes.find(
      (
        result,
      ): result is PromiseFulfilledResult<
        Awaited<ReturnType<
          typeof competitors[0]["commands"]["recordExecutionOutcome"]
        >>
      > => result.status === "fulfilled",
    );
    const loser = outcomes.find(
      (result): result is PromiseRejectedResult =>
        result.status === "rejected",
    );

    expect(winner).toBeDefined();
    expect(loser?.reason).toMatchObject({
      code: "idempotency_key_conflict",
    });
    const receipt = await database
      .prepare(
        `SELECT outcome, detail
         FROM blog_post_schedule_execution_outcomes
         WHERE outcome_id = 'conflicting-concurrent-outcome'`,
      )
      .first<{ outcome: "completed" | "failed"; detail: string | null }>();
    expect(receipt).toEqual({
      outcome: winner!.value.state,
      detail: winner!.value.detail,
    });
    await expect(
      setupStore.findExecution(claim.execution.executionId),
    ).resolves.toMatchObject({
      state: receipt!.outcome,
      detail: receipt!.detail,
    });
    await expect(setupStore.findSchedule(schedule.id)).resolves.toMatchObject({
      state: receipt!.outcome,
      detail: receipt!.detail,
    });
    expect(
      await database
        .prepare(
          `SELECT outcome, reason_code
           FROM blog_post_operation_audit_events
           WHERE command_type = 'blog.post.schedule.outcome'
             AND request_id = 'conflicting-concurrent-outcome'
           ORDER BY outcome`,
        )
        .all(),
    ).toMatchObject({
      results: [
        { outcome: "accepted", reason_code: "accepted" },
        {
          outcome: "rejected",
          reason_code: "idempotency_key_conflict",
        },
      ],
    });
  });

  it("replays append-only retry attribution after later attempts", async () => {
    const approval = await approveCurrent();
    await database.batch([
      database
        .prepare(
          `INSERT INTO human_users (id, email, created_at)
           VALUES ('user-editor-a', 'editor-a@example.com', ?1),
                  ('user-editor-b', 'editor-b@example.com', ?1)`,
        )
        .bind(now),
      database
        .prepare(
          `INSERT INTO human_memberships (
             id, site_id, user_id, email, identity_issuer,
             identity_subject, role, status, created_at, updated_at
           ) VALUES (
             'membership-editor-a', ?1, 'user-editor-a',
             'editor-a@example.com', 'https://access.example.com',
             'editor-a', 'editor', 'active', ?2, ?2
           ), (
             'membership-editor-b', ?1, 'user-editor-b',
             'editor-b@example.com', 'https://access.example.com',
             'editor-b', 'editor', 'active', ?2, ?2
           )`,
        )
        .bind(referenceSiteDefinition.site.id, now),
    ]);
    const store = createD1BlogPostOperationsStore(database);
    const app = createBlogPostOperationsApplication({
      store,
      now: () => operationTime,
      createId: (kind) => `${kind}_retry_receipt`,
      timeZoneDatabaseVersion: () => "2026a",
    });
    const schedule = await app.commands.activateSchedule({
      actorId,
      siteId: referenceSiteDefinition.site.id,
      postId,
      approvalId: approval.id,
      resolvedTime: {
        localDateTime: "2026-11-01T01:00:00",
        ianaTimeZone: "America/Vancouver",
        utcOffsetChoice: "-07:00",
        executeAtUtc: now,
      },
      idempotencyKey: "activate-retry-receipt",
    });
    operationTime = now;
    const claim = await app.commands.claimDueSchedule(schedule.siteId, schedule.id);
    await store.recordExecutionOutcome({
      executionId: claim.execution.executionId,
      leaseToken: claim.lease!.leaseToken,
      attempt: 1,
      outcomeId: "retry-receipt-attempt-one-failed",
      outcome: "failed",
      detail: "deployment_failed",
      updatedAt: "2026-11-01T08:01:00.000Z",
    });
    const retryA = await store.retryExecution({
      executionId: claim.execution.executionId,
      approvalAuthorityValid: true,
      leaseToken: "retry-receipt-a-lease",
      leaseExpiresAt: "2026-11-01T08:08:00.000Z",
      updatedAt: "2026-11-01T08:02:00.000Z",
      actorId: "membership-editor-a",
      requestId: "retry-receipt-request-a",
      retryKind: "human",
    });
    await store.recordExecutionOutcome({
      executionId: claim.execution.executionId,
      leaseToken: retryA.leaseToken,
      attempt: retryA.execution.attempt,
      outcomeId: "retry-receipt-attempt-two-failed",
      outcome: "failed",
      detail: "deployment_failed_again",
      updatedAt: "2026-11-01T08:03:00.000Z",
    });
    const retryB = await store.retryExecution({
      executionId: claim.execution.executionId,
      approvalAuthorityValid: true,
      leaseToken: "retry-receipt-b-lease",
      leaseExpiresAt: "2026-11-01T08:09:00.000Z",
      updatedAt: "2026-11-01T08:04:00.000Z",
      actorId: "membership-editor-b",
      requestId: "retry-receipt-request-b",
      retryKind: "human",
    });
    const replayA = await store.retryExecution({
      executionId: claim.execution.executionId,
      approvalAuthorityValid: true,
      leaseToken: "ignored-replay-lease",
      leaseExpiresAt: "2026-11-01T08:10:00.000Z",
      updatedAt: "2026-11-01T08:05:00.000Z",
      actorId: "membership-editor-a",
      requestId: "retry-receipt-request-a",
      retryKind: "human",
    });

    expect(retryB.execution.attempt).toBe(3);
    expect(replayA).toMatchObject({
      replayed: true,
      leaseToken: "retry-receipt-a-lease",
      execution: {
        attempt: 2,
        attemptActorId: "membership-editor-a",
        attemptRequestId: "retry-receipt-request-a",
      },
    });
    expect(
      await store.findExecution(claim.execution.executionId),
    ).toMatchObject({ attempt: 3 });
    await expect(store.retryExecution({
      executionId: claim.execution.executionId,
      approvalAuthorityValid: true,
      leaseToken: "conflicting-replay-lease",
      leaseExpiresAt: "2026-11-01T08:11:00.000Z",
      updatedAt: "2026-11-01T08:06:00.000Z",
      actorId: "membership-editor-c",
      requestId: "retry-receipt-request-a",
      retryKind: "human",
    })).rejects.toMatchObject({ code: "idempotency_key_conflict" });
    expect(
      await database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM blog_post_operation_audit_events
           WHERE command_type = 'blog.post.schedule.retry'
             AND request_id = 'retry-receipt-request-a'
             AND outcome = 'accepted'`,
        )
        .first<{ count: number }>(),
    ).toEqual({ count: 1 });
  });

  it("rejects a human retry when role authority is revoked after preflight", async () => {
    const approval = await approveCurrent();
    const durableStore = createD1BlogPostOperationsStore(database);
    const setup = createBlogPostOperationsApplication({
      store: durableStore,
      now: () => operationTime,
      createId: (kind) => `${kind}_retry_role_race`,
      timeZoneDatabaseVersion: () => "2026a",
    });
    const schedule = await setup.commands.activateSchedule({
      actorId,
      siteId: referenceSiteDefinition.site.id,
      postId,
      approvalId: approval.id,
      resolvedTime: {
        localDateTime: "2026-11-01T01:00:00",
        ianaTimeZone: "America/Vancouver",
        utcOffsetChoice: "-07:00",
        executeAtUtc: now,
      },
      idempotencyKey: "activate-retry-role-race",
    });
    operationTime = now;
    const claim = await setup.commands.claimDueSchedule(
      schedule.siteId,
      schedule.id,
    );
    await durableStore.recordExecutionOutcome({
      executionId: claim.execution.executionId,
      leaseToken: claim.lease!.leaseToken,
      attempt: claim.execution.attempt,
      outcomeId: "retry-role-race-failed",
      outcome: "failed",
      detail: "deployment_failed",
      updatedAt: "2026-11-01T08:01:00.000Z",
    });
    let injectRace = true;
    const racedStore = {
      ...durableStore,
      async retryExecution(
        input: Parameters<typeof durableStore.retryExecution>[0],
      ) {
        if (injectRace) {
          injectRace = false;
          await database
            .prepare(
              `UPDATE human_memberships
               SET status = 'suspended', updated_at = ?1
               WHERE site_id = ?2 AND id = ?3`,
            )
            .bind(
              "2026-11-01T08:02:00.000Z",
              referenceSiteDefinition.site.id,
              actorId,
            )
            .run();
        }
        return durableStore.retryExecution(input);
      },
    };
    operationTime = "2026-11-01T08:02:00.000Z";
    const racedApplication = createBlogPostOperationsApplication({
      store: racedStore,
      now: () => operationTime,
      validateApprovalAuthority: async () => true,
    });

    await expect(racedApplication.commands.retryExecution(
      schedule.siteId,
      schedule.postId,
      claim.execution.executionId,
      actorId,
      "retry-after-role-revocation",
    )).rejects.toMatchObject({ code: "human_authority_required" });
    await expect(
      durableStore.findExecution(claim.execution.executionId),
    ).resolves.toMatchObject({
      attempt: 1,
      state: "failed",
      detail: "deployment_failed",
    });
    expect(
      await database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM blog_post_schedule_retry_receipts
           WHERE request_id = 'retry-after-role-revocation'`,
        )
        .first<{ count: number }>(),
    ).toEqual({ count: 0 });
  });

  it("projects direct approval invalidation as editing with audit evidence", async () => {
    const approval = await approveCurrent();
    const store = createD1BlogPostOperationsStore(database);
    const app = createBlogPostOperationsApplication({
      store,
      now: () => operationTime,
      createId: (kind) => `${kind}_approval_invalidation`,
      timeZoneDatabaseVersion: () => "2026a",
    });
    const schedule = await app.commands.activateSchedule({
      actorId,
      siteId: referenceSiteDefinition.site.id,
      postId,
      approvalId: approval.id,
      resolvedTime: {
        localDateTime: "2026-11-01T01:00:00",
        ianaTimeZone: "America/Vancouver",
        utcOffsetChoice: "-07:00",
        executeAtUtc: now,
      },
      idempotencyKey: "activate-before-direct-invalidation",
    });
    operationTime = now;
    const claim = await app.commands.claimDueSchedule(schedule.siteId, schedule.id);
    await store.recordExecutionOutcome({
      executionId: claim.execution.executionId,
      leaseToken: claim.lease!.leaseToken,
      attempt: claim.execution.attempt,
      outcomeId: "unknown-before-approval-invalidation",
      outcome: "unknown",
      detail: "publication_result_unknown",
      updatedAt: "2026-11-01T08:01:00.000Z",
    });
    await expect(
      database
        .prepare(
          `UPDATE blog_post_schedule_execution_outcomes
           SET detail = 'tampered'
           WHERE site_id = ?1 AND outcome_id = ?2`,
        )
        .bind(
          referenceSiteDefinition.site.id,
          "unknown-before-approval-invalidation",
        )
        .run(),
    ).rejects.toThrow(
      "blog_post_schedule_execution_outcome_is_immutable",
    );
    await expect(
      database
        .prepare(
          `DELETE FROM blog_post_schedule_execution_outcomes
           WHERE site_id = ?1 AND outcome_id = ?2`,
        )
        .bind(
          referenceSiteDefinition.site.id,
          "unknown-before-approval-invalidation",
        )
        .run(),
    ).rejects.toThrow(
      "blog_post_schedule_execution_outcome_is_immutable",
    );

    await database
      .prepare(
        `INSERT INTO content_approval_invalidations (
           approval_id, invalidated_at, reason
         ) VALUES (?1, ?2, 'production_changed')`,
      )
      .bind(approval.id, "2026-11-01T08:10:00.000Z")
      .run();

    expect(await app.queries.getSchedule(
      referenceSiteDefinition.site.id,
      schedule.id,
    )).toMatchObject({
      state: "cancelled",
      detail: "approval_invalidated",
    });
    expect(await app.queries.getExecution(
      referenceSiteDefinition.site.id,
      claim.execution.executionId,
    ))
      .toMatchObject({
        state: "blocked",
        detail: "approval_invalidated",
      });
    expect(
      await database
        .prepare(
          `SELECT outcome
           FROM blog_post_schedule_execution_outcomes
           WHERE outcome_id = 'unknown-before-approval-invalidation'`,
        )
        .first(),
    ).toEqual({ outcome: "unknown" });
    expect(
      await database
        .prepare(
          `SELECT from_state, to_state, detail
           FROM blog_post_schedule_execution_events
           WHERE execution_id = ?1
             AND detail = 'approval_invalidated'`,
        )
        .bind(claim.execution.executionId)
        .first(),
    ).toEqual({
      from_state: "unknown",
      to_state: "blocked",
      detail: "approval_invalidated",
    });
    expect(
      await database
        .prepare(
          `SELECT state
           FROM blog_post_schedule_publication_reservations
           WHERE execution_id = ?1`,
        )
        .bind(claim.execution.executionId)
        .first(),
    ).toEqual({ state: "released" });
    await expect(
      app.commands.recordExecutionOutcome({
        lease: claim.lease!,
        outcomeId: "late-invalidated-outcome",
        outcome: "completed",
        detail: null,
      }),
    ).rejects.toMatchObject({ code: "execution_lease_lost" });
    expect(
      await database
        .prepare(
          `SELECT workflow_state FROM blog_post_collection_states
           WHERE site_id = ?1 AND post_id = ?2`,
        )
        .bind(referenceSiteDefinition.site.id, postId)
        .first(),
    ).toEqual({ workflow_state: "editing" });
    expect(
      await database
        .prepare(
          `SELECT outcome, reason_code,
                  json_extract(before_state_json, '$.state') AS before_state,
                  json_extract(after_state_json, '$.executionState')
                    AS execution_state
           FROM blog_post_operation_audit_events
           WHERE command_type = 'blog.post.schedule.invalidate'`,
        )
        .first(),
    ).toEqual({
      outcome: "accepted",
      reason_code: "approval_invalidated",
      before_state: "unknown",
      execution_state: "blocked",
    });
  });

  it("preserves unknown execution truth until archive can reconcile it", async () => {
    const approval = await approveCurrent();
    const store = createD1BlogPostOperationsStore(database);
    const app = createBlogPostOperationsApplication({
      store,
      now: () => operationTime,
      createId: (kind) => `${kind}_archive_in_flight`,
      timeZoneDatabaseVersion: () => "2026a",
    });
    const schedule = await app.commands.activateSchedule({
      actorId,
      siteId: referenceSiteDefinition.site.id,
      postId,
      approvalId: approval.id,
      resolvedTime: {
        localDateTime: "2026-11-01T01:00:00",
        ianaTimeZone: "America/Vancouver",
        utcOffsetChoice: "-07:00",
        executeAtUtc: now,
      },
      idempotencyKey: "activate-before-in-flight-archive",
    });
    operationTime = now;
    const claim = await app.commands.claimDueSchedule(schedule.siteId, schedule.id);
    await app.commands.recordExecutionOutcome({
      lease: claim.lease!,
      outcomeId: "unknown-before-in-flight-archive",
      outcome: "unknown",
      detail: "publication_result_unknown",
    });
    const post = await store.findPost(
      referenceSiteDefinition.site.id,
      postId,
    );

    await expect(app.commands.archive({
      actorId,
      siteId: referenceSiteDefinition.site.id,
      postId,
      selectedPostRevisionId: post!.postRevisionId,
      idempotencyKey: "archive-in-flight-schedule",
    })).rejects.toMatchObject({
      code: "production_operation_in_progress",
    });

    await expect(app.queries.getSchedule(
      referenceSiteDefinition.site.id,
      schedule.id,
    )).resolves.toMatchObject({
      state: "unknown",
      detail: "publication_result_unknown",
    });
    await expect(
      app.queries.getExecution(
        referenceSiteDefinition.site.id,
        claim.execution.executionId,
      ),
    ).resolves.toMatchObject({
      state: "unknown",
      detail: "publication_result_unknown",
    });
    expect(
      await database
        .prepare(
          `SELECT state
           FROM blog_post_schedule_publication_reservations
           WHERE execution_id = ?1`,
        )
        .bind(claim.execution.executionId)
        .first(),
    ).toEqual({ state: "reserved" });
    expect(
      await database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM blog_post_schedule_execution_events
           WHERE execution_id = ?1 AND detail = 'post_archived'`,
        )
        .bind(claim.execution.executionId)
        .first<{ count: number }>(),
    ).toEqual({ count: 0 });
    expect(
      await database
        .prepare(
          `SELECT reason
           FROM content_approval_invalidations
           WHERE approval_id = ?1`,
        )
        .bind(approval.id)
        .first(),
    ).toBeNull();
  });

  it("rejects rescheduling while the prior execution is in flight", async () => {
    const approval = await approveCurrent();
    const store = createD1BlogPostOperationsStore(database);
    const app = createBlogPostOperationsApplication({
      store,
      now: () => operationTime,
      createId: (() => {
        let sequence = 0;
        return (kind: string) => `${kind}_in_flight_${++sequence}`;
      })(),
      timeZoneDatabaseVersion: () => "2026a",
    });
    const first = await app.commands.activateSchedule({
      actorId,
      siteId: referenceSiteDefinition.site.id,
      postId,
      approvalId: approval.id,
      resolvedTime: {
        localDateTime: "2026-11-01T01:00:00",
        ianaTimeZone: "America/Vancouver",
        utcOffsetChoice: "-07:00",
        executeAtUtc: now,
      },
      idempotencyKey: "activate-first-in-flight-schedule",
    });
    operationTime = now;
    await app.commands.claimDueSchedule(first.siteId, first.id);

    await expect(app.commands.activateSchedule({
      actorId,
      siteId: referenceSiteDefinition.site.id,
      postId,
      approvalId: approval.id,
      resolvedTime: {
        localDateTime: "2026-11-01T01:05:00",
        ianaTimeZone: "America/Vancouver",
        utcOffsetChoice: "-07:00",
        executeAtUtc: "2026-11-01T08:05:00.000Z",
      },
      idempotencyKey: "activate-replacement-in-flight-schedule",
    })).rejects.toMatchObject({
      code: "production_operation_in_progress",
    });
    await expect(app.queries.getSchedule(
      referenceSiteDefinition.site.id,
      first.id,
    )).resolves.toMatchObject({
      state: "claimed",
    });
    expect(
      await database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM blog_post_schedules
           WHERE site_id = ?1 AND post_id = ?2`,
        )
        .bind(referenceSiteDefinition.site.id, postId)
        .first<{ count: number }>(),
    ).toEqual({ count: 1 });
  });

  it("atomically cancels the active schedule when an edit inserts a successor revision", async () => {
    const approval = await approveCurrent();
    const app = createBlogPostOperationsApplication({
      store: createD1BlogPostOperationsStore(database),
      now: () => operationTime,
      createId: (kind) => `${kind}_edit`,
      timeZoneDatabaseVersion: () => "2026a",
    });
    const schedule = await app.commands.activateSchedule({
      actorId,
      siteId: referenceSiteDefinition.site.id,
      postId,
      approvalId: approval.id,
      resolvedTime: {
        localDateTime: "2026-11-01T01:30:00",
        ianaTimeZone: "America/Vancouver",
        utcOffsetChoice: "-07:00",
        executeAtUtc: "2026-11-01T08:30:00.000Z",
      },
      idempotencyKey: "activate-before-blog-edit",
    });

    await revisionApplication.commands.save({
      actorId,
      workspaceId,
      schemaVersion: referenceSiteDefinition.schemaVersion,
      baseRevision: 1,
      edits: [{ path: `${postId}.title`, value: "Edited after approval" }],
      idempotencyKey: "edit-invalidates-schedule",
    });

    expect(await app.queries.getSchedule(
      referenceSiteDefinition.site.id,
      schedule.id,
    )).toMatchObject({
      state: "cancelled",
      detail: "revision_changed",
    });
    operationTime = now;
    await expect(
      app.commands.claimDueSchedule(schedule.siteId, schedule.id),
    ).rejects.toMatchObject({ code: "schedule_inactive" });
    expect(
      await database
        .prepare(
          `SELECT actor_id, outcome, reason_code
           FROM blog_post_operation_audit_events
           WHERE command_type = 'blog.post.schedule.invalidate'
             AND reason_code = 'revision_changed'`,
        )
        .first(),
    ).toEqual({
      actor_id: actorId,
      outcome: "accepted",
      reason_code: "revision_changed",
    });
  });

  it("creates the bound withdrawal revision after a live archive enters archiving", async () => {
    await database
      .prepare(
        `UPDATE blog_posts
         SET live_revision = current_revision,
             last_verified_revision = current_revision,
             last_verified_visibility = 'public',
             version = version + 1
         WHERE site_id = ?1 AND post_id = ?2`,
      )
      .bind(referenceSiteDefinition.site.id, postId)
      .run();
    const store = createD1BlogPostOperationsStore(database);
    const app = createBlogPostOperationsApplication({
      store,
      now: () => operationTime,
      createId: (kind) => `${kind}_archive_withdrawal`,
      timeZoneDatabaseVersion: () => "2026a",
    });
    const post = await store.findPost(
      referenceSiteDefinition.site.id,
      postId,
    );
    await app.commands.archive({
      actorId,
      siteId: referenceSiteDefinition.site.id,
      postId,
      selectedPostRevisionId: post!.postRevisionId,
      idempotencyKey: "archive-before-withdrawal-draft",
    });
    await app.commands.bindArchiveWithdrawalDraft({
      siteId: referenceSiteDefinition.site.id,
      postId,
      workspaceId,
      contentRevision: 2,
      createdBy: actorId,
      requestId: "archive-before-withdrawal-draft",
      occurredAt: now,
    });

    await expect(revisionApplication.commands.unpublishBlogPost({
      actorId,
      workspaceId,
      siteId: referenceSiteDefinition.site.id,
      schemaVersion: referenceSiteDefinition.schemaVersion,
      baseRevision: 1,
      postId,
      idempotencyKey: "create-bound-archive-withdrawal",
    })).resolves.toMatchObject({
      revision: 2,
      definition: {
        blog: {
          posts: [
            expect.objectContaining({
              id: postId,
              targetVisibility: "unpublished",
            }),
          ],
        },
      },
    });
  });

  it("ignores unrelated parallel saves but cancels an equal-number post edit", async () => {
    const approval = await approveCurrent();
    const app = createBlogPostOperationsApplication({
      store: createD1BlogPostOperationsStore(database),
      now: () => operationTime,
      createId: (kind) => `${kind}_cross_workspace_edit`,
      timeZoneDatabaseVersion: () => "2026a",
    });
    const schedule = await app.commands.activateSchedule({
      actorId,
      siteId: referenceSiteDefinition.site.id,
      postId,
      approvalId: approval.id,
      resolvedTime: {
        localDateTime: "2026-11-01T01:00:00",
        ianaTimeZone: "America/Vancouver",
        utcOffsetChoice: "-07:00",
        executeAtUtc: now,
      },
      idempotencyKey: "activate-before-cross-workspace-edit",
    });
    const sourceRevision = await database
      .prepare(
        `SELECT definition_json
         FROM content_revisions
         WHERE workspace_id = ?1 AND revision = ?2`,
      )
      .bind(workspaceId, approval.revision)
      .first<{ definition_json: string }>();
    const sourceDefinition = JSON.parse(
      sourceRevision!.definition_json,
    ) as typeof referenceSiteDefinition;
    const unrelatedDefinition = {
      ...sourceDefinition,
      site: {
        ...sourceDefinition.site,
        footer: "Unrelated parallel footer edit",
      },
    };
    const successorDefinition = {
      ...unrelatedDefinition,
      blog: {
        ...unrelatedDefinition.blog,
        posts: unrelatedDefinition.blog.posts.map(
          (post) => post.id === postId
            ? { ...post, title: "Equal-number divergent branch" }
            : post,
        ),
      },
    };
    const successorWorkspaceId = createContentWorkspaceId(
      "workspace_cross_successor",
    );
    await database.batch([
      database
        .prepare(
          `INSERT INTO content_workspaces (
             workspace_id, site_id, owner_actor_id, production_base,
             schema_version, renderer_version, current_revision,
             current_content_hash, lifecycle, created_at, updated_at
           )
           SELECT
             ?1, site_id, owner_actor_id, production_base,
             schema_version, renderer_version, 0,
             current_content_hash, 'open', ?2, ?2
           FROM content_workspaces
           WHERE workspace_id = ?3`,
        )
        .bind(successorWorkspaceId, now, workspaceId),
      database
        .prepare(
          `INSERT INTO content_revisions (
             workspace_id, revision, definition_json, content_hash,
             schema_version, renderer_version, production_base,
             request_hash, created_at, created_by
           )
           SELECT
             ?1, 0, definition_json, content_hash,
             schema_version, renderer_version, production_base,
             'cross-workspace-base', ?2, ?3
           FROM content_revisions
           WHERE workspace_id = ?4 AND revision = ?5`,
        )
        .bind(
          successorWorkspaceId,
          now,
          actorId,
          workspaceId,
          approval.revision,
        ),
      database
        .prepare(
          `UPDATE content_workspaces
           SET current_revision = 1,
               current_content_hash = 'cross-workspace-unrelated',
               updated_at = ?2
           WHERE workspace_id = ?1`,
        )
        .bind(successorWorkspaceId, "2026-11-01T08:01:00.000Z"),
      database
        .prepare(
          `INSERT INTO content_revisions (
             workspace_id, revision, definition_json, content_hash,
             schema_version, renderer_version, production_base,
             request_hash, created_at, created_by
           )
           SELECT
             ?1, 1, ?2, 'cross-workspace-unrelated',
             schema_version, renderer_version, production_base,
             'cross-workspace-unrelated-edit', ?3, ?4
           FROM content_revisions
           WHERE workspace_id = ?1 AND revision = 0`,
        )
        .bind(
          successorWorkspaceId,
          JSON.stringify(unrelatedDefinition),
          "2026-11-01T08:01:00.000Z",
          actorId,
        ),
    ]);

    await expect(app.queries.getSchedule(
      referenceSiteDefinition.site.id,
      schedule.id,
    )).resolves.toMatchObject({
      state: "active",
      detail: null,
    });
    operationTime = now;
    const claim = await app.commands.claimDueSchedule(
      schedule.siteId,
      schedule.id,
    );
    await database.batch([
      database
        .prepare(
          `UPDATE content_workspaces
           SET current_revision = 2,
               current_content_hash = 'cross-workspace-successor',
               updated_at = ?2
           WHERE workspace_id = ?1`,
        )
        .bind(successorWorkspaceId, "2026-11-01T08:02:00.000Z"),
      database
        .prepare(
          `INSERT INTO content_revisions (
             workspace_id, revision, definition_json, content_hash,
             schema_version, renderer_version, production_base,
             request_hash, created_at, created_by
           )
           SELECT
             ?1, 2, ?2, 'cross-workspace-successor',
             schema_version, renderer_version, production_base,
             'cross-workspace-post-edit', ?3, ?4
           FROM content_revisions
           WHERE workspace_id = ?1 AND revision = 1`,
        )
        .bind(
          successorWorkspaceId,
          JSON.stringify(successorDefinition),
          "2026-11-01T08:02:00.000Z",
          actorId,
        ),
    ]);

    await expect(app.queries.getSchedule(
      referenceSiteDefinition.site.id,
      schedule.id,
    )).resolves.toMatchObject({
      state: "cancelled",
      detail: "revision_changed",
    });
    await expect(app.queries.getExecution(
      referenceSiteDefinition.site.id,
      claim.execution.executionId,
    )).resolves.toMatchObject({
      state: "blocked",
      detail: "revision_changed",
    });
    expect(
      await database
        .prepare(
          `SELECT state
           FROM blog_post_schedule_publication_reservations
           WHERE execution_id = ?1`,
        )
        .bind(claim.execution.executionId)
        .first(),
    ).toEqual({ state: "released" });
    expect(
      await database
        .prepare(
          `SELECT actor_id, outcome, reason_code
           FROM blog_post_operation_audit_events
           WHERE command_type = 'blog.post.schedule.invalidate'
             AND request_id = ?1`,
        )
        .bind(
          `${schedule.id}:${successorWorkspaceId}:2`,
        )
        .first(),
    ).toEqual({
      actor_id: actorId,
      outcome: "accepted",
      reason_code: "revision_changed",
    });
  });

  it("preserves exact owned publication recovery after approval invalidation", async () => {
    const approval = await approveCurrent();
    const store = createD1BlogPostOperationsStore(database);
    const app = createBlogPostOperationsApplication({
      store,
      now: () => operationTime,
      createId: (kind) => `${kind}_owned_invalidation_recovery`,
      timeZoneDatabaseVersion: () => "2026a",
    });
    const schedule = await app.commands.activateSchedule({
      actorId,
      siteId: referenceSiteDefinition.site.id,
      postId,
      approvalId: approval.id,
      resolvedTime: {
        localDateTime: "2026-11-01T01:00:00",
        ianaTimeZone: "America/Vancouver",
        utcOffsetChoice: "-07:00",
        executeAtUtc: now,
      },
      idempotencyKey: "activate-owned-invalidation-recovery",
    });
    operationTime = now;
    const claim = await app.commands.claimDueSchedule(schedule.siteId, schedule.id);
    await createD1ContentPublicationStore(database).claimPublication({
      id: createContentPublicationId(`publish_${"6".repeat(32)}`),
      workspaceId,
      revision: approval.revision,
      approvalId: approval.id,
      fingerprint: approval.fingerprint.value,
      idempotencyKey: claim.execution.publicationIdempotencyKey,
      requestedBy: membershipId,
      contributors: [actorId],
      expectedHead: "a".repeat(40),
      status: "committed",
      commitSha: "d".repeat(40),
      deploymentId: null,
      deploymentRequestedAt: null,
      detail: null,
      leaseToken: null,
      leaseExpiresAt: null,
      requestedAt: now,
      updatedAt: now,
    }, {
      executionId: claim.execution.executionId,
      attempt: claim.execution.attempt,
      leaseToken: claim.lease!.leaseToken,
    });

    await revisionApplication.commands.save({
      actorId,
      workspaceId,
      schemaVersion: referenceSiteDefinition.schemaVersion,
      baseRevision: approval.revision,
      edits: [{
        path: `${postId}.title`,
        value: "Successor edit after scheduled Git commit",
      }],
      idempotencyKey: "edit-after-owned-scheduled-commit",
    });
    await expect(
      createD1ContentPublicationStore(database)
        .findApproval(approval.id),
    ).resolves.toMatchObject({
      invalidatedAt: expect.any(String),
    });

    await expect(app.queries.getSchedule(
      referenceSiteDefinition.site.id,
      schedule.id,
    )).resolves.toMatchObject({
      state: "claimed",
      detail: null,
    });
    await expect(
      app.queries.getExecution(
        referenceSiteDefinition.site.id,
        claim.execution.executionId,
      ),
    ).resolves.toMatchObject({
      state: "claimed",
      detail: null,
    });
    expect(
      await database
        .prepare(
          `SELECT state
           FROM blog_post_schedule_publication_reservations
           WHERE execution_id = ?1`,
        )
        .bind(claim.execution.executionId)
        .first(),
    ).toEqual({ state: "reserved" });

    const recovery = createBlogPostOperationsApplication({
      store,
      now: () => "2026-11-01T08:06:00.000Z",
      createId: (kind) => `${kind}_owned_invalidation_reclaim`,
      timeZoneDatabaseVersion: () => "2026a",
      validateApprovalAuthority: async (
        checkedApprovalId,
        ownedPublicationIdempotencyKey,
      ) =>
        checkedApprovalId === approval.id &&
        ownedPublicationIdempotencyKey ===
          claim.execution.publicationIdempotencyKey,
    });
    operationTime = now;
    const reclaimed =
      await recovery.commands.claimDueSchedule(schedule.siteId, schedule.id);

    expect(reclaimed).toMatchObject({
      execution: {
        executionId: claim.execution.executionId,
        attempt: 2,
        state: "claimed",
      },
      lease: {
        execution: {
          executionId: claim.execution.executionId,
          attempt: 2,
        },
      },
    });
  });

  it("rejects reuse of proposal, cancellation, archive, and restore request IDs across posts", async () => {
    const approval = await approveCurrent();
    const store = createD1BlogPostOperationsStore(database);
    const app = createBlogPostOperationsApplication({
      store,
      now: () => operationTime,
      timeZoneDatabaseVersion: () => "2026a",
    });
    const proposalTime = {
      localDateTime: "2026-11-01T01:30:00",
      ianaTimeZone: "America/Vancouver",
      utcOffsetChoice: "-07:00",
      executeAtUtc: "2026-11-01T08:30:00.000Z",
    };
    const firstSchedule = await app.commands.activateSchedule({
      actorId,
      siteId: referenceSiteDefinition.site.id,
      postId,
      approvalId: approval.id,
      resolvedTime: proposalTime,
      idempotencyKey: "activate-first-cross-post-request",
    });
    await app.commands.cancelSchedule({
      actorId,
      siteId: referenceSiteDefinition.site.id,
      postId,
      scheduleId: firstSchedule.id,
      idempotencyKey: "cross-post-cancellation-request",
    });
    const siblingPostId = createBlogPostId(
      "00000000-0000-4000-8000-000000000049",
    );
    await revisionApplication.commands.createBlogPost({
      actorId,
      workspaceId,
      siteId: referenceSiteDefinition.site.id,
      schemaVersion: referenceSiteDefinition.schemaVersion,
      baseRevision: 1,
      post: {
        id: siblingPostId,
        slug: "request-identity-sibling",
        title: "Request identity sibling",
        excerpt: "A sibling post for request identity checks.",
        seo: {
          title: "Request identity sibling | Foundry",
          description: "A sibling post for request identity checks.",
        },
        body: createRichTextDocumentFromPlainText(
          "Request identity sibling body.",
        ),
      },
      idempotencyKey: "create-request-identity-sibling",
    });
    const [firstPost, siblingPost] = await Promise.all([
      store.findPost(referenceSiteDefinition.site.id, postId),
      store.findPost(referenceSiteDefinition.site.id, siblingPostId),
    ]);
    await app.commands.proposeSchedule({
      actorId,
      siteId: referenceSiteDefinition.site.id,
      postId,
      resolvedTime: proposalTime,
      idempotencyKey: "cross-post-proposal-request",
    });
    await expect(app.commands.proposeSchedule({
      actorId,
      siteId: referenceSiteDefinition.site.id,
      postId: siblingPostId,
      resolvedTime: proposalTime,
      idempotencyKey: "cross-post-proposal-request",
    })).rejects.toMatchObject({ code: "idempotency_key_conflict" });

    await expect(app.commands.cancelSchedule({
      actorId,
      siteId: referenceSiteDefinition.site.id,
      postId: siblingPostId,
      scheduleId: "schedule-on-another-post",
      idempotencyKey: "cross-post-cancellation-request",
    })).rejects.toMatchObject({ code: "idempotency_key_conflict" });

    await app.commands.archive({
      actorId,
      siteId: referenceSiteDefinition.site.id,
      postId,
      selectedPostRevisionId: firstPost!.postRevisionId,
      idempotencyKey: "cross-post-archive-request",
    });
    await expect(app.commands.archive({
      actorId,
      siteId: referenceSiteDefinition.site.id,
      postId: siblingPostId,
      selectedPostRevisionId: siblingPost!.postRevisionId,
      idempotencyKey: "cross-post-archive-request",
    })).rejects.toMatchObject({ code: "idempotency_key_conflict" });
    await expect(store.findPost(
      referenceSiteDefinition.site.id,
      siblingPostId,
    )).resolves.toMatchObject({ collectionState: "active" });

    await restoreArchivedBlogPostAsDraft({
      environment: {
        FOUNDRY_DB: database,
        FOUNDRY_PRODUCTION_BASE: "a".repeat(40),
        FOUNDRY_RENDERER_VERSION: "renderer-v1",
      },
      actorId,
      postId,
      selectedPostRevisionId: firstPost!.postRevisionId,
      idempotencyKey: "cross-post-restore-request",
    });
    await app.commands.archive({
      actorId,
      siteId: referenceSiteDefinition.site.id,
      postId: siblingPostId,
      selectedPostRevisionId: siblingPost!.postRevisionId,
      idempotencyKey: "archive-sibling-before-cross-post-restore",
    });
    await expect(restoreArchivedBlogPostAsDraft({
      environment: {
        FOUNDRY_DB: database,
        FOUNDRY_PRODUCTION_BASE: "a".repeat(40),
        FOUNDRY_RENDERER_VERSION: "renderer-v1",
      },
      actorId,
      postId: siblingPostId,
      selectedPostRevisionId: siblingPost!.postRevisionId,
      idempotencyKey: "cross-post-restore-request",
    })).rejects.toMatchObject({ code: "idempotency_key_conflict" });
    await expect(store.findPost(
      referenceSiteDefinition.site.id,
      siblingPostId,
    )).resolves.toMatchObject({ collectionState: "archived" });
  });

  it("keeps archive records immutable and exposes restoration as unpublished work", async () => {
    const app = createBlogPostOperationsApplication({
      store: createD1BlogPostOperationsStore(database),
      now: () => operationTime,
      createId: (kind) => `${kind}_archive`,
      timeZoneDatabaseVersion: () => "2026a",
    });
    const post = await createD1BlogPostOperationsStore(database).findPost(
      referenceSiteDefinition.site.id,
      postId,
    );
    const archived = await app.commands.archive({
      actorId,
      siteId: referenceSiteDefinition.site.id,
      postId,
      selectedPostRevisionId: post!.postRevisionId,
      idempotencyKey: "archive-durable-blog-post",
    });
    expect(archived.collectionState).toBe("archived");
    await expect(
      createD1BlogPostOperationsStore(database).findPost(
        referenceSiteDefinition.site.id,
        postId,
      ),
    ).resolves.toMatchObject({ version: archived.version });

    const restored = await restoreArchivedBlogPostAsDraft({
      environment: {
        FOUNDRY_DB: database,
        FOUNDRY_PRODUCTION_BASE: "a".repeat(40),
        FOUNDRY_RENDERER_VERSION: "renderer-v1",
      },
      actorId,
      postId,
      selectedPostRevisionId: post!.postRevisionId,
      idempotencyKey: "restore-durable-blog-post",
    });
    expect(restored).toMatchObject({
      targetVisibility: "unpublished",
      sourcePostRevisionId: post!.postRevisionId,
    });
    expect(restored.revision).toBe(0);
    await expect(
      createD1BlogPostOperationsStore(database).findPost(
        referenceSiteDefinition.site.id,
        postId,
      ),
    ).resolves.toMatchObject({ version: post!.version + 2 });
    expect(
      await database
        .prepare(
          `SELECT snapshot_json
           FROM blog_post_revisions
           WHERE workspace_id = ?1
           ORDER BY revision DESC
           LIMIT 1`,
        )
        .bind(restored.workspaceId)
        .first<{ snapshot_json: string }>(),
    ).toEqual({
      snapshot_json: expect.stringContaining(
        '"targetVisibility":"unpublished"',
      ),
    });
    expect(
      await database
        .prepare(
          `SELECT source_post_revision_id, restored_workspace_id,
                  restored_content_revision
           FROM blog_post_restore_records
           WHERE request_id = 'restore-durable-blog-post'`,
        )
        .first(),
    ).toEqual({
      source_post_revision_id: post!.postRevisionId,
      restored_workspace_id: restored.workspaceId,
      restored_content_revision: restored.revision,
    });
    await expect(
      database
        .prepare("DELETE FROM blog_post_archive_records")
        .run(),
    ).rejects.toThrow(/blog_post_archive_record_is_immutable/u);
  });

  it("uses collection state as the authority fence for edit, approval, and publication", async () => {
    const approval = await approveCurrent();
    const operationsStore = createD1BlogPostOperationsStore(database);
    const post = await operationsStore.findPost(
      referenceSiteDefinition.site.id,
      postId,
    );
    await operationsStore.archive({
      actorId,
      siteId: referenceSiteDefinition.site.id,
      postId,
      selectedPostRevisionId: post!.postRevisionId,
      idempotencyKey: "archive-before-authority-fence-checks",
      occurredAt: now,
    });

    await expect(revisionApplication.commands.save({
      actorId,
      workspaceId,
      schemaVersion: referenceSiteDefinition.schemaVersion,
      baseRevision: 1,
      edits: [{ path: `${postId}.title`, value: "Forbidden archived edit" }],
      idempotencyKey: "edit-archived-post-must-fail",
    })).rejects.toBeDefined();
    await expect(approveCurrent()).rejects.toMatchObject({
      code: "approval_stale",
    });

    const publication = {
      id: createContentPublicationId(`publish_${"3".repeat(32)}`),
      workspaceId,
      revision: approval.revision,
      approvalId: approval.id,
      fingerprint: approval.fingerprint.value,
      idempotencyKey: "publish-archived-post-must-fail",
      requestedBy: membershipId,
      contributors: [actorId],
      expectedHead: "a".repeat(40),
      status: "requested" as const,
      commitSha: null,
      deploymentId: null,
      deploymentRequestedAt: null,
      detail: null,
      leaseToken: "archived-publication-lease",
      leaseExpiresAt: "2026-11-01T08:05:00.000Z",
      requestedAt: now,
      updatedAt: now,
    };
    await expect(
      createD1ContentPublicationStore(database)
        .claimPublication(publication),
    ).resolves.toMatchObject({
      state: "blocked",
      publication: {
        status: "blocked",
        detail: "approval_stale",
      },
    });
    expect(
      await database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM content_revisions
           WHERE workspace_id = ?1 AND revision > 1`,
        )
        .bind(workspaceId)
        .first<{ count: number }>(),
    ).toEqual({ count: 0 });
  });

  it("keeps collection fences scoped to the approval workspace site", async () => {
    const otherSiteId = createSiteId("site_other_tenant");
    const otherWorkspaceId = createContentWorkspaceId(
      "workspace_other_tenant_same_post",
    );
    const sharedDefinition = await hydrateManagedBlogPosts(
      database,
      referenceSiteDefinition,
    );
    const otherRevisionApplication = createContentRevisionApplication({
      siteDefinition: referenceSiteDefinition,
      initialDefinition: sharedDefinition,
      store: createD1ContentRevisionStore(
        database,
        otherSiteId,
        otherWorkspaceId,
      ),
      workspaceId: otherWorkspaceId,
      actorId,
      rendererVersion: "renderer-v1",
      productionBase:
        `git:${"a".repeat(40)}@content:${"b".repeat(64)}`,
      now: () => operationTime,
    });
    const otherRevision = await otherRevisionApplication.commands.create({
      actorId,
      workspaceId: otherWorkspaceId,
      idempotencyKey: "create-other-tenant-same-post",
    });
    const otherApproval = {
      id: createContentApprovalId(`approval_${"7".repeat(32)}`),
      workspaceId: otherWorkspaceId,
      revision: otherRevision.revision,
      fingerprint: await createContentApprovalFingerprint(
        otherRevision,
        "channel-other-tenant",
      ),
      approvedBy: membershipId,
      approvedAt: now,
      invalidatedAt: null,
    };
    const publicationStore = createD1ContentPublicationStore(database);
    await publicationStore.saveApproval(otherApproval);
    const primaryStore = createD1BlogPostOperationsStore(database);
    const primaryPost = await primaryStore.findPost(
      referenceSiteDefinition.site.id,
      postId,
    );

    await primaryStore.archive({
      actorId,
      siteId: referenceSiteDefinition.site.id,
      postId,
      selectedPostRevisionId: primaryPost!.postRevisionId,
      idempotencyKey: "archive-primary-site-only",
      occurredAt: now,
    });

    await expect(
      publicationStore.findApproval(otherApproval.id),
    ).resolves.toMatchObject({ invalidatedAt: null });
    await expect(publicationStore.saveApproval({
      ...otherApproval,
      id: createContentApprovalId(`approval_${"8".repeat(32)}`),
      approvedAt: "2026-11-01T08:01:00.000Z",
    })).resolves.toMatchObject({
      workspaceId: otherWorkspaceId,
      invalidatedAt: null,
    });
  });

  it.each([
    ["requested", "1"],
    ["committed", "2"],
    ["building", "3"],
    ["deployed", "4"],
    ["unknown", "5"],
    ["verified-live", "6"],
  ] as const)(
    "rejects archive while an ordinary post publication is %s",
    async (status, idDigit) => {
      const approval = await approveCurrent();
      const publicationStore = createD1ContentPublicationStore(database);
      await expect(publicationStore.claimPublication({
        id: createContentPublicationId(
          `publish_${idDigit.repeat(32)}`,
        ),
        workspaceId,
        revision: approval.revision,
        approvalId: approval.id,
        fingerprint: approval.fingerprint.value,
        idempotencyKey: `ordinary-${status}-before-archive`,
        requestedBy: membershipId,
        contributors: [actorId],
        expectedHead: "a".repeat(40),
        status,
        commitSha: status === "requested" ? null : "b".repeat(40),
        deploymentId:
          status === "deployed" || status === "verified-live"
            ? "deployment-before-archive"
            : null,
        deploymentRequestedAt:
          status === "deployed" || status === "verified-live" ? now : null,
        detail: null,
        leaseToken: `ordinary-${status}-lease`,
        leaseExpiresAt: "2026-11-01T08:05:00.000Z",
        requestedAt: now,
        updatedAt: now,
      })).resolves.toMatchObject({ state: "claimed" });
      const store = createD1BlogPostOperationsStore(database);
      const post = await store.findPost(
        referenceSiteDefinition.site.id,
        postId,
      );

      await expect(store.archive({
        actorId,
        siteId: referenceSiteDefinition.site.id,
        postId,
        selectedPostRevisionId: post!.postRevisionId,
        idempotencyKey: `archive-during-${status}-publication`,
        occurredAt: now,
      })).rejects.toMatchObject({
        code: "production_operation_in_progress",
      });
      expect(
        await database
          .prepare(
            `SELECT collection_state
             FROM blog_post_collection_states
             WHERE site_id = ?1 AND post_id = ?2`,
          )
          .bind(referenceSiteDefinition.site.id, postId)
          .first(),
      ).toBeNull();
    },
  );

  it("rejects archive when publication advances after the archive snapshot", async () => {
    let injectPublicationAdvance = true;
    const racedDatabase = new Proxy(database, {
      get(target, property) {
        if (property === "batch") {
          return async (statements: Parameters<typeof database.batch>[0]) => {
            if (injectPublicationAdvance) {
              injectPublicationAdvance = false;
              await database
                .prepare(
                  `UPDATE blog_posts
                   SET live_revision = current_revision,
                       last_verified_revision = current_revision,
                       last_verified_visibility = 'public',
                       version = version + 1
                   WHERE site_id = ?1 AND post_id = ?2`,
                )
                .bind(referenceSiteDefinition.site.id, postId)
                .run();
            }
            return database.batch(statements);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const store = createD1BlogPostOperationsStore(racedDatabase);
    const post = await store.findPost(referenceSiteDefinition.site.id, postId);

    await expect(store.archive({
      actorId,
      siteId: referenceSiteDefinition.site.id,
      postId,
      selectedPostRevisionId: post!.postRevisionId,
      idempotencyKey: "archive-publication-race",
      occurredAt: now,
    })).rejects.toMatchObject({ code: "post_archive_conflict" });
    expect(
      await database
        .prepare(
          `SELECT collection_state FROM blog_post_collection_states
           WHERE site_id = ?1 AND post_id = ?2`,
        )
        .bind(referenceSiteDefinition.site.id, postId)
        .first(),
    ).toBeNull();
  });

  it("hydrates every live dynamic post from its exact verified snapshot while withdrawal is prepared", async () => {
    const siblingPostId = createBlogPostId(
      "00000000-0000-4000-8000-000000000046",
    );
    await revisionApplication.commands.createBlogPost({
      actorId,
      workspaceId,
      siteId: referenceSiteDefinition.site.id,
      schemaVersion: referenceSiteDefinition.schemaVersion,
      baseRevision: 1,
      post: {
        id: siblingPostId,
        slug: "sibling-live-post",
        title: "Sibling live title",
        excerpt: "A sibling that must remain live.",
        seo: {
          title: "Sibling live title | Foundry",
          description: "A sibling that must remain live.",
        },
        body: createRichTextDocumentFromPlainText("Sibling live body."),
      },
      idempotencyKey: "create-sibling-live-blog-post",
    });
    await database
      .prepare(
        `UPDATE blog_posts
         SET live_revision = current_revision,
             last_verified_revision = current_revision,
             last_verified_visibility = 'public',
             version = version + 1
         WHERE site_id = ?1 AND post_id IN (?2, ?3)`,
      )
      .bind(referenceSiteDefinition.site.id, postId, siblingPostId)
      .run();
    const targetDraft = await revisionApplication.commands.save({
      actorId,
      workspaceId,
      schemaVersion: referenceSiteDefinition.schemaVersion,
      baseRevision: 2,
      edits: [{
        path: `${postId}.title`,
        value: "Unpublished newer target draft",
      }],
      idempotencyKey: "edit-target-after-live-verification",
    });
    await revisionApplication.commands.unpublishBlogPost({
      actorId,
      workspaceId,
      siteId: referenceSiteDefinition.site.id,
      schemaVersion: referenceSiteDefinition.schemaVersion,
      baseRevision: targetDraft.revision,
      postId: siblingPostId,
      idempotencyKey: "unpublish-sibling-after-live-verification",
    });
    await database
      .prepare(
        `UPDATE blog_posts
         SET current_revision = 2,
             current_revision_id = (
               SELECT revision_id
               FROM blog_post_revisions
               WHERE site_id = ?1 AND post_id = ?2 AND revision = 2
             )
         WHERE site_id = ?1 AND post_id = ?2`,
      )
      .bind(referenceSiteDefinition.site.id, siblingPostId)
      .run();
    expect(
      await database
        .prepare(
          `SELECT post.current_revision, post.live_revision,
                  json_extract(revision.snapshot_json,
                    '$.targetVisibility') AS current_visibility
           FROM blog_posts AS post
           JOIN blog_post_revisions AS revision
             ON revision.revision_id = post.current_revision_id
           WHERE post.site_id = ?1 AND post.post_id = ?2`,
        )
        .bind(referenceSiteDefinition.site.id, siblingPostId)
        .first(),
    ).toEqual({
      current_revision: 2,
      live_revision: 1,
      current_visibility: "unpublished",
    });
    const store = createD1BlogPostOperationsStore(database);
    const post = await store.findPost(referenceSiteDefinition.site.id, postId);
    await store.archive({
      actorId,
      siteId: referenceSiteDefinition.site.id,
      postId,
      selectedPostRevisionId: post!.postRevisionId,
      idempotencyKey: "archive-dynamic-live-post",
      occurredAt: now,
    });

    const withdrawalBase = await hydrateManagedBlogPosts(
      database,
      referenceSiteDefinition,
    );

    expect(
      withdrawalBase.blog.posts.find(({ id }) => id === postId),
    ).toMatchObject({
      id: postId,
      title: "Scheduled post",
    });
    expect(
      withdrawalBase.blog.posts.find(({ id }) => id === siblingPostId),
    ).toMatchObject({
      id: siblingPostId,
      title: "Sibling live title",
      targetVisibility: "public",
    });
  });

  it("audits a rejected restore command with its stable reason", async () => {
    await expect(restoreArchivedBlogPostAsDraft({
      environment: {
        FOUNDRY_DB: database,
        FOUNDRY_PRODUCTION_BASE: "a".repeat(40),
        FOUNDRY_RENDERER_VERSION: "renderer-v1",
      },
      actorId,
      postId,
      selectedPostRevisionId: "post-revision-not-archived",
      idempotencyKey: "restore-active-post-rejected",
    })).rejects.toMatchObject({ code: "post_not_archived" });

    expect(
      await database
        .prepare(
          `SELECT actor_id, outcome, reason_code
           FROM blog_post_operation_audit_events
           WHERE command_type = 'blog.post.restore'
             AND request_id = 'restore-active-post-rejected'`,
        )
        .first(),
    ).toEqual({
      actor_id: actorId,
      outcome: "rejected",
      reason_code: "post_not_archived",
    });
  });

  it("restores a historical snapshot as the successor of the aggregate head", async () => {
    const store = createD1BlogPostOperationsStore(database);
    const historical = await store.findPost(
      referenceSiteDefinition.site.id,
      postId,
    );
    await revisionApplication.commands.save({
      actorId,
      workspaceId,
      schemaVersion: referenceSiteDefinition.schemaVersion,
      baseRevision: 1,
      edits: [{ path: `${postId}.title`, value: "Newer aggregate head" }],
      idempotencyKey: "create-newer-aggregate-head",
    });
    const newer = await database
      .prepare(
        `SELECT revision_id, revision
         FROM blog_post_revisions
         WHERE workspace_id = ?1 AND content_revision = 2 AND post_id = ?2`,
      )
      .bind(workspaceId, postId)
      .first<{ revision_id: string; revision: number }>();
    await database
      .prepare(
        `UPDATE blog_posts
         SET current_revision = ?1, current_revision_id = ?2,
             last_verified_revision = ?1,
             last_verified_visibility = 'unpublished',
             version = version + 1
         WHERE site_id = ?3 AND post_id = ?4`,
      )
      .bind(
        newer!.revision,
        newer!.revision_id,
        referenceSiteDefinition.site.id,
        postId,
      )
      .run();
    const app = createBlogPostOperationsApplication({
      store,
      now: () => operationTime,
    });
    await app.commands.archive({
      actorId,
      siteId: referenceSiteDefinition.site.id,
      postId,
      selectedPostRevisionId: historical!.postRevisionId,
      idempotencyKey: "archive-before-historical-restore",
    });

    const restored = await restoreArchivedBlogPostAsDraft({
      environment: {
        FOUNDRY_DB: database,
        FOUNDRY_PRODUCTION_BASE: "a".repeat(40),
        FOUNDRY_RENDERER_VERSION: "renderer-v1",
      },
      actorId,
      postId,
      selectedPostRevisionId: historical!.postRevisionId,
      idempotencyKey: "restore-historical-revision",
    });

    expect(restored.postRevision).toBe(newer!.revision + 1);
    expect(
      await database
        .prepare(
          `SELECT current_revision, current_revision_id
           FROM blog_posts WHERE site_id = ?1 AND post_id = ?2`,
        )
        .bind(referenceSiteDefinition.site.id, postId)
        .first(),
    ).toEqual({
      current_revision: newer!.revision + 1,
      current_revision_id: expect.any(String),
    });
  });

  it("lets a current Editor take over an incomplete restore claim from a suspended actor", async () => {
    const store = createD1BlogPostOperationsStore(database);
    const post = await store.findPost(
      referenceSiteDefinition.site.id,
      postId,
    );
    await store.archive({
      actorId,
      siteId: referenceSiteDefinition.site.id,
      postId,
      selectedPostRevisionId: post!.postRevisionId,
      idempotencyKey: "archive-before-abandoned-restore",
      occurredAt: now,
    });
    await store.claimRestore({
      actorId,
      siteId: referenceSiteDefinition.site.id,
      postId,
      selectedPostRevisionId: post!.postRevisionId,
      idempotencyKey: "abandoned-restore-claim",
      occurredAt: now,
    });
    await database
      .prepare(
        `UPDATE human_memberships
         SET status = 'suspended', updated_at = ?1
         WHERE site_id = ?2 AND id = ?3`,
      )
      .bind(now, referenceSiteDefinition.site.id, actorId)
      .run();
    const replacementActorId = createContentActorId(
      "membership-replacement-editor",
    );
    await database.batch([
      database
        .prepare(
          `INSERT INTO human_users (id, email, created_at)
           VALUES ('user-replacement-editor',
                   'replacement-editor@example.com', ?1)`,
        )
        .bind(now),
      database
        .prepare(
          `INSERT INTO human_memberships (
             id, site_id, user_id, email, identity_issuer,
             identity_subject, role, status, created_at, updated_at
           ) VALUES (
             ?1, ?2, 'user-replacement-editor',
             'replacement-editor@example.com',
             'https://access.example.com', 'replacement-editor',
             'editor', 'active', ?3, ?3
           )`,
        )
        .bind(
          replacementActorId,
          referenceSiteDefinition.site.id,
          now,
        ),
    ]);

    const restored = await restoreArchivedBlogPostAsDraft({
      environment: {
        FOUNDRY_DB: database,
        FOUNDRY_PRODUCTION_BASE: "a".repeat(40),
        FOUNDRY_RENDERER_VERSION: "renderer-v1",
      },
      actorId: replacementActorId,
      postId,
      selectedPostRevisionId: post!.postRevisionId,
      idempotencyKey: "replacement-restore-claim",
    });

    expect(restored).toMatchObject({
      postId,
      sourcePostRevisionId: post!.postRevisionId,
      targetVisibility: "unpublished",
    });
    expect(
      await database
        .prepare(
          `SELECT actor_id, request_id
           FROM blog_post_restore_records
           WHERE site_id = ?1 AND post_id = ?2`,
        )
        .bind(referenceSiteDefinition.site.id, postId)
        .first(),
    ).toEqual({
      actor_id: replacementActorId,
      request_id: "replacement-restore-claim",
    });
  });

  it.each(["aggregate", "collection"] as const)(
    "aborts restore initialization when the %s authority CAS loses",
    async (lostAuthority) => {
      const store = createD1BlogPostOperationsStore(database);
      const post = await store.findPost(
        referenceSiteDefinition.site.id,
        postId,
      );
      await store.archive({
        actorId,
        siteId: referenceSiteDefinition.site.id,
        postId,
        selectedPostRevisionId: post!.postRevisionId,
        idempotencyKey: `archive-before-${lostAuthority}-restore-race`,
        occurredAt: now,
      });
      let injectRace = true;
      const racedDatabase = new Proxy(database, {
        get(target, property) {
          if (property === "batch") {
            return async (
              statements: Parameters<typeof database.batch>[0],
            ) => {
              if (injectRace) {
                injectRace = false;
                if (lostAuthority === "aggregate") {
                  await database
                    .prepare(
                      `UPDATE blog_posts
                       SET current_revision = current_revision + 1,
                           version = version + 1
                       WHERE site_id = ?1 AND post_id = ?2`,
                    )
                    .bind(referenceSiteDefinition.site.id, postId)
                    .run();
                } else {
                  await database
                    .prepare(
                      `UPDATE blog_post_collection_states
                       SET restore_request_id = 'competing-restore-request'
                       WHERE site_id = ?1 AND post_id = ?2`,
                    )
                    .bind(referenceSiteDefinition.site.id, postId)
                    .run();
                }
              }
              return database.batch(statements);
            };
          }
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });

      await expect(restoreArchivedBlogPostAsDraft({
        environment: {
          FOUNDRY_DB: racedDatabase,
          FOUNDRY_PRODUCTION_BASE: "a".repeat(40),
          FOUNDRY_RENDERER_VERSION: "renderer-v1",
        },
        actorId,
        postId,
        selectedPostRevisionId: post!.postRevisionId,
        idempotencyKey: `restore-lost-${lostAuthority}-authority`,
      })).rejects.toMatchObject({ code: "post_restore_conflict" });
      expect(
        await database
          .prepare("SELECT COUNT(*) AS count FROM content_workspaces")
          .first<{ count: number }>(),
      ).toEqual({ count: 1 });
      expect(
        await database
          .prepare(
            `SELECT COUNT(*) AS count
             FROM blog_post_restore_records
             WHERE request_id = ?1`,
          )
          .bind(`restore-lost-${lostAuthority}-authority`)
          .first<{ count: number }>(),
      ).toEqual({ count: 0 });
      expect(
        await database
          .prepare(
            `SELECT COUNT(*) AS count
             FROM blog_post_operation_audit_events
             WHERE command_type = 'blog.post.restore'
               AND request_id = ?1
               AND outcome = 'accepted'`,
          )
          .bind(`restore-lost-${lostAuthority}-authority`)
          .first<{ count: number }>(),
      ).toEqual({ count: 0 });
    },
  );

  it("rejects restore completion when role authority is revoked after preflight", async () => {
    const store = createD1BlogPostOperationsStore(database);
    const post = await store.findPost(
      referenceSiteDefinition.site.id,
      postId,
    );
    await store.archive({
      actorId,
      siteId: referenceSiteDefinition.site.id,
      postId,
      selectedPostRevisionId: post!.postRevisionId,
      idempotencyKey: "archive-before-restore-role-race",
      occurredAt: now,
    });
    let injectRace = true;
    const racedDatabase = new Proxy(database, {
      get(target, property) {
        if (property === "batch") {
          return async (
            statements: Parameters<typeof database.batch>[0],
          ) => {
            if (injectRace) {
              injectRace = false;
              await database
                .prepare(
              `UPDATE human_memberships
                   SET status = 'suspended', updated_at = ?1
                   WHERE site_id = ?2 AND id = ?3`,
                )
                .bind(
                  "2026-11-01T08:01:00.000Z",
                  referenceSiteDefinition.site.id,
                  actorId,
                )
                .run();
            }
            return database.batch(statements);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    await expect(restoreArchivedBlogPostAsDraft({
      environment: {
        FOUNDRY_DB: racedDatabase,
        FOUNDRY_PRODUCTION_BASE: "a".repeat(40),
        FOUNDRY_RENDERER_VERSION: "renderer-v1",
      },
      actorId,
      postId,
      selectedPostRevisionId: post!.postRevisionId,
      idempotencyKey: "restore-after-role-revocation",
    })).rejects.toMatchObject({ code: "human_authority_required" });
    await expect(
      store.findPost(referenceSiteDefinition.site.id, postId),
    ).resolves.toMatchObject({ collectionState: "archived" });
    expect(
      await database
        .prepare("SELECT COUNT(*) AS count FROM content_workspaces")
        .first<{ count: number }>(),
    ).toEqual({ count: 1 });
    expect(
      await database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM blog_post_restore_records
           WHERE request_id = 'restore-after-role-revocation'`,
        )
        .first<{ count: number }>(),
    ).toEqual({ count: 0 });
  });

  it("serializes concurrent archive and restore requests without orphan state", async () => {
    const store = createD1BlogPostOperationsStore(database);
    const app = createBlogPostOperationsApplication({
      store,
      now: () => operationTime,
      createId: (kind) => `${kind}_concurrent`,
      timeZoneDatabaseVersion: () => "2026a",
    });
    const post = await store.findPost(
      referenceSiteDefinition.site.id,
      postId,
    );
    const archiveResults = await Promise.allSettled([
      app.commands.archive({
        actorId,
        siteId: referenceSiteDefinition.site.id,
        postId,
        selectedPostRevisionId: post!.postRevisionId,
        idempotencyKey: "archive-concurrent-request-a",
      }),
      app.commands.archive({
        actorId,
        siteId: referenceSiteDefinition.site.id,
        postId,
        selectedPostRevisionId: post!.postRevisionId,
        idempotencyKey: "archive-concurrent-request-b",
      }),
    ]);
    const archived = archiveResults.find(
      (result): result is PromiseFulfilledResult<
        Awaited<ReturnType<typeof app.commands.archive>>
      > => result.status === "fulfilled",
    );
    expect(archived).toBeDefined();
    expect(archiveResults.filter(({ status }) => status === "fulfilled"))
      .toHaveLength(1);
    const archiveRequest = await database
      .prepare(
        `SELECT request_id FROM blog_post_archive_records
         WHERE response_json IS NOT NULL`,
      )
      .first<{ request_id: string }>();
    expect(archiveRequest).not.toBeNull();
    await expect(
      app.commands.archive({
        actorId,
        siteId: referenceSiteDefinition.site.id,
        postId,
        selectedPostRevisionId: post!.postRevisionId,
        idempotencyKey: archiveRequest!.request_id,
      }),
    ).resolves.toEqual(archived!.value);
    expect(
      await database
        .prepare(
          `SELECT COUNT(*) AS count FROM blog_post_archive_records
           WHERE response_json IS NOT NULL`,
        )
        .first<{ count: number }>(),
    ).toEqual({ count: 1 });
    expect(
      await database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM blog_post_operation_audit_events
           WHERE command_type = 'blog.post.archive'
             AND outcome = 'accepted'`,
        )
        .first<{ count: number }>(),
    ).toEqual({ count: 1 });

    const restoreResults = await Promise.allSettled([
      restoreArchivedBlogPostAsDraft({
        environment: {
          FOUNDRY_DB: database,
          FOUNDRY_PRODUCTION_BASE: "a".repeat(40),
          FOUNDRY_RENDERER_VERSION: "renderer-v1",
        },
        actorId,
        postId,
        selectedPostRevisionId: post!.postRevisionId,
        idempotencyKey: "restore-concurrent-request-a",
      }),
      restoreArchivedBlogPostAsDraft({
        environment: {
          FOUNDRY_DB: database,
          FOUNDRY_PRODUCTION_BASE: "a".repeat(40),
          FOUNDRY_RENDERER_VERSION: "renderer-v1",
        },
        actorId,
        postId,
        selectedPostRevisionId: post!.postRevisionId,
        idempotencyKey: "restore-concurrent-request-b",
      }),
    ]);
    const restored = restoreResults.find(
      (result): result is PromiseFulfilledResult<{
        workspaceId: ReturnType<typeof createContentWorkspaceId>;
        revision: number;
        postId: typeof postId;
        postRevision: number;
        sourcePostRevisionId: string;
        targetVisibility: "unpublished";
      }> => result.status === "fulfilled",
    );
    expect(restored).toBeDefined();
    expect(restoreResults.filter(({ status }) => status === "fulfilled"))
      .toHaveLength(1);
    const restoreRequest = await database
      .prepare(
        `SELECT request_id FROM blog_post_restore_records`,
      )
      .first<{ request_id: string }>();
    const replay = await restoreArchivedBlogPostAsDraft({
      environment: {
        FOUNDRY_DB: database,
        FOUNDRY_PRODUCTION_BASE: "a".repeat(40),
        FOUNDRY_RENDERER_VERSION: "renderer-v1",
      },
      actorId,
      postId,
      selectedPostRevisionId: post!.postRevisionId,
      idempotencyKey: restoreRequest!.request_id,
    });
    expect(replay).toEqual(restored!.value);
    expect(
      await database
        .prepare("SELECT COUNT(*) AS count FROM content_workspaces")
        .first<{ count: number }>(),
    ).toEqual({ count: 2 });
    expect(
      await database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM blog_post_operation_audit_events
           WHERE command_type = 'blog.post.restore'
             AND outcome = 'accepted'`,
        )
        .first<{ count: number }>(),
    ).toEqual({ count: 1 });
  });

  it("serializes withdrawal ownership across two live post archives", async () => {
    const siblingPostId = createBlogPostId(
      "00000000-0000-4000-8000-000000000047",
    );
    await revisionApplication.commands.createBlogPost({
      actorId,
      workspaceId,
      siteId: referenceSiteDefinition.site.id,
      schemaVersion: referenceSiteDefinition.schemaVersion,
      baseRevision: 1,
      post: {
        id: siblingPostId,
        slug: "second-live-archive",
        title: "Second live archive",
        excerpt: "A second live post competing for withdrawal.",
        seo: {
          title: "Second live archive | Foundry",
          description: "A second live post competing for withdrawal.",
        },
        body: createRichTextDocumentFromPlainText(
          "Second live archive body.",
        ),
      },
      idempotencyKey: "create-second-live-archive-post",
    });
    await database
      .prepare(
        `UPDATE blog_posts
         SET live_revision = current_revision,
             last_verified_revision = current_revision,
             last_verified_visibility = 'public',
             version = version + 1
         WHERE site_id = ?1 AND post_id IN (?2, ?3)`,
      )
      .bind(referenceSiteDefinition.site.id, postId, siblingPostId)
      .run();
    const store = createD1BlogPostOperationsStore(database);
    const app = createBlogPostOperationsApplication({
      store,
      now: () => operationTime,
    });
    const [first, second] = await Promise.all([
      store.findPost(referenceSiteDefinition.site.id, postId),
      store.findPost(referenceSiteDefinition.site.id, siblingPostId),
    ]);

    const results = await Promise.allSettled([
      app.commands.archive({
        actorId,
        siteId: referenceSiteDefinition.site.id,
        postId,
        selectedPostRevisionId: first!.postRevisionId,
        idempotencyKey: "archive-first-live-withdrawal",
      }),
      app.commands.archive({
        actorId,
        siteId: referenceSiteDefinition.site.id,
        postId: siblingPostId,
        selectedPostRevisionId: second!.postRevisionId,
        idempotencyKey: "archive-second-live-withdrawal",
      }),
    ]);

    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<
        Awaited<ReturnType<typeof app.commands.archive>>
      > => result.status === "fulfilled",
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult =>
        result.status === "rejected",
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({
      code: "production_operation_in_progress",
    });
    expect(fulfilled[0]?.value).toMatchObject({
      collectionState: "archiving",
      withdrawalRequired: true,
    });
    expect(
      await database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM blog_post_collection_states
           WHERE site_id = ?1 AND collection_state = 'archiving'
             AND previous_live_revision_id IS NOT NULL`,
        )
        .bind(referenceSiteDefinition.site.id)
        .first<{ count: number }>(),
    ).toEqual({ count: 1 });
    const losingPostId =
      fulfilled[0]?.value.postId === postId ? siblingPostId : postId;
    await expect(
      store.findPost(referenceSiteDefinition.site.id, losingPostId),
    ).resolves.toMatchObject({ collectionState: "active" });
  });

  it("durably grants a replacement Editor access to an existing withdrawal workspace", async () => {
    await database
      .prepare(
        `UPDATE blog_posts
         SET live_revision = current_revision,
             last_verified_revision = current_revision,
             last_verified_visibility = 'public'
         WHERE site_id = ?1 AND post_id = ?2`,
      )
      .bind(referenceSiteDefinition.site.id, postId)
      .run();
    const store = createD1BlogPostOperationsStore(database);
    const post = await store.findPost(referenceSiteDefinition.site.id, postId);
    await store.archive({
      actorId,
      siteId: referenceSiteDefinition.site.id,
      postId,
      selectedPostRevisionId: post!.postRevisionId,
      idempotencyKey: "archive-before-replacement-withdrawal-access",
      occurredAt: now,
    });
    await store.bindArchiveWithdrawalDraft({
      siteId: referenceSiteDefinition.site.id,
      postId,
      workspaceId,
      contentRevision: 1,
      createdBy: actorId,
      requestId: "archive-before-replacement-withdrawal-access",
      occurredAt: now,
    });
    await database
      .prepare(
        `UPDATE human_memberships
         SET status = 'suspended', updated_at = ?1
         WHERE site_id = ?2 AND id = ?3`,
      )
      .bind(now, referenceSiteDefinition.site.id, actorId)
      .run();
    const replacementActorId = createContentActorId(
      "membership-withdrawal-replacement",
    );
    await database.batch([
      database
        .prepare(
          `INSERT INTO human_users (id, email, created_at)
           VALUES ('user-withdrawal-replacement',
                   'withdrawal-replacement@example.com', ?1)`,
        )
        .bind(now),
      database
        .prepare(
          `INSERT INTO human_memberships (
             id, site_id, user_id, email, identity_issuer,
             identity_subject, role, status, created_at, updated_at
           ) VALUES (
             ?1, ?2, 'user-withdrawal-replacement',
             'withdrawal-replacement@example.com',
             'https://access.example.com', 'withdrawal-replacement',
             'editor', 'active', ?3, ?3
           )`,
        )
        .bind(
          replacementActorId,
          referenceSiteDefinition.site.id,
          now,
        ),
    ]);
    const revisionStore = createD1ContentRevisionStore(
      database,
      referenceSiteDefinition.site.id,
      workspaceId,
    );
    await expect(
      revisionStore.requireAccess(replacementActorId),
    ).rejects.toBeDefined();

    const recovered = await recoverArchiveBlogPostWithdrawalAccess({
      environment: {
        FOUNDRY_DB: database,
        FOUNDRY_PRODUCTION_BASE: "a".repeat(40),
        FOUNDRY_RENDERER_VERSION: "renderer-v1",
      },
      postId,
      archiveRequestId: "archive-before-replacement-withdrawal-access",
      actorId: replacementActorId,
      requestId: "replacement-withdrawal-recovery-access",
    });

    expect(recovered).toMatchObject({
      archiveRequestId: "archive-before-replacement-withdrawal-access",
      withdrawal: {
        workspaceId,
        revision: 1,
        approvalRequired: true,
      },
    });
    await expect(
      revisionStore.requireAccess(replacementActorId),
    ).resolves.toBeUndefined();
    expect(
      await database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM content_workspace_collaborators
           WHERE workspace_id = ?1 AND actor_id = ?2`,
        )
        .bind(workspaceId, replacementActorId)
        .first(),
    ).toEqual({ count: 1 });
    expect(
      await database
        .prepare(
          `SELECT post_id, actor_id, outcome
           FROM blog_post_operation_audit_events
           WHERE site_id = ?1
             AND command_type =
               'blog.post.archive.withdrawal.recover_access'
             AND request_id = 'replacement-withdrawal-recovery-access'`,
        )
        .bind(referenceSiteDefinition.site.id)
        .first(),
    ).toEqual({
      post_id: postId,
      actor_id: replacementActorId,
      outcome: "accepted",
    });
  });

  it("finishes a live archive only for its matching verified withdrawal publication", async () => {
    await database
      .prepare(
        `UPDATE blog_posts
         SET live_revision = current_revision,
             last_verified_revision = current_revision,
             last_verified_visibility = 'public'
         WHERE site_id = ?1 AND post_id = ?2`,
      )
      .bind(referenceSiteDefinition.site.id, postId)
      .run();
    const publicationStore = createD1ContentPublicationStore(database);
    const unrelatedPublicationId = createContentPublicationId(
      `publish_${"7".repeat(32)}`,
    );
    const originalRevision = await findContentRevision(
      database,
      workspaceId,
      1,
    );
    const unrelatedApproval = {
      id: createContentApprovalId(`approval_${"7".repeat(32)}`),
      workspaceId,
      revision: 1,
      fingerprint: await createContentApprovalFingerprint(
        originalRevision!,
        "channel-a",
      ),
      approvedBy: membershipId,
      approvedAt: "2026-11-01T08:00:30.000Z",
      invalidatedAt: null,
    };
    await publicationStore.saveApproval(unrelatedApproval);
    await publicationStore.claimPublication({
      id: unrelatedPublicationId,
      workspaceId,
      revision: 1,
      approvalId: unrelatedApproval.id,
      fingerprint: unrelatedApproval.fingerprint.value,
      idempotencyKey: "unrelated-archive-publication",
      requestedBy: membershipId,
      contributors: [actorId],
      expectedHead: "a".repeat(40),
      status: "verified-live",
      commitSha: "b".repeat(40),
      deploymentId: "deployment-unrelated-archive",
      deploymentRequestedAt: now,
      detail: null,
      leaseToken: null,
      leaseExpiresAt: null,
      requestedAt: now,
      updatedAt: now,
    });
    await database
      .prepare(
        `UPDATE blog_posts
         SET last_verified_publication_id = ?1,
             last_verified_publication_sequence = (
               SELECT sequence
               FROM blog_publication_reconciliation_order
               WHERE publication_id = ?1
             )
         WHERE site_id = ?2 AND post_id = ?3`,
      )
      .bind(
        unrelatedPublicationId,
        referenceSiteDefinition.site.id,
        postId,
      )
      .run();
    const withdrawalRevision =
      await revisionApplication.commands.unpublishBlogPost({
        actorId,
        workspaceId,
        siteId: referenceSiteDefinition.site.id,
        schemaVersion: referenceSiteDefinition.schemaVersion,
        baseRevision: 1,
        postId,
        idempotencyKey: "prepare-real-archive-withdrawal",
      });
    const operationsStore = createD1BlogPostOperationsStore(database);
    const app = createBlogPostOperationsApplication({
      store: operationsStore,
      now: () => operationTime,
      createId: (kind) => `${kind}_verified_archive`,
      timeZoneDatabaseVersion: () => "2026a",
    });
    const post = await operationsStore.findPost(
      referenceSiteDefinition.site.id,
      postId,
    );
    const archiving = await app.commands.archive({
      actorId,
      siteId: referenceSiteDefinition.site.id,
      postId,
      selectedPostRevisionId: post!.postRevisionId,
      idempotencyKey: "archive-live-durable-post",
    });
    await expect(
      operationsStore.findPost(referenceSiteDefinition.site.id, postId),
    ).resolves.toMatchObject({ version: archiving.version });
    await app.commands.bindArchiveWithdrawalDraft({
      siteId: referenceSiteDefinition.site.id,
      postId,
      workspaceId,
      contentRevision: withdrawalRevision.revision,
      createdBy: actorId,
      requestId: "archive-live-durable-post",
      occurredAt: now,
    });
    const publicationId = createContentPublicationId(
      `publish_${"5".repeat(32)}`,
    );
    await expect(app.commands.bindArchiveWithdrawal({
      siteId: referenceSiteDefinition.site.id,
      postId,
      publicationId: unrelatedPublicationId,
      occurredAt: now,
    })).rejects.toMatchObject({ code: "archive_publication_mismatch" });
    const exactWithdrawalRevision = await findContentRevision(
      database,
      workspaceId,
      withdrawalRevision.revision,
    );
    const verificationApproval = {
      id: createContentApprovalId(`approval_${"6".repeat(32)}`),
      workspaceId,
      revision: withdrawalRevision.revision,
      fingerprint: await createContentApprovalFingerprint(
        exactWithdrawalRevision!,
        "channel-a",
      ),
      approvedBy: membershipId,
      approvedAt: "2026-11-01T08:01:00.000Z",
      invalidatedAt: null,
    };
    await publicationStore.saveApproval(verificationApproval);
    const requestedPublication = {
      id: publicationId,
      workspaceId,
      revision: withdrawalRevision.revision,
      approvalId: verificationApproval.id,
      fingerprint: verificationApproval.fingerprint.value,
      idempotencyKey: "verified-archive-publication",
      requestedBy: membershipId,
      contributors: [actorId],
      expectedHead: "a".repeat(40),
      status: "requested" as const,
      commitSha: null,
      deploymentId: null,
      deploymentRequestedAt: null,
      detail: null,
      leaseToken: "archive-publication-lease",
      leaseExpiresAt: "2026-11-01T08:05:00.000Z",
      requestedAt: now,
      updatedAt: now,
    };
    await publicationStore.claimPublication(requestedPublication);
    const conflictingContinuationRequest =
      "continuation-request-shared-across-posts";
    const siblingPostId = createBlogPostId(
      "00000000-0000-4000-8000-000000000046",
    );
    await operationsStore.recordAudit({
      siteId: referenceSiteDefinition.site.id,
      postId: siblingPostId,
      actorId,
      commandType: "blog.post.archive.withdrawal.continue",
      requestId: conflictingContinuationRequest,
      outcome: "accepted",
      reasonCode: "accepted",
      beforeState: null,
      afterState: { siblingPostId },
      occurredAt: now,
    });
    await expect(app.commands.bindArchiveWithdrawal({
      siteId: referenceSiteDefinition.site.id,
      postId,
      publicationId,
      occurredAt: now,
      acceptedContinuation: {
        actorId,
        requestId: conflictingContinuationRequest,
        approvalId: verificationApproval.id,
        beforeState: archiving,
        afterState: {
          archiveRequestId: "archive-live-durable-post",
          archived: archiving,
          publication: requestedPublication,
        },
      },
    })).rejects.toMatchObject({ code: "idempotency_key_conflict" });
    expect(
      await database
        .prepare(
          `SELECT archive_publication_id
           FROM blog_post_collection_states
           WHERE site_id = ?1 AND post_id = ?2`,
        )
        .bind(referenceSiteDefinition.site.id, postId)
        .first(),
    ).toEqual({ archive_publication_id: null });
    await app.commands.bindArchiveWithdrawal({
      siteId: referenceSiteDefinition.site.id,
      postId,
      publicationId,
      occurredAt: now,
      acceptedContinuation: {
        actorId,
        requestId: "continue-live-durable-post",
        approvalId: verificationApproval.id,
        beforeState: archiving,
        afterState: {
          archiveRequestId: "archive-live-durable-post",
          archived: archiving,
          publication: requestedPublication,
        },
      },
    });
    expect(
      await database
        .prepare(
          `SELECT actor_id, after_state_json
           FROM blog_post_operation_audit_events
           WHERE site_id = ?1 AND post_id = ?2
             AND command_type =
               'blog.post.archive.withdrawal.continue'
             AND request_id = 'continue-live-durable-post'
             AND outcome = 'accepted'`,
        )
        .bind(referenceSiteDefinition.site.id, postId)
        .first(),
    ).toEqual({
      actor_id: actorId,
      after_state_json: JSON.stringify({
        archiveRequestId: "archive-live-durable-post",
        archived: archiving,
        publication: requestedPublication,
      }),
    });
    await expect(
      app.commands.confirmArchiveWithdrawal({
        siteId: referenceSiteDefinition.site.id,
        postId,
        publicationId,
      }),
    ).rejects.toMatchObject({ code: "archive_withdrawal_not_verified" });
    expect(
      await database
        .prepare(
          `SELECT outcome, reason_code
           FROM blog_post_operation_audit_events
           WHERE command_type =
             'blog.post.archive.withdrawal.verified'
             AND outcome = 'rejected'`,
        )
        .first(),
    ).toEqual({
      outcome: "rejected",
      reason_code: "archive_withdrawal_not_verified",
    });

    await publicationStore.updatePublication({
      ...requestedPublication,
      status: "verified-live",
      commitSha: "c".repeat(40),
      deploymentId: "deployment-archive",
      deploymentRequestedAt: now,
      leaseToken: null,
      leaseExpiresAt: null,
      updatedAt: "2026-11-01T08:02:00.000Z",
    }, {
      expectedLeaseToken: requestedPublication.leaseToken,
      expectedLeaseValidAt: now,
    });
    await database
      .prepare(
        `UPDATE blog_posts SET live_revision = NULL
         WHERE site_id = ?1 AND post_id = ?2`,
      )
      .bind(referenceSiteDefinition.site.id, postId)
      .run();

    const confirmed = await app.commands.confirmArchiveWithdrawal({
      siteId: referenceSiteDefinition.site.id,
      postId,
      publicationId,
    });
    expect(confirmed).toMatchObject({
      collectionState: "archived",
      version: archiving.version + 1,
    });
    expect(
      await database
        .prepare(
          `SELECT outcome, publication_id
           FROM blog_post_archive_records
           WHERE outcome = 'archived'`,
        )
        .first(),
    ).toEqual({ outcome: "archived", publication_id: publicationId });
    expect(
      await database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM blog_post_operation_audit_events
           WHERE command_type IN (
             'blog.post.archive.withdrawal.bind',
             'blog.post.archive.withdrawal.verified'
           ) AND outcome = 'accepted'`,
        )
        .first<{ count: number }>(),
    ).toEqual({ count: 2 });
  });
});
