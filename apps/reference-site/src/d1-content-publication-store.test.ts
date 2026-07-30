import { readFile } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";

import {
  createContentActorId,
  createContentApprovalFingerprint,
  createContentApprovalId,
  createContentPublicationApplication,
  createContentPublicationId,
  createContentRevisionApplication,
  createContentWorkspaceId,
  createHumanMembershipId,
  ContentPublicationIdempotencyError,
  type ContentApproval,
  type ContentPublication,
} from "@foundry/application";
import { referenceSiteDefinition } from "@foundry/site-definition";

import { createD1ContentPublicationStore } from "./d1-content-publication-store";
import { createD1ContentRevisionStore } from "./d1-content-revision-store";

describe("D1 content publication store", () => {
  const workspaceId = createContentWorkspaceId("workspace_publish");
  const actorId = createContentActorId("membership-editor");
  const membershipId = createHumanMembershipId("membership-editor");
  let miniflare: Miniflare;
  let database: Awaited<ReturnType<Miniflare["getD1Database"]>>;
  let approval: ContentApproval;
  let revisionApplication: ReturnType<
    typeof createContentRevisionApplication
  >;

  beforeEach(async () => {
    miniflare = new Miniflare({
      compatibilityDate: "2026-07-26",
      modules: true,
      script: "export default { fetch() { return new Response('ok') } }",
      d1Databases: ["FOUNDRY_DB"],
    });
    database = await miniflare.getD1Database("FOUNDRY_DB");
    for (const migrationName of [
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
      "0023_mcp_publication_scopes.sql",
    ]) {
      const migration = await readFile(
        new URL(`../migrations/${migrationName}`, import.meta.url),
        "utf8",
      );
      for (const statement of migration.trim().split(/\n\n+/)) {
        await database.prepare(statement).run();
      }
    }
    await database.batch([
      database
        .prepare(
          `INSERT INTO human_users (id, email, created_at)
           VALUES ('user-editor', 'editor@example.test', ?1)`,
        )
        .bind("2026-07-27T09:59:00.000Z"),
      database
        .prepare(
          `INSERT INTO human_memberships (
             id, site_id, user_id, email, identity_issuer, identity_subject,
             role, status, created_at, updated_at
           ) VALUES (
             ?1, ?2, 'user-editor', 'editor@example.test',
             'https://access.example', 'editor', 'editor', 'active', ?3, ?3
           )`,
        )
        .bind(
          membershipId,
          referenceSiteDefinition.site.id,
          "2026-07-27T09:59:00.000Z",
        ),
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
      now: () => "2026-07-27T10:00:00.000Z",
    });
    await revisionApplication.commands.create({
      actorId,
      workspaceId,
      idempotencyKey: "create-publication-store-1",
    });
    const revision = await revisionApplication.queries.getCurrent();
    approval = {
      id: createContentApprovalId(`approval_${"1".repeat(32)}`),
      workspaceId,
      revision: 0,
      fingerprint: await createContentApprovalFingerprint(
        revision,
        "channel-a",
      ),
      approvedBy: membershipId,
      approvedAt: "2026-07-27T10:01:00.000Z",
      invalidatedAt: null,
    };
  });

  afterEach(async () => {
    await miniflare.dispose();
  });

  function publication(
    id: string,
    key: string,
    status: ContentPublication["status"] = "requested",
  ): ContentPublication {
    return {
      id: createContentPublicationId(`publish_${id.repeat(32)}`),
      workspaceId,
      revision: 0,
      approvalId: approval.id,
      fingerprint: approval.fingerprint.value,
      idempotencyKey: key,
      requestedBy: membershipId,
      contributors: [actorId],
      expectedHead: "a".repeat(40),
      status,
      commitSha: null,
      deploymentId: null,
      deploymentRequestedAt: null,
      detail: null,
      leaseToken: `lease-${id}`,
      leaseExpiresAt: `2026-07-27T10:1${id}:00.000Z`,
      requestedAt: `2026-07-27T10:0${id}:00.000Z`,
      updatedAt: `2026-07-27T10:0${id}:00.000Z`,
    };
  }

  it("persists immutable approval evidence and supersedes it with an invalidation record", async () => {
    const store = createD1ContentPublicationStore(database);
    await store.saveApproval(approval);
    const next = {
      ...approval,
      id: createContentApprovalId(`approval_${"2".repeat(32)}`),
      fingerprint: {
        ...approval.fingerprint,
        value: "f".repeat(64),
      },
      approvedAt: "2026-07-27T10:02:00.000Z",
    };
    await store.saveApproval(next);

    await expect(store.findApproval(approval.id)).resolves.toEqual(
      expect.objectContaining({
        invalidatedAt: "2026-07-27T10:02:00.000Z",
      }),
    );
    await expect(store.findApproval(next.id)).resolves.toEqual(next);
    await expect(
      database
        .prepare(
          `SELECT blog_post_artifacts_json
           FROM content_approvals
           WHERE id = ?1`,
        )
        .bind(next.id)
        .first<{ blog_post_artifacts_json: string }>(),
    ).resolves.toEqual({
      blog_post_artifacts_json: JSON.stringify(
        next.fingerprint.postArtifacts,
      ),
    });
    await expect(
      database
        .prepare(
          `UPDATE content_approvals
           SET approved_by = 'membership-other'
           WHERE id = ?1`,
        )
        .bind(approval.id)
        .run(),
    ).rejects.toThrow(/content_approvals_are_immutable/u);
  });

  it("rejects a human publication claim when membership is revoked before the D1 commit", async () => {
    const store = createD1ContentPublicationStore(database);
    await store.saveApproval(approval);
    await database
      .prepare(
        `UPDATE human_memberships
         SET status = 'suspended', updated_at = ?1
         WHERE site_id = ?2 AND id = ?3`,
      )
      .bind(
        "2026-07-27T10:02:00.000Z",
        referenceSiteDefinition.site.id,
        membershipId,
      )
      .run();

    await expect(
      store.claimPublication(
        publication("1", "revoked-before-publication-commit"),
      ),
    ).rejects.toMatchObject({
      code: "publication_requester_not_active",
    });
    expect(
      await database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM content_publications
           WHERE idempotency_key = 'revoked-before-publication-commit'`,
        )
        .first(),
    ).toEqual({ count: 0 });
  });

  it("admits an immediate MCP publication with the exact current D1 grant", async () => {
    const store = createD1ContentPublicationStore(database);
    await store.saveApproval(approval);
    await database.batch([
      database
        .prepare(
          `INSERT INTO mcp_connections (
             id, actor_id, site_id, oauth_client_id, redirect_uri, scopes_json,
             status, created_by_membership_id, created_at, revoked_at
           ) VALUES (
             'connection-publish', 'actor-publish', ?1, 'client-publish',
             'https://client.example/callback', '["site.read"]', 'active',
             ?2, ?3, NULL
           )`,
        )
        .bind(
          referenceSiteDefinition.site.id,
          membershipId,
          "2026-07-27T10:02:00.000Z",
        ),
      database.prepare(
        `INSERT INTO mcp_connection_scopes (connection_id, scope) VALUES
           ('connection-publish', 'site.read'),
           ('connection-publish', 'content.draft'),
           ('connection-publish', 'publication.publish')`,
      ),
    ]);
    const requested = {
      ...publication("1", "mcp-immediate-publication"),
      requestedBy: createContentActorId("mcp-actor-publish"),
    };

    await expect(
      store.claimPublication(requested, undefined, {
        kind: "mcp",
        connectionId: "connection-publish",
        actorId: "actor-publish",
        operation: "foundry.publication.request",
        requiredScopes: ["publication.publish", "content.draft"],
        audit: {
          invocationId: "invocation-mcp-immediate-publication",
          connectionId: "connection-publish",
          actorId: "actor-publish",
          siteId: referenceSiteDefinition.site.id,
          operation: "foundry.publication.request",
          inputHash: "1".repeat(64),
          protocolVersion: "2025-11-25",
          scopesEvaluated: ["publication.publish", "content.draft"],
          outcome: "allowed",
          reason: null,
          occurredAt: "2026-07-27T10:02:00.000Z",
          contractVersion: "foundry.mcp.v1",
          idempotencyKey: "client-mcp-immediate-publication",
          workspaceId,
          revision: 0,
          approvalId: approval.id,
          deriveResultHash: ({ operationId, state }) =>
            Promise.resolve(`derived:${operationId}:${state}`),
        },
      }),
    ).resolves.toEqual({ state: "claimed", publication: requested });
    await expect(store.findPublication(requested.id)).resolves.toEqual(
      requested,
    );
    await expect(
      database
        .prepare(
          `SELECT idempotency_key, workspace_id, revision, approval_id,
                  publication_id, schedule_id, scopes_json, result_hash
           FROM mcp_audit_events
           WHERE invocation_id = 'invocation-mcp-immediate-publication'`,
        )
        .first(),
    ).resolves.toEqual({
      idempotency_key: "client-mcp-immediate-publication",
      workspace_id: workspaceId,
      revision: 0,
      approval_id: approval.id,
      publication_id: requested.id,
      schedule_id: null,
      scopes_json: JSON.stringify([
        "publication.publish",
        "content.draft",
      ]),
      // The store records the hash the caller derives from the outcome it is
      // about to commit, not a value the caller supplied up front.
      result_hash: `derived:${requested.id}:${requested.status}`,
    });
  });

  it("admits a design-scoped MCP publication without a content draft grant", async () => {
    // A revision that changes only Design-group fields requires design.draft.
    // The store must enforce the scope set the application layer derived from
    // the calling principal; it cannot assume a content.draft fallback, which
    // would reject this legitimate publication outright.
    const store = createD1ContentPublicationStore(database);
    await store.saveApproval(approval);
    await database.batch([
      database
        .prepare(
          `INSERT INTO mcp_connections (
             id, actor_id, site_id, oauth_client_id, redirect_uri, scopes_json,
             status, created_by_membership_id, created_at, revoked_at
           ) VALUES (
             'connection-design', 'actor-design', ?1, 'client-design',
             'https://client.example/callback', '["site.read"]', 'active',
             ?2, ?3, NULL
           )`,
        )
        .bind(
          referenceSiteDefinition.site.id,
          membershipId,
          "2026-07-27T10:02:00.000Z",
        ),
      database.prepare(
        `INSERT INTO mcp_connection_scopes (connection_id, scope) VALUES
           ('connection-design', 'site.read'),
           ('connection-design', 'design.draft'),
           ('connection-design', 'publication.publish')`,
      ),
    ]);
    const requested = {
      ...publication("1", "mcp-design-publication"),
      requestedBy: createContentActorId("mcp-actor-design"),
    };

    await expect(
      store.claimPublication(requested, undefined, {
        kind: "mcp",
        connectionId: "connection-design",
        actorId: "actor-design",
        operation: "foundry.publication.request",
        requiredScopes: ["publication.publish", "design.draft"],
      }),
    ).resolves.toEqual({ state: "claimed", publication: requested });
  });

  it("requires the publish scope for an immediate claim that lists none", async () => {
    // The publication scope implied by the operation kind is enforced by the
    // claim statement itself, so a caller cannot omit it from requiredScopes
    // to admit a connection that was never granted publication authority.
    const store = createD1ContentPublicationStore(database);
    await store.saveApproval(approval);
    await database.batch([
      database
        .prepare(
          `INSERT INTO mcp_connections (
             id, actor_id, site_id, oauth_client_id, redirect_uri, scopes_json,
             status, created_by_membership_id, created_at, revoked_at
           ) VALUES (
             'connection-draft-only', 'actor-draft-only', ?1,
             'client-draft-only', 'https://client.example/callback',
             '["site.read"]', 'active', ?2, ?3, NULL
           )`,
        )
        .bind(
          referenceSiteDefinition.site.id,
          membershipId,
          "2026-07-27T10:02:00.000Z",
        ),
      database.prepare(
        `INSERT INTO mcp_connection_scopes (connection_id, scope) VALUES
           ('connection-draft-only', 'site.read'),
           ('connection-draft-only', 'content.draft')`,
      ),
    ]);
    const requested = {
      ...publication("1", "mcp-publish-scope-omitted"),
      requestedBy: createContentActorId("mcp-actor-draft-only"),
    };

    await expect(
      store.claimPublication(requested, undefined, {
        kind: "mcp",
        connectionId: "connection-draft-only",
        actorId: "actor-draft-only",
        operation: "foundry.publication.request",
        requiredScopes: ["content.draft"],
      }),
    ).rejects.toMatchObject({
      code: "publication_authority_not_current",
    });
    expect(
      await database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM content_publications
           WHERE idempotency_key = 'mcp-publish-scope-omitted'`,
        )
        .first(),
    ).toEqual({ count: 0 });
  });

  it("rejects an immediate MCP publication revoked before the D1 claim", async () => {
    const store = createD1ContentPublicationStore(database);
    await store.saveApproval(approval);
    await database.batch([
      database
        .prepare(
          `INSERT INTO mcp_connections (
             id, actor_id, site_id, oauth_client_id, redirect_uri, scopes_json,
             status, created_by_membership_id, created_at, revoked_at
           ) VALUES (
             'connection-publish-revoked', 'actor-publish-revoked', ?1,
             'client-publish-revoked', 'https://client.example/callback',
             '["site.read"]', 'revoked', ?2, ?3, ?3
           )`,
        )
        .bind(
          referenceSiteDefinition.site.id,
          membershipId,
          "2026-07-27T10:02:00.000Z",
        ),
      database.prepare(
        `INSERT INTO mcp_connection_scopes (connection_id, scope) VALUES
           ('connection-publish-revoked', 'site.read'),
           ('connection-publish-revoked', 'content.draft'),
           ('connection-publish-revoked', 'publication.publish')`,
      ),
    ]);

    await expect(
      store.claimPublication(
        {
          ...publication("1", "mcp-revoked-publication"),
          requestedBy: createContentActorId("mcp-actor-publish-revoked"),
        },
        undefined,
        {
          kind: "mcp",
          connectionId: "connection-publish-revoked",
          actorId: "actor-publish-revoked",
          operation: "foundry.publication.request",
          requiredScopes: ["publication.publish", "content.draft"],
        },
      ),
    ).rejects.toMatchObject({
      code: "publication_authority_not_current",
    });
    expect(
      await database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM content_publications
           WHERE idempotency_key = 'mcp-revoked-publication'`,
        )
        .first(),
    ).toEqual({ count: 0 });
  });

  it("reads a v1 approval row and fails it closed at the v2 publication boundary", async () => {
    const store = createD1ContentPublicationStore(database);
    const legacyApproval: ContentApproval = {
      ...approval,
      fingerprint: {
        ...approval.fingerprint,
        value: "f".repeat(64),
        serializationVersion:
          "foundry.site-definition.canonical-json.v1",
      },
    };
    await store.saveApproval(legacyApproval);
    await expect(store.findApproval(legacyApproval.id)).resolves.toEqual(
      legacyApproval,
    );

    const createCommit = vi.fn();
    const application = createContentPublicationApplication({
      store,
      revisions: {
        getRevision: (_workspaceId, revision) =>
          revisionApplication.queries.getRevision(revision),
        getCurrent: () => revisionApplication.queries.getCurrent(),
        isCurrent: (revision) =>
          revisionApplication.queries.isRevisionCurrent(revision),
        listContributors: async () => [actorId],
      },
      publisher: {
        getChannelConfigurationHash: async () => "channel-a",
        getProductionHead: async () => "a".repeat(40),
        isReleaseLive: async () => true,
        createCommit,
        reconcileCommit: vi.fn(),
        retryReference: vi.fn(),
        getDeploymentStatus: vi.fn(),
        retryDeployment: vi.fn(),
      },
    });

    await expect(
      application.commands.publish({
        workspaceId,
        approvalId: legacyApproval.id,
        requestedBy: membershipId,
        idempotencyKey: "reject-v1-approval-at-v2-boundary",
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: "approval_stale" }),
    );
    expect(createCommit).not.toHaveBeenCalled();
  });

  it("invalidates approval in the same D1 transaction that records a later revision", async () => {
    const store = createD1ContentPublicationStore(database);
    await store.saveApproval(approval);

    await revisionApplication.commands.save({
      actorId,
      workspaceId,
      schemaVersion: referenceSiteDefinition.schemaVersion,
      baseRevision: 0,
      edits: [{ path: "section_hero.title", value: "Changed after approval" }],
      idempotencyKey: "save-after-d1-approval-1",
    });

    await expect(store.findApproval(approval.id)).resolves.toEqual(
      expect.objectContaining({
        invalidatedAt: "2026-07-27T10:00:00.000Z",
      }),
    );
  });

  it("durably invalidates an approval when production changes", async () => {
    const store = createD1ContentPublicationStore(database);
    await store.saveApproval(approval);

    await expect(
      store.invalidateApproval({
        approvalId: approval.id,
        invalidatedAt: "2026-07-27T10:02:00.000Z",
        reason: "production_changed",
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        id: approval.id,
        invalidatedAt: "2026-07-27T10:02:00.000Z",
      }),
    );
    await expect(
      database
        .prepare(
          `SELECT reason
           FROM content_approval_invalidations
           WHERE approval_id = ?1`,
        )
        .bind(approval.id)
        .first<{ reason: string }>(),
    ).resolves.toEqual({ reason: "production_changed" });
  });

  it("does not insert an approval after the current revision has advanced", async () => {
    const store = createD1ContentPublicationStore(database);
    await revisionApplication.commands.save({
      actorId,
      workspaceId,
      schemaVersion: referenceSiteDefinition.schemaVersion,
      baseRevision: 0,
      edits: [{ path: "section_hero.title", value: "Advanced first" }],
      idempotencyKey: "advance-before-approval-1",
    });

    await expect(store.saveApproval(approval)).rejects.toEqual(
      expect.objectContaining({ code: "revision_not_current" }),
    );
    await expect(store.findApproval(approval.id)).resolves.toBeNull();
  });

  it("claims one active publication globally and records a blocked contender", async () => {
    const store = createD1ContentPublicationStore(database);
    await store.saveApproval(approval);
    const first = publication("1", "publish-d1-first-0001");
    const second = publication("2", "publish-d1-second-001");

    await expect(store.claimPublication(first)).resolves.toEqual({
      state: "claimed",
      publication: first,
    });
    await expect(store.findActivePublication()).resolves.toEqual(first);
    await expect(store.claimPublication(second)).resolves.toEqual({
      state: "blocked",
      publication: expect.objectContaining({
        id: second.id,
        status: "blocked",
        detail: "publication_in_progress",
      }),
    });
  });

  it("does not turn a transient claim failure into a blocked contender", async () => {
    const stableStore = createD1ContentPublicationStore(database);
    await stableStore.saveApproval(approval);
    let failNextBatch = true;
    const unstableDatabase: Parameters<
      typeof createD1ContentPublicationStore
    >[0] = {
      prepare: database.prepare.bind(database),
      batch(statements) {
        if (failNextBatch) {
          failNextBatch = false;
          return Promise.reject(new Error("transient_d1_failure"));
        }
        return database.batch(statements);
      },
    };
    const store = createD1ContentPublicationStore(unstableDatabase);
    const requested = publication("1", "publish-transient-claim-1");

    await expect(store.claimPublication(requested)).rejects.toThrow(
      "transient_d1_failure",
    );
    await expect(store.findLatestPublication(workspaceId)).resolves.toBeNull();
    await expect(store.claimPublication(requested)).resolves.toEqual({
      state: "claimed",
      publication: requested,
    });
  });

  it("atomically rejects a claim when the approval was invalidated before the lease", async () => {
    const store = createD1ContentPublicationStore(database);
    await store.saveApproval(approval);
    await revisionApplication.commands.save({
      actorId,
      workspaceId,
      schemaVersion: referenceSiteDefinition.schemaVersion,
      baseRevision: 0,
      edits: [{ path: "section_hero.title", value: "Invalidate first" }],
      idempotencyKey: "invalidate-before-claim-1",
    });
    const stale = publication("1", "publish-stale-claim-01");

    await expect(store.claimPublication(stale)).resolves.toEqual({
      state: "blocked",
      publication: expect.objectContaining({
        status: "blocked",
        detail: "approval_stale",
        leaseToken: null,
      }),
    });
  });

  it("fences revision saves while the Git commit lease is requested", async () => {
    const store = createD1ContentPublicationStore(database);
    await store.saveApproval(approval);
    await store.claimPublication(publication("1", "publish-save-fence-0001"));

    await expect(
      revisionApplication.commands.save({
        actorId,
        workspaceId,
        schemaVersion: referenceSiteDefinition.schemaVersion,
        baseRevision: 0,
        edits: [{ path: "section_hero.title", value: "Racing save" }],
        idempotencyKey: "save-during-publish-001",
      }),
    ).rejects.toThrow(/content_publication_commit_in_progress/u);
  });

  it("fences revision saves while an exact deployment retry is dispatching", async () => {
    const store = createD1ContentPublicationStore(database);
    await store.saveApproval(approval);
    const failed: ContentPublication = {
      ...publication("1", "publish-retry-fence-001", "failed"),
      commitSha: "c".repeat(40),
      detail: "cloudflare_build_failed",
      leaseToken: null,
      leaseExpiresAt: null,
    };
    await store.claimPublication(failed);
    let resolveRetry:
      | ((value: {
          state: "requested";
          deploymentId: string;
        }) => void)
      | undefined;
    const retryDeployment = vi.fn(
      () =>
        new Promise<{ state: "requested"; deploymentId: string }>(
          (resolve) => {
            resolveRetry = resolve;
          },
        ),
    );
    const publicationApplication = createContentPublicationApplication({
      store,
      revisions: {
        getRevision: (_workspaceId, revision) =>
          revisionApplication.queries.getRevision(revision),
        getCurrent: () => revisionApplication.queries.getCurrent(),
        isCurrent: (revision) =>
          revisionApplication.queries.isRevisionCurrent(revision),
        listContributors: async () => [actorId],
      },
      publisher: {
        getChannelConfigurationHash: async () => "channel-a",
        getProductionHead: async () => "c".repeat(40),
        isReleaseLive: async () => false,
        createCommit: vi.fn(),
        reconcileCommit: vi.fn(),
        retryReference: vi.fn(),
        getDeploymentStatus: vi.fn(),
        retryDeployment,
      },
      now: () => "2026-07-27T10:02:00.000Z",
    });
    const retry = publicationApplication.commands.retryDeployment(
      failed.id,
      membershipId,
    );
    await vi.waitFor(() => {
      expect(retryDeployment).toHaveBeenCalledOnce();
    });

    await expect(
      revisionApplication.commands.save({
        actorId,
        workspaceId,
        schemaVersion: referenceSiteDefinition.schemaVersion,
        baseRevision: 0,
        edits: [{ path: "section_hero.title", value: "Racing retry" }],
        idempotencyKey: "save-during-retry-0001",
      }),
    ).rejects.toThrow(/content_publication_commit_in_progress/u);

    resolveRetry?.({
      state: "requested",
      deploymentId: "build-retry-1",
    });
    await expect(retry).resolves.toEqual(
      expect.objectContaining({
        detail: "deployment_retry_requested",
        leaseToken: null,
        leaseExpiresAt: null,
      }),
    );
  });

  it("does not fence another workspace or the same workspace after lease expiry", async () => {
    const store = createD1ContentPublicationStore(database);
    await store.saveApproval(approval);
    const requested = publication("1", "publish-scoped-fence-001");
    await store.claimPublication(requested);

    const otherWorkspaceId = createContentWorkspaceId("workspace_parallel");
    const otherApplication = createContentRevisionApplication({
      siteDefinition: referenceSiteDefinition,
      store: createD1ContentRevisionStore(
        database,
        referenceSiteDefinition.site.id,
        otherWorkspaceId,
      ),
      workspaceId: otherWorkspaceId,
      actorId,
      rendererVersion: "renderer-v1",
      productionBase:
        `git:${"a".repeat(40)}@content:${"b".repeat(64)}`,
      now: () => "2026-07-27T10:00:00.000Z",
    });
    await otherApplication.commands.create({
      actorId,
      workspaceId: otherWorkspaceId,
      idempotencyKey: "create-parallel-workspace-1",
    });
    await expect(
      otherApplication.commands.save({
        actorId,
        workspaceId: otherWorkspaceId,
        schemaVersion: referenceSiteDefinition.schemaVersion,
        baseRevision: 0,
        edits: [{ path: "section_hero.title", value: "Parallel edit" }],
        idempotencyKey: "save-parallel-workspace-1",
      }),
    ).resolves.toEqual(expect.objectContaining({ revision: 1 }));

    await database
      .prepare(
        `UPDATE content_publications
         SET lease_expires_at = '2026-07-27T09:59:59.000Z'
         WHERE id = ?1`,
      )
      .bind(requested.id)
      .run();
    await expect(
      revisionApplication.commands.save({
        actorId,
        workspaceId,
        schemaVersion: referenceSiteDefinition.schemaVersion,
        baseRevision: 0,
        edits: [{ path: "section_hero.title", value: "Edit after expiry" }],
        idempotencyKey: "save-after-lease-expiry-1",
      }),
    ).resolves.toEqual(expect.objectContaining({ revision: 1 }));
  });

  it("replays a publication idempotency key without another operation", async () => {
    const store = createD1ContentPublicationStore(database);
    await store.saveApproval(approval);
    const first = publication("1", "publish-d1-replay-0001");
    await store.claimPublication(first);

    await expect(
      store.claimPublication({
        ...publication("2", "publish-d1-replay-0001"),
        approvalId: first.approvalId,
      }),
    ).resolves.toEqual({ state: "replayed", publication: first });
    expect(
      await database
        .prepare("SELECT COUNT(*) AS count FROM content_publications")
        .first<{ count: number }>(),
    ).toEqual({ count: 1 });
  });

  it("rejects an idempotency key reused for a different publish command", async () => {
    const store = createD1ContentPublicationStore(database);
    await store.saveApproval(approval);
    const first = publication("1", "publish-command-conflict-1");
    await store.claimPublication(first);

    await expect(
      store.claimPublication({
        ...publication("2", first.idempotencyKey),
        approvalId: first.approvalId,
        requestedBy: createHumanMembershipId("membership-other"),
      }),
    ).rejects.toEqual(new ContentPublicationIdempotencyError());
    await expect(
      store.claimPublication({
        ...publication("3", first.idempotencyKey),
        approvalId: first.approvalId,
        fingerprint: "f".repeat(64),
      }),
    ).rejects.toEqual(new ContentPublicationIdempotencyError());
    await expect(store.findPublication(first.id)).resolves.toEqual(first);
  });

  it("updates operational state with an append-only audit event", async () => {
    const store = createD1ContentPublicationStore(database);
    await store.saveApproval(approval);
    const requested = publication("1", "publish-d1-update-0001");
    await store.claimPublication(requested);
    const committed = {
      ...requested,
      status: "committed" as const,
      commitSha: "c".repeat(40),
      deploymentId: "build-123",
      deploymentRequestedAt: "2026-07-27T10:02:00.000Z",
      leaseToken: null,
      leaseExpiresAt: null,
      updatedAt: "2026-07-27T10:02:00.000Z",
    };

    await expect(store.updatePublication(committed)).resolves.toEqual(
      committed,
    );
    await expect(store.findLatestPublication(workspaceId)).resolves.toEqual(
      committed,
    );
    expect(
      await database
        .prepare(
          `SELECT status
           FROM content_publication_audit_events
           WHERE publication_id = ?1
           ORDER BY id`,
        )
        .bind(requested.id)
        .all<{ status: string }>(),
    ).toEqual({
      results: [{ status: "requested" }, { status: "committed" }],
      success: true,
      meta: expect.any(Object),
    });
  });

  it("returns published history with the approval fingerprint and ordered state evidence", async () => {
    const store = createD1ContentPublicationStore(database);
    await store.saveApproval(approval);
    const requested = publication("1", "publish-d1-history-0001");
    await store.claimPublication(requested);
    const live = {
      ...requested,
      status: "verified-live" as const,
      commitSha: "c".repeat(40),
      detail: null,
      leaseToken: null,
      leaseExpiresAt: null,
      updatedAt: "2026-07-27T10:04:00.000Z",
    };
    await store.updatePublication(live);

    let subrequests = 0;
    const rawStatements = new WeakMap<object, object>();
    const wrapStatement = (statement: any): any => {
      const wrapped = {
        bind(...values: unknown[]) {
          return wrapStatement(statement.bind(...values));
        },
        async all() {
          subrequests += 1;
          return statement.all();
        },
        async first() {
          subrequests += 1;
          return statement.first();
        },
        async run() {
          subrequests += 1;
          return statement.run();
        },
      };
      rawStatements.set(wrapped, statement);
      return wrapped;
    };
    const countedDatabase = {
      prepare(query: string) {
        return wrapStatement(database.prepare(query));
      },
      async batch(statements: readonly object[]) {
        subrequests += 1;
        return database.batch(
          statements.map(
            (statement) => rawStatements.get(statement) ?? statement,
          ) as Parameters<typeof database.batch>[0],
        );
      },
    } as unknown as typeof database;

    await expect(
      createD1ContentPublicationStore(
        countedDatabase,
      ).listPublicationHistory(),
    ).resolves.toEqual([
      {
        publication: live,
        approval,
        events: [
          {
            status: "requested",
            detail: null,
            commitSha: null,
            deploymentId: null,
            approvalFingerprint: approval.fingerprint.value,
            occurredAt: requested.updatedAt,
          },
          {
            status: "verified-live",
            detail: null,
            commitSha: "c".repeat(40),
            deploymentId: null,
            approvalFingerprint: approval.fingerprint.value,
            occurredAt: live.updatedAt,
          },
        ],
      },
    ]);
    expect(subrequests).toBe(2);
  });

  it("persists and verifies restore source identity for a derived workspace", async () => {
    const store = createD1ContentPublicationStore(database);
    const identity = {
      sourcePublicationId: createContentPublicationId(
        `publish_${"1".repeat(32)}`,
      ),
      workspaceId: createContentWorkspaceId("workspace_restore_identity"),
      actorId,
      idempotencyKey: "restore-identity-command-1",
    };

    await expect(store.claimRestoreIdentity(identity)).resolves.toBeUndefined();
    await expect(store.claimRestoreIdentity(identity)).resolves.toBeUndefined();
    await expect(
      store.claimRestoreIdentity({
        ...identity,
        sourcePublicationId: createContentPublicationId(
          `publish_${"2".repeat(32)}`,
        ),
      }),
    ).rejects.toEqual(new ContentPublicationIdempotencyError());
    expect(
      await database
        .prepare(
          `SELECT source_publication_id
           FROM content_publication_restore_identities
           WHERE workspace_id = ?1`,
        )
        .bind(identity.workspaceId)
        .first<{ source_publication_id: string }>(),
    ).toEqual({ source_publication_id: identity.sourcePublicationId });
  });

  it("audits only the winning lease-fenced update when contenders share a clock", async () => {
    const store = createD1ContentPublicationStore(database);
    await store.saveApproval(approval);
    const requested = publication("1", "publish-d1-audit-cas-0001");
    await store.claimPublication(requested);
    const transition = (detail: string): ContentPublication => ({
      ...requested,
      status: "committed",
      commitSha: "c".repeat(40),
      detail,
      leaseToken: null,
      leaseExpiresAt: null,
      updatedAt: "2026-07-27T10:02:00.000Z",
    });

    await Promise.all([
      store.updatePublication(transition("winner-a"), {
        expectedLeaseToken: requested.leaseToken ?? undefined,
      }),
      store.updatePublication(transition("winner-b"), {
        expectedLeaseToken: requested.leaseToken ?? undefined,
      }),
    ]);

    const current = await store.findPublication(requested.id);
    expect(current?.detail).toMatch(/^winner-[ab]$/u);
    expect(
      await database
        .prepare(
          `SELECT status, detail, occurred_at
           FROM content_publication_audit_events
           WHERE publication_id = ?1
           ORDER BY id`,
        )
        .bind(requested.id)
        .all<{
          status: string;
          detail: string | null;
          occurred_at: string;
        }>(),
    ).toEqual({
      results: [
        {
          status: "requested",
          detail: null,
          occurred_at: requested.updatedAt,
        },
        {
          status: "committed",
          detail: current?.detail,
          occurred_at: "2026-07-27T10:02:00.000Z",
        },
      ],
      success: true,
      meta: expect.any(Object),
    });
  });

  it("never replaces a publication commit with a different commit", async () => {
    const store = createD1ContentPublicationStore(database);
    await store.saveApproval(approval);
    const requested = publication("1", "publish-d1-commit-immutable");
    await store.claimPublication(requested);
    const committed: ContentPublication = {
      ...requested,
      status: "committed",
      commitSha: "c".repeat(40),
      detail: "commit-c",
      leaseToken: null,
      leaseExpiresAt: null,
      updatedAt: "2026-07-27T10:02:00.000Z",
    };
    await store.updatePublication(committed);

    await expect(
      store.updatePublication({
        ...committed,
        commitSha: "d".repeat(40),
        detail: "fictional-commit-d",
      }),
    ).resolves.toEqual(committed);
    await expect(store.findPublication(requested.id)).resolves.toEqual(
      committed,
    );
    expect(
      await database
        .prepare(
          `SELECT detail
           FROM content_publication_audit_events
           WHERE publication_id = ?1
           ORDER BY id`,
        )
        .bind(requested.id)
        .all<{ detail: string | null }>(),
    ).toEqual({
      results: [{ detail: null }, { detail: "commit-c" }],
      success: true,
      meta: expect.any(Object),
    });
  });

  it("requires the live unexpired lease token for a holder transition", async () => {
    const store = createD1ContentPublicationStore(database);
    await store.saveApproval(approval);
    const requested = publication("1", "publish-d1-lease-fence-1");
    await store.claimPublication(requested);

    await expect(
      store.renewPublicationLease({
        publicationId: requested.id,
        leaseToken: "lease-1",
        now: "2026-07-27T10:10:59.000Z",
        leaseExpiresAt: "2026-07-27T10:13:00.000Z",
      }),
    ).resolves.toBe(true);
    await expect(
      store.hasPublicationLease({
        publicationId: requested.id,
        leaseToken: "lease-1",
        now: "2026-07-27T10:11:00.000Z",
      }),
    ).resolves.toBe(true);
    await expect(
      store.hasPublicationLease({
        publicationId: requested.id,
        leaseToken: "lease-1",
        now: "2026-07-27T10:13:00.000Z",
      }),
    ).resolves.toBe(false);

    const renewed = {
      ...requested,
      leaseExpiresAt: "2026-07-27T10:13:00.000Z",
    };
    const committed = {
      ...renewed,
      status: "committed" as const,
      commitSha: "c".repeat(40),
      leaseToken: null,
      leaseExpiresAt: null,
      updatedAt: "2026-07-27T10:02:00.000Z",
    };
    await expect(
      store.updatePublication(committed, {
        expectedLeaseToken: "lease-wrong",
      }),
    ).resolves.toEqual(renewed);
    await expect(store.findPublication(requested.id)).resolves.toEqual(
      renewed,
    );
    await expect(
      store.updatePublication(committed, {
        expectedLeaseToken: "lease-1",
        expectedLeaseValidAt: "2026-07-27T10:13:00.000Z",
      }),
    ).resolves.toEqual(renewed);
    await expect(
      store.updatePublication(committed, {
        expectedLeaseToken: "lease-1",
        expectedLeaseValidAt: "2026-07-27T10:12:59.000Z",
      }),
    ).resolves.toEqual(committed);
  });

  it("refuses to renew a lease after its exact approval is invalidated", async () => {
    const store = createD1ContentPublicationStore(database);
    await store.saveApproval(approval);
    const requested = publication("1", "publish-d1-invalid-approval-lease");
    await store.claimPublication(requested);
    await store.invalidateApproval({
      approvalId: approval.id,
      invalidatedAt: "2026-07-27T10:05:00.000Z",
      reason: "production_changed",
    });

    await expect(
      store.renewPublicationLease({
        publicationId: requested.id,
        leaseToken: "lease-1",
        now: "2026-07-27T10:06:00.000Z",
        leaseExpiresAt: "2026-07-27T10:15:00.000Z",
      }),
    ).resolves.toBe(false);
    await expect(
      store.hasPublicationLease({
        publicationId: requested.id,
        leaseToken: "lease-1",
        now: "2026-07-27T10:06:00.000Z",
      }),
    ).resolves.toBe(false);
  });

  it("renews only the exact claimed deployment retry at the provider boundary", async () => {
    const store = createD1ContentPublicationStore(database);
    await store.saveApproval(approval);
    const requested = publication("1", "publish-d1-retry-boundary-1");
    await store.claimPublication(requested);
    const dispatching = {
      ...requested,
      status: "committed" as const,
      commitSha: "c".repeat(40),
      detail: "deployment_retry_dispatching",
      deploymentId: "retry-dispatch:exact",
      updatedAt: "2026-07-27T10:02:00.000Z",
    };
    await store.updatePublication(dispatching, {
      expectedLeaseToken: "lease-1",
      expectedLeaseValidAt: "2026-07-27T10:02:00.000Z",
    });

    await expect(
      store.renewPublicationLease({
        publicationId: requested.id,
        leaseToken: "lease-1",
        now: "2026-07-27T10:02:30.000Z",
        leaseExpiresAt: "2026-07-27T10:04:30.000Z",
        expectedStatus: "committed",
        expectedDetail: "deployment_retry_dispatching",
        expectedDeploymentId: "retry-dispatch:other",
      }),
    ).resolves.toBe(false);
    await expect(
      store.renewPublicationLease({
        publicationId: requested.id,
        leaseToken: "lease-1",
        now: "2026-07-27T10:02:30.000Z",
        leaseExpiresAt: "2026-07-27T10:04:30.000Z",
        expectedStatus: "committed",
        expectedDetail: "deployment_retry_dispatching",
        expectedDeploymentId: "retry-dispatch:exact",
      }),
    ).resolves.toBe(true);
  });

  it("keeps the meaningful publication discoverable ahead of a blocked contender", async () => {
    const store = createD1ContentPublicationStore(database);
    await store.saveApproval(approval);
    const requested = publication("1", "publish-d1-visible-0001");
    const contender = {
      ...publication("2", "publish-d1-contender-01"),
      requestedAt: "2026-07-27T10:09:00.000Z",
      updatedAt: "2026-07-27T10:09:00.000Z",
    };
    await store.claimPublication(requested);
    const blockedClaim = await store.claimPublication(contender);
    expect(blockedClaim).toEqual({
      state: "blocked",
      publication: expect.objectContaining({
        status: "blocked",
        detail: "publication_in_progress",
      }),
    });
    await store.updatePublication({
      ...blockedClaim.publication,
      detail: "approval_stale",
    });

    await expect(store.findLatestPublication(workspaceId)).resolves.toEqual(
      requested,
    );
  });

  it("does not let a stale refresh erase reconciled commit evidence", async () => {
    const store = createD1ContentPublicationStore(database);
    await store.saveApproval(approval);
    const requested = publication("1", "publish-d1-refresh-cas-1");
    await store.claimPublication(requested);
    const committed = {
      ...requested,
      status: "committed" as const,
      commitSha: "c".repeat(40),
      leaseToken: null,
      leaseExpiresAt: null,
      updatedAt: "2026-07-27T10:02:00.000Z",
    };
    await store.updatePublication(committed);

    await expect(
      store.updatePublication(
        {
          ...requested,
          status: "failed",
          detail: "publication_lease_expired",
          leaseToken: null,
          leaseExpiresAt: null,
          updatedAt: "2026-07-27T10:03:00.000Z",
        },
        {
          expectedStatus: requested.status,
          expectedUpdatedAt: requested.updatedAt,
        },
      ),
    ).resolves.toEqual(committed);
    await expect(store.findPublication(requested.id)).resolves.toEqual(
      committed,
    );
  });

  it("prevents stale refreshes from regressing deployed or verified-live state", async () => {
    const store = createD1ContentPublicationStore(database);
    await store.saveApproval(approval);
    const requested = publication("1", "publish-d1-monotonic-01");
    await store.claimPublication(requested);
    const deployed = {
      ...requested,
      status: "deployed" as const,
      commitSha: "c".repeat(40),
      leaseToken: null,
      leaseExpiresAt: null,
      updatedAt: "2026-07-27T10:03:00.000Z",
    };
    await store.updatePublication(deployed);

    await expect(
      store.updatePublication({
        ...deployed,
        status: "building",
        updatedAt: "2026-07-27T10:04:00.000Z",
      }),
    ).resolves.toEqual(deployed);

    const live = {
      ...deployed,
      status: "verified-live" as const,
      updatedAt: "2026-07-27T10:05:00.000Z",
    };
    await store.updatePublication(live);
    await expect(
      store.updatePublication({
        ...live,
        status: "unknown",
        updatedAt: "2026-07-27T10:06:00.000Z",
      }),
    ).resolves.toEqual(live);
    expect(
      await database
        .prepare(
          `SELECT status
           FROM content_publication_audit_events
           WHERE publication_id = ?1
           ORDER BY id`,
        )
        .bind(requested.id)
        .all<{ status: string }>(),
    ).toEqual({
      results: [
        { status: "requested" },
        { status: "deployed" },
        { status: "verified-live" },
      ],
      success: true,
      meta: expect.any(Object),
    });
  });

  it("enforces immutable invalidation and publication audit evidence", async () => {
    const store = createD1ContentPublicationStore(database);
    await store.saveApproval(approval);
    const next = {
      ...approval,
      id: createContentApprovalId(`approval_${"3".repeat(32)}`),
      fingerprint: { ...approval.fingerprint, value: "e".repeat(64) },
      approvedAt: "2026-07-27T10:03:00.000Z",
    };
    await store.saveApproval(next);
    const requested = publication("1", "publish-d1-immutable-1");
    await store.claimPublication({
      ...requested,
      approvalId: next.id,
      fingerprint: next.fingerprint.value,
    });

    await expect(
      database
        .prepare(
          `UPDATE content_approval_invalidations
           SET reason = 'production_changed'
           WHERE approval_id = ?1`,
        )
        .bind(approval.id)
        .run(),
    ).rejects.toThrow(/content_approval_invalidations_are_immutable/u);
    await expect(
      database
        .prepare(
          `DELETE FROM content_publication_audit_events
           WHERE publication_id = ?1`,
        )
        .bind(requested.id)
        .run(),
    ).rejects.toThrow(/content_publication_audit_is_immutable/u);
  });
});
