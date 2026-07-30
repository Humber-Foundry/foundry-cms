import { readFile } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";

import {
  createContentActorId,
  createContentRevisionApplication,
  createContentWorkspaceId,
  ContentRevisionIdempotencyError,
  mcpContractVersion,
  type McpReadAuditEvent,
} from "@foundry/application";
import { referenceSiteDefinition } from "@foundry/site-definition";

import { createD1McpConnectionStore } from "./d1-mcp-connection-store";
import { createD1McpPreviewStore } from "./d1-mcp-preview-store";
import { createD1ContentRevisionStore } from "./d1-content-revision-store";

describe("D1 MCP connection store", () => {
  let miniflare: Miniflare;
  let database: Awaited<ReturnType<Miniflare["getD1Database"]>>;

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
    await database
      .prepare(
        `INSERT INTO human_users (id, email, created_at)
         VALUES ('user-owner', 'owner@example.test', ?1)`,
      )
      .bind("2026-07-29T18:00:00.000Z")
      .run();
    await database
      .prepare(
        `INSERT INTO human_memberships (
           id, site_id, user_id, email, identity_issuer, identity_subject,
           role, status, created_at, updated_at
         ) VALUES (
           'membership-owner', ?1, 'user-owner', 'owner@example.test',
           'https://access.example', 'owner-subject', 'owner', 'active', ?2, ?2
         )`,
      )
      .bind(
        referenceSiteDefinition.site.id,
        "2026-07-29T18:00:00.000Z",
      )
      .run();
  });

  it("commits workspace/revision idempotency and MCP audit in one D1 batch", async () => {
    const actorId = createContentActorId("mcp-joined-audit");
    const workspaceId = createContentWorkspaceId("workspace_mcp_joined_audit");
    const application = createContentRevisionApplication({
      siteDefinition: referenceSiteDefinition,
      store: createD1ContentRevisionStore(
        database,
        referenceSiteDefinition.site.id,
        workspaceId,
      ),
      workspaceId,
      actorId,
      rendererVersion: "renderer-55",
      productionBase: "a".repeat(40),
      now: () => "2026-07-29T18:00:00.000Z",
    });
    const audit = {
      invocationId: "invocation-workspace-joined",
      connectionId: "connection-joined",
      actorId: "joined-audit",
      siteId: referenceSiteDefinition.site.id,
      operation: "foundry.workspace.open",
      inputHash: "1".repeat(64),
      protocolVersion: "2025-11-25",
      scopesEvaluated: ["content.draft"],
      idempotencyKey: "workspace-joined-audit-1",
      occurredAt: "2026-07-29T18:00:00.000Z",
      contractVersion: "foundry.mcp.v1",
    } as const;
    await database
      .prepare(
        `INSERT INTO mcp_connections (
           id, actor_id, site_id, oauth_client_id, redirect_uri, scopes_json,
           status, created_by_membership_id, created_at
         ) VALUES (
           'connection-joined', 'joined-audit', ?1, 'client-joined',
           'https://client.example/callback', '["site.read"]', 'active',
           'membership-owner', ?2
         )`,
      )
      .bind(referenceSiteDefinition.site.id, audit.occurredAt)
      .run();
    await expect(
      application.commands.createWithReplay({
        actorId,
        workspaceId,
        idempotencyKey: "workspace-joined-audit-1",
        joinedAudit: audit,
      }),
    ).resolves.toMatchObject({ revision: { revision: 0 }, replayed: false });
    const replayApplication = createContentRevisionApplication({
      siteDefinition: referenceSiteDefinition,
      store: createD1ContentRevisionStore(
        database,
        referenceSiteDefinition.site.id,
        workspaceId,
      ),
      workspaceId,
      actorId,
      rendererVersion: "renderer-55",
      productionBase: "a".repeat(40),
      now: () => "2026-07-29T18:00:01.000Z",
    });
    await expect(
      replayApplication.commands.createWithReplay({
        actorId,
        workspaceId,
        idempotencyKey: "workspace-joined-audit-1",
        joinedAudit: {
          ...audit,
          invocationId: "invocation-workspace-replay",
          occurredAt: "2026-07-29T18:00:01.000Z",
        },
      }),
    ).resolves.toMatchObject({ revision: { revision: 0 }, replayed: true });
    await expect(
      database
        .prepare(
          `SELECT replay_count
           FROM mcp_mutation_receipts
           WHERE site_id = ?1 AND actor_id = ?2
             AND operation = 'foundry.workspace.open'
             AND idempotency_key = 'workspace-joined-audit-1'`,
        )
        .bind(referenceSiteDefinition.site.id, audit.actorId)
        .first(),
    ).resolves.toEqual({ replay_count: 1 });
    await expect(
      application.commands.saveWithReplay({
        actorId,
        workspaceId,
        schemaVersion: referenceSiteDefinition.schemaVersion,
        baseRevision: 0,
        edits: [{ path: "section_hero.title", value: "Joined audit" }],
        idempotencyKey: "revision-joined-audit-1",
        joinedAudit: {
          ...audit,
          invocationId: "invocation-revision-joined",
          operation: "foundry.content.patch",
          inputHash: "2".repeat(64),
          idempotencyKey: "shared-tool-key-001",
        },
      }),
    ).resolves.toMatchObject({ revision: { revision: 1 }, replayed: false });
    await expect(
      application.commands.saveWithReplay({
        actorId,
        workspaceId,
        schemaVersion: referenceSiteDefinition.schemaVersion,
        baseRevision: 1,
        edits: [{ path: "design.colour.accent", value: "clay" }],
        idempotencyKey: "internal-design-shared-key",
        joinedAudit: {
          ...audit,
          invocationId: "invocation-design-joined",
          operation: "foundry.design.patch",
          inputHash: "3".repeat(64),
          idempotencyKey: "shared-tool-key-001",
        },
      }),
    ).resolves.toMatchObject({ revision: { revision: 2 }, replayed: false });
    const otherWorkspaceId = createContentWorkspaceId(
      "workspace_mcp_joined_other",
    );
    const otherApplication = createContentRevisionApplication({
      siteDefinition: referenceSiteDefinition,
      store: createD1ContentRevisionStore(
        database,
        referenceSiteDefinition.site.id,
        otherWorkspaceId,
      ),
      workspaceId: otherWorkspaceId,
      actorId,
      rendererVersion: "renderer-55",
      productionBase: "a".repeat(40),
      now: () => "2026-07-29T18:02:00.000Z",
    });
    await otherApplication.commands.createWithReplay({
      actorId,
      workspaceId: otherWorkspaceId,
      idempotencyKey: "other-workspace-open-1",
      joinedAudit: {
        ...audit,
        invocationId: "invocation-workspace-other",
        inputHash: "4".repeat(64),
        idempotencyKey: "other-workspace-open-1",
      },
    });
    await expect(
      otherApplication.commands.saveWithReplay({
        actorId,
        workspaceId: otherWorkspaceId,
        schemaVersion: referenceSiteDefinition.schemaVersion,
        baseRevision: 0,
        edits: [{ path: "section_hero.title", value: "Wrong namespace" }],
        idempotencyKey: "internal-content-other-workspace",
        joinedAudit: {
          ...audit,
          invocationId: "invocation-content-other",
          operation: "foundry.content.patch",
          inputHash: "5".repeat(64),
          idempotencyKey: "shared-tool-key-001",
        },
      }),
    ).rejects.toBeInstanceOf(ContentRevisionIdempotencyError);
    await expect(
      application.commands.saveWithReplay({
        actorId,
        workspaceId,
        schemaVersion: referenceSiteDefinition.schemaVersion,
        baseRevision: 0,
        edits: [{ path: "section_hero.title", value: "Stale mutation" }],
        idempotencyKey: "internal-stale-content-key",
        joinedAudit: {
          ...audit,
          invocationId: "invocation-stale-joined",
          operation: "foundry.content.patch",
          inputHash: "6".repeat(64),
          idempotencyKey: "stale-tool-key-001",
        },
      }),
    ).rejects.toMatchObject({ currentRevision: 2 });
    await expect(
      database
        .prepare(
          `SELECT 1 AS recorded FROM mcp_mutation_receipts
           WHERE site_id = ?1 AND actor_id = ?2
             AND operation = 'foundry.content.patch'
             AND idempotency_key = 'stale-tool-key-001'`,
        )
        .bind(referenceSiteDefinition.site.id, audit.actorId)
        .first(),
    ).resolves.toBeNull();
    await expect(
      database
        .prepare(
          `SELECT 1 AS recorded FROM mcp_audit_events
           WHERE invocation_id = 'invocation-stale-joined'`,
        )
        .first(),
    ).resolves.toBeNull();
    await expect(
      database
        .prepare(
          `SELECT invocation_id, operation, idempotency_key, workspace_id,
                  revision, content_hash, result_hash, replayed
           FROM mcp_audit_events
           WHERE invocation_id LIKE 'invocation-%-joined'
           ORDER BY invocation_id`,
        )
        .all(),
    ).resolves.toMatchObject({
      results: [
        {
          invocation_id: "invocation-design-joined",
          operation: "foundry.design.patch",
          idempotency_key: "shared-tool-key-001",
          workspace_id: workspaceId,
          revision: 2,
          content_hash: expect.stringMatching(/^[0-9a-f]{64}$/u),
          result_hash: expect.stringMatching(/^[0-9a-f]{64}$/u),
          replayed: 0,
        },
        {
          invocation_id: "invocation-revision-joined",
          operation: "foundry.content.patch",
          idempotency_key: "shared-tool-key-001",
          workspace_id: workspaceId,
          revision: 1,
          content_hash: expect.stringMatching(/^[0-9a-f]{64}$/u),
          result_hash: expect.stringMatching(/^[0-9a-f]{64}$/u),
          replayed: 0,
        },
        {
          invocation_id: "invocation-workspace-joined",
          operation: "foundry.workspace.open",
          idempotency_key: "workspace-joined-audit-1",
          workspace_id: workspaceId,
          revision: 0,
          content_hash: expect.stringMatching(/^[0-9a-f]{64}$/u),
          result_hash: expect.stringMatching(/^[0-9a-f]{64}$/u),
          replayed: 0,
        },
      ],
    });
  });

  it("persists publication grants in canonical order and joined publication audit evidence", async () => {
    const store = createD1McpConnectionStore(database);
    await store.createAuthorizationGrant({
      connectionId: "connection-publication",
      actorId: "agent-publication",
      siteId: referenceSiteDefinition.site.id,
      clientId: "https://client.example/metadata.json",
      redirectUri: "https://client.example/callback",
      ownerMembershipId: "membership-owner",
      codeHash: "code-publication",
      codeChallenge: "challenge-publication",
      expiresAt: "2026-07-29T18:05:00.000Z",
      now: "2026-07-29T18:00:00.000Z",
      inputHash: "a".repeat(64),
      scopes: [
        "site.read",
        "content.draft",
        "publication.schedule",
        "publication.publish",
      ],
    });

    await expect(
      store.findCurrentConnection({
        connectionId: "connection-publication",
        siteId: referenceSiteDefinition.site.id,
      }),
    ).resolves.toMatchObject({
      scopes: [
        "site.read",
        "content.draft",
        "publication.schedule",
        "publication.publish",
      ],
    });

    await store.recordPublicationInvocation({
      invocationId: "invocation-publication",
      connectionId: "connection-publication",
      actorId: "agent-publication",
      siteId: referenceSiteDefinition.site.id,
      operation: "foundry.publication.request",
      inputHash: "b".repeat(64),
      protocolVersion: "2025-11-25",
      scopesEvaluated: ["publication.publish", "content.draft"],
      outcome: "allowed",
      reason: null,
      occurredAt: "2026-07-29T18:01:00.000Z",
      contractVersion: "foundry.mcp.v1",
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
      workspaceId: createContentWorkspaceId(
        "workspace_publication_audit",
      ),
      revision: 4,
      approvalId: "approval_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      publicationId: "publish_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      scheduleId: null,
      resultHash: "c".repeat(64),
      replayed: false,
    });
    await expect(
      database
        .prepare(
          `SELECT approval_id, publication_id, schedule_id, replayed
           FROM mcp_audit_events
           WHERE invocation_id = 'invocation-publication'`,
        )
        .first(),
    ).resolves.toEqual({
      approval_id: "approval_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      publication_id: "publish_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      schedule_id: null,
      replayed: 0,
    });
  });

  it("audits both callers and reports the deterministic patch-race loser as replayed", async () => {
    const actorId = createContentActorId("mcp-race-audit");
    const workspaceId = createContentWorkspaceId("workspace_mcp_race_audit");
    const baseStore = createD1ContentRevisionStore(
      database,
      referenceSiteDefinition.site.id,
      workspaceId,
    );
    const bootstrap = createContentRevisionApplication({
      siteDefinition: referenceSiteDefinition,
      store: baseStore,
      workspaceId,
      actorId,
      rendererVersion: "renderer-55",
      productionBase: "a".repeat(40),
      now: () => "2026-07-29T18:10:00.000Z",
    });
    await bootstrap.commands.createWithReplay({
      actorId,
      workspaceId,
      idempotencyKey: "workspace-race-bootstrap-1",
    });
    await database
      .prepare(
        `INSERT INTO mcp_connections (
           id, actor_id, site_id, oauth_client_id, redirect_uri, scopes_json,
           status, created_by_membership_id, created_at
         ) VALUES (
           'connection-race', 'race-audit', ?1, 'client-race',
           'https://client.example/callback', '["site.read"]',
           'active', 'membership-owner', ?2
         )`,
      )
      .bind(
        referenceSiteDefinition.site.id,
        "2026-07-29T18:10:00.000Z",
      )
      .run();

    let releaseLosingPersist!: () => void;
    const winningPersistStarted = new Promise<void>((resolve) => {
      releaseLosingPersist = resolve;
    });
    let releaseWinningReplay!: () => void;
    const losingReplayMissed = new Promise<void>((resolve) => {
      releaseWinningReplay = resolve;
    });
    const losingStoreBase = createD1ContentRevisionStore(
      database,
      referenceSiteDefinition.site.id,
      workspaceId,
    );
    const winningStoreBase = createD1ContentRevisionStore(
      database,
      referenceSiteDefinition.site.id,
      workspaceId,
    );
    const losingStore = {
      ...losingStoreBase,
      async replay(idempotencyKey: string, requestHash: string) {
        const result = await losingStoreBase.replay(
          idempotencyKey,
          requestHash,
        );
        releaseWinningReplay();
        return result;
      },
      async persist(
        command: Parameters<typeof losingStoreBase.persist>[0],
      ) {
        await winningPersistStarted;
        return losingStoreBase.persist(command);
      },
    };
    const winningStore = {
      ...winningStoreBase,
      async replay(idempotencyKey: string, requestHash: string) {
        await losingReplayMissed;
        return winningStoreBase.replay(idempotencyKey, requestHash);
      },
      async persist(
        command: Parameters<typeof winningStoreBase.persist>[0],
      ) {
        try {
          return await winningStoreBase.persist(command);
        } finally {
          releaseLosingPersist();
        }
      },
    };
    const applicationFor = (
      store: typeof losingStore,
      now: string,
    ) =>
      createContentRevisionApplication({
        siteDefinition: referenceSiteDefinition,
        store,
        workspaceId,
        actorId,
        rendererVersion: "renderer-55",
        productionBase: "a".repeat(40),
        now: () => now,
      });
    const command = {
      actorId,
      workspaceId,
      schemaVersion: referenceSiteDefinition.schemaVersion,
      baseRevision: 0,
      edits: [{ path: "section_hero.title", value: "One raced patch" }],
      idempotencyKey: "internal-raced-patch-1",
    } as const;
    const audit = {
      connectionId: "connection-race",
      actorId: "race-audit",
      siteId: referenceSiteDefinition.site.id,
      operation: "foundry.content.patch",
      inputHash: "7".repeat(64),
      protocolVersion: "2025-11-25",
      scopesEvaluated: ["site.read", "content.draft"],
      idempotencyKey: "raced-tool-patch-1",
      contractVersion: "foundry.mcp.v1",
    } as const;

    const [loser, winner] = await Promise.all([
      applicationFor(
        losingStore,
        "2026-07-29T18:10:02.000Z",
      ).commands.saveWithReplay({
        ...command,
        joinedAudit: {
          ...audit,
          invocationId: "invocation-race-loser",
          occurredAt: "2026-07-29T18:10:02.000Z",
        },
      }),
      applicationFor(
        winningStore,
        "2026-07-29T18:10:01.000Z",
      ).commands.saveWithReplay({
        ...command,
        joinedAudit: {
          ...audit,
          invocationId: "invocation-race-winner",
          occurredAt: "2026-07-29T18:10:01.000Z",
        },
      }),
    ]);

    expect(winner).toMatchObject({ revision: { revision: 1 }, replayed: false });
    expect(loser).toMatchObject({ revision: { revision: 1 }, replayed: true });
    await expect(
      database
        .prepare(
          `SELECT invocation_id, replayed
           FROM mcp_audit_events
           WHERE invocation_id LIKE 'invocation-race-%'
           ORDER BY invocation_id`,
        )
        .all(),
    ).resolves.toMatchObject({
      results: [
        { invocation_id: "invocation-race-loser", replayed: 1 },
        { invocation_id: "invocation-race-winner", replayed: 0 },
      ],
    });
    await expect(
      database
        .prepare(
          `SELECT replay_count
           FROM mcp_mutation_receipts
           WHERE site_id = ?1 AND actor_id = 'race-audit'
             AND operation = 'foundry.content.patch'
             AND idempotency_key = 'raced-tool-patch-1'`,
        )
        .bind(referenceSiteDefinition.site.id)
        .first(),
    ).resolves.toEqual({ replay_count: 1 });
  });

  it("returns and audits the authoritative result of concurrent different-input terminal failures", async () => {
    const previews = createD1McpPreviewStore(database);
    const siteId = referenceSiteDefinition.site.id;
    await database
      .prepare(
        `INSERT INTO mcp_connections (
           id, actor_id, site_id, oauth_client_id, redirect_uri, scopes_json,
           status, created_by_membership_id, created_at
         ) VALUES (
           'connection-failure-race', 'failure-race', ?1, 'client-race',
           'https://client.example/callback', '["site.read"]', 'active',
           'membership-owner', ?2
         )`,
      )
      .bind(siteId, "2026-07-29T18:20:00.000Z")
      .run();
    const principal = {
      connectionId: "connection-failure-race",
      actorId: "failure-race",
      siteId,
      clientId: "client-race",
      scopes: ["site.read", "content.draft"],
      status: "active",
    } as const;
    const audit = {
      connectionId: principal.connectionId,
      actorId: principal.actorId,
      siteId,
      operation: "foundry.content.patch",
      protocolVersion: "2025-11-25",
      scopesEvaluated: ["content.draft"],
      outcome: "allowed",
      reason: null,
      idempotencyKey: "different-input-failure-race",
      contractVersion: "foundry.mcp.v1",
    } as const;

    const results = await Promise.all([
      previews.recordMutationFailure({
        principal,
        audit: {
          ...audit,
          invocationId: "invocation-failure-a",
          inputHash: "a".repeat(64),
          occurredAt: "2026-07-29T18:20:01.000Z",
        },
        resultHash: "1".repeat(64),
        error: {
          code: "VALIDATION_FAILED",
          message: "Input A failed validation.",
          latestRevision: null,
          conflictResource: null,
        },
      }),
      previews.recordMutationFailure({
        principal,
        audit: {
          ...audit,
          invocationId: "invocation-failure-b",
          inputHash: "b".repeat(64),
          occurredAt: "2026-07-29T18:20:02.000Z",
        },
        resultHash: "2".repeat(64),
        error: {
          code: "STALE_REVISION",
          message: "Input B lost its expected revision.",
          latestRevision: 4,
          conflictResource:
            "foundry://workspaces/workspace_failure/revisions/4",
        },
      }),
    ]);

    const local = results.find(
      ({ error }) => error.code !== "IDEMPOTENCY_KEY_REUSED",
    );
    const conflict = results.find(
      ({ error }) => error.code === "IDEMPOTENCY_KEY_REUSED",
    );
    expect(local).toMatchObject({ replayed: false });
    expect(conflict).toEqual({
      error: {
        code: "IDEMPOTENCY_KEY_REUSED",
        message:
          "The idempotency key was already used for different input.",
        latestRevision: null,
        conflictResource: null,
      },
      observedAt: expect.any(String),
      replayed: true,
    });
    await expect(
      database
        .prepare(
          `SELECT invocation_id, outcome, reason, replayed
           FROM mcp_audit_events
           WHERE invocation_id LIKE 'invocation-failure-%'
           ORDER BY invocation_id`,
        )
        .all(),
    ).resolves.toMatchObject({
      results: [
        {
          invocation_id: "invocation-failure-a",
          outcome: "denied",
          reason: expect.stringMatching(
            /^(?:VALIDATION_FAILED|IDEMPOTENCY_KEY_REUSED)$/u,
          ),
          replayed: expect.any(Number),
        },
        {
          invocation_id: "invocation-failure-b",
          outcome: "denied",
          reason: expect.stringMatching(
            /^(?:STALE_REVISION|IDEMPOTENCY_KEY_REUSED)$/u,
          ),
          replayed: expect.any(Number),
        },
      ],
    });
    const audited = await database
      .prepare(
        `SELECT reason, replayed
         FROM mcp_audit_events
         WHERE invocation_id LIKE 'invocation-failure-%'`,
      )
      .all() as {
        results: Array<{ reason: string; replayed: number }>;
      };
    expect(
      audited.results.filter(
        ({ reason }) => reason === "IDEMPOTENCY_KEY_REUSED",
      ),
    ).toHaveLength(1);
    expect(
      audited.results.filter(({ replayed }) => replayed === 1),
    ).toHaveLength(1);
  });

  it("persists exactly the Owner-approved draft scopes for one connection", async () => {
    const store = createD1McpConnectionStore(database);
    await store.createAuthorizationGrant({
      connectionId: "connection-scoped",
      actorId: "mcp-actor-scoped",
      siteId: referenceSiteDefinition.site.id,
      clientId: "https://client.example/metadata.json",
      redirectUri: "https://client.example/callback",
      ownerMembershipId: "membership-owner",
      codeHash: "code-hash-scoped",
      codeChallenge: "challenge-scoped",
      expiresAt: "2026-07-29T18:05:00.000Z",
      now: "2026-07-29T18:00:00.000Z",
      inputHash: "f".repeat(64),
      scopes: ["site.read"],
    });
    await store.createAuthorizationGrant({
      connectionId: "connection-scoped-replacement",
      actorId: "mcp-actor-scoped-replacement",
      siteId: referenceSiteDefinition.site.id,
      clientId: "https://client.example/metadata.json",
      redirectUri: "https://client.example/callback",
      ownerMembershipId: "membership-owner",
      codeHash: "code-hash-scoped-step-up",
      codeChallenge: "challenge-scoped-step-up",
      expiresAt: "2026-07-29T18:05:00.000Z",
      now: "2026-07-29T18:01:00.000Z",
      inputHash: "a".repeat(64),
      scopes: ["site.read", "content.draft"],
      stepUpConnectionId: "connection-scoped",
      stepUpExpectedScopes: ["site.read"],
    });

    await expect(
      store.findCurrentConnection({
        connectionId: "connection-scoped",
        siteId: referenceSiteDefinition.site.id,
      }),
    ).resolves.toEqual({
      connectionId: "connection-scoped",
      actorId: "mcp-actor-scoped",
      siteId: referenceSiteDefinition.site.id,
      clientId: "https://client.example/metadata.json",
      scopes: ["site.read", "content.draft"],
      status: "active",
    });
    await expect(
      database
        .prepare(
          `SELECT scope FROM mcp_connection_scopes
           WHERE connection_id = 'connection-scoped'
           ORDER BY scope`,
        )
        .all<{ scope: string }>(),
    ).resolves.toMatchObject({
      results: [{ scope: "content.draft" }, { scope: "site.read" }],
    });
    await expect(
      store.findCurrentConnection({
        connectionId: "connection-scoped-replacement",
        siteId: referenceSiteDefinition.site.id,
      }),
    ).resolves.toBeNull();
    await expect(
      store.createAuthorizationGrant({
        connectionId: "connection-invalid-scope",
        actorId: "mcp-actor-invalid-scope",
        siteId: referenceSiteDefinition.site.id,
        clientId: "https://client.example/metadata.json",
        redirectUri: "https://client.example/callback",
        ownerMembershipId: "membership-owner",
        codeHash: "code-hash-invalid-scope",
        codeChallenge: "challenge-invalid-scope",
        expiresAt: "2026-07-29T18:05:00.000Z",
        now: "2026-07-29T18:00:00.000Z",
        inputHash: "e".repeat(64),
        scopes: ["design.draft"],
      }),
    ).rejects.toThrow(/mcp_authorization_scope_invalid/u);
    await expect(
      store.createAuthorizationGrant({
        connectionId: "connection-downgrade",
        actorId: "mcp-actor-downgrade",
        siteId: referenceSiteDefinition.site.id,
        clientId: "https://client.example/metadata.json",
        redirectUri: "https://client.example/callback",
        ownerMembershipId: "membership-owner",
        codeHash: "code-hash-downgrade",
        codeChallenge: "challenge-downgrade",
        expiresAt: "2026-07-29T18:05:00.000Z",
        now: "2026-07-29T18:00:00.000Z",
        inputHash: "9".repeat(64),
        scopes: ["site.read"],
        stepUpConnectionId: "connection-scoped",
        stepUpExpectedScopes: ["site.read", "content.draft"],
      }),
    ).rejects.toThrow(/mcp_authorization_scope_invalid/u);

    await database
      .prepare(
        `INSERT INTO content_workspaces (
           workspace_id, site_id, owner_actor_id, production_base,
           schema_version, renderer_version, current_revision,
           current_content_hash, lifecycle, created_at, updated_at
         ) VALUES (
           'workspace_mcp_preview', ?1, 'mcp-mcp-actor-scoped', ?2,
           ?3, 'renderer-55', 0, ?4, 'open', ?5, ?5
         )`,
      )
      .bind(
        referenceSiteDefinition.site.id,
        "a".repeat(40),
        referenceSiteDefinition.schemaVersion,
        "b".repeat(64),
        "2026-07-29T18:00:00.000Z",
      )
      .run();
    await database
      .prepare(
        `INSERT INTO content_revisions (
           workspace_id, revision, definition_json, content_hash,
           schema_version, renderer_version, production_base, request_hash,
           created_at, created_by
         ) VALUES (
           'workspace_mcp_preview', 0, ?1, ?2, ?3, 'renderer-55', ?4, ?5,
           ?6, 'mcp-mcp-actor-scoped'
         )`,
      )
      .bind(
        JSON.stringify(referenceSiteDefinition),
        "b".repeat(64),
        referenceSiteDefinition.schemaVersion,
        "a".repeat(40),
        "c".repeat(64),
        "2026-07-29T18:00:00.000Z",
      )
      .run();
    let previewSequence = 0;
    const previews = createD1McpPreviewStore(database, {
      createPreviewId: () => `preview-scoped-${++previewSequence}`,
      now: () => "2026-07-29T18:01:00.000Z",
    });
    const previewInput = {
      principal: {
        connectionId: "connection-scoped",
        actorId: "mcp-actor-scoped",
        siteId: referenceSiteDefinition.site.id,
        clientId: "https://client.example/metadata.json",
        scopes: ["site.read", "content.draft"],
      },
      workspaceId:
        "workspace_mcp_preview" as Parameters<
          typeof previews.preparePreview
        >[0]["workspaceId"],
      revision: 0,
      idempotencyKey: "preview-idempotency-1",
      requestHash: "d".repeat(64),
      artifactHash: "e".repeat(64),
      contentHash: "b".repeat(64),
      audit: {
        invocationId: "invocation-preview-scoped",
        connectionId: "connection-scoped",
        actorId: "mcp-actor-scoped",
        siteId: referenceSiteDefinition.site.id,
        operation: "foundry.preview.prepare",
        inputHash: "f".repeat(64),
        protocolVersion: "2025-11-25",
        scopesEvaluated: ["content.draft"],
        idempotencyKey: "preview-idempotency-1",
        outcome: "allowed" as const,
        reason: null,
        occurredAt: "2026-07-29T18:01:00.000Z",
        contractVersion: "foundry.mcp.v1",
      } as const,
    };
    await expect(previews.preparePreview(previewInput)).resolves.toEqual({
      previewId: "preview-scoped-1",
      replayed: false,
    });
    await expect(
      database
        .prepare(
          `SELECT operation, input_hash FROM mcp_audit_events
           WHERE invocation_id = 'invocation-preview-scoped'`,
        )
        .first(),
    ).resolves.toEqual({
      operation: "foundry.preview.prepare",
      input_hash: "f".repeat(64),
    });
    await expect(
      previews.replayMutation({
        principal: previewInput.principal,
        audit: {
          ...previewInput.audit,
          invocationId: "invocation-preview-replay",
        },
      }),
    ).resolves.toEqual({
      state: "succeeded",
      workspaceId: previewInput.workspaceId,
      revision: 0,
      contentHash: "b".repeat(64),
      resultHash: "e".repeat(64),
      previewId: "preview-scoped-1",
    });
    await expect(
      database
        .prepare(
          `SELECT replayed, workspace_id, revision, content_hash, preview_id
           FROM mcp_audit_events
           WHERE invocation_id = 'invocation-preview-replay'`,
        )
        .first(),
    ).resolves.toEqual({
      replayed: 1,
      workspace_id: previewInput.workspaceId,
      revision: 0,
      content_hash: "b".repeat(64),
      preview_id: "preview-scoped-1",
    });
    await expect(
      database
        .prepare(
          `SELECT replay_count FROM mcp_mutation_receipts
           WHERE site_id = ?1 AND actor_id = ?2
             AND operation = 'foundry.preview.prepare'
             AND idempotency_key = ?3`,
        )
        .bind(
          previewInput.principal.siteId,
          previewInput.principal.actorId,
          previewInput.idempotencyKey,
        )
        .first(),
    ).resolves.toEqual({ replay_count: 1 });
    const failedAudit = {
      ...previewInput.audit,
      invocationId: "invocation-stale-original",
      operation: "foundry.content.patch",
      inputHash: "7".repeat(64),
      idempotencyKey: "stale-terminal-key-1",
    } as const;
    await previews.recordMutationFailure({
      principal: previewInput.principal,
      audit: failedAudit,
      resultHash: "8".repeat(64),
      error: {
        code: "STALE_REVISION",
        message: "The workspace revision changed.",
        latestRevision: 3,
        conflictResource:
          "foundry://workspaces/workspace_mcp_preview/revisions/3",
      },
    });
    await expect(
      previews.replayMutation({
        principal: previewInput.principal,
        audit: {
          ...failedAudit,
          invocationId: "invocation-stale-replay",
        },
      }),
    ).rejects.toMatchObject({
      code: "STALE_REVISION",
      latestRevision: 3,
      conflictResource:
        "foundry://workspaces/workspace_mcp_preview/revisions/3",
      replayed: true,
      auditRecorded: true,
    });
    await expect(
      database
        .prepare(
          `SELECT result_state, error_code, latest_revision, replay_count
           FROM mcp_mutation_receipts
           WHERE site_id = ?1 AND actor_id = ?2
             AND operation = 'foundry.content.patch'
             AND idempotency_key = ?3`,
        )
        .bind(
          previewInput.principal.siteId,
          previewInput.principal.actorId,
          failedAudit.idempotencyKey,
        )
        .first(),
    ).resolves.toEqual({
      result_state: "failed",
      error_code: "STALE_REVISION",
      latest_revision: 3,
      replay_count: 1,
    });
    await expect(
      database
        .prepare(
          `SELECT outcome, reason, replayed
           FROM mcp_audit_events
           WHERE invocation_id = 'invocation-stale-replay'`,
        )
        .first(),
    ).resolves.toEqual({
      outcome: "denied",
      reason: "STALE_REVISION",
      replayed: 1,
    });
    await expect(previews.preparePreview(previewInput)).resolves.toEqual({
      previewId: "preview-scoped-1",
      replayed: true,
    });
    await expect(
      previews.preparePreview({
        ...previewInput,
        requestHash: "f".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    let markPersistenceReached!: () => void;
    let permitPersistence!: () => void;
    const persistenceReached = new Promise<void>((resolve) => {
      markPersistenceReached = resolve;
    });
    const persistencePermitted = new Promise<void>((resolve) => {
      permitPersistence = resolve;
    });
    const racingPreviews = createD1McpPreviewStore(database, {
      createPreviewId: () => "preview-raced-stale",
      now: () => "2026-07-29T18:02:00.000Z",
      async beforePersist() {
        markPersistenceReached();
        await persistencePermitted;
      },
    });
    const racingInput = {
      ...previewInput,
      idempotencyKey: "preview-race-1",
      requestHash: "1".repeat(64),
      artifactHash: "2".repeat(64),
      audit: {
        ...previewInput.audit,
        invocationId: "invocation-preview-race",
        inputHash: "3".repeat(64),
        idempotencyKey: "preview-race-1",
      },
    };
    const previewOutcome = racingPreviews.preparePreview(racingInput).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await persistenceReached;
    const racingActorId = createContentActorId("mcp-mcp-actor-scoped");
    const racingApplication = createContentRevisionApplication({
      siteDefinition: referenceSiteDefinition,
      store: createD1ContentRevisionStore(
        database,
        referenceSiteDefinition.site.id,
        previewInput.workspaceId,
      ),
      workspaceId: previewInput.workspaceId,
      actorId: racingActorId,
      rendererVersion: "renderer-55",
      productionBase: "a".repeat(40),
      now: () => "2026-07-29T18:01:30.000Z",
    });
    await racingApplication.commands.save({
      actorId: racingActorId,
      workspaceId: previewInput.workspaceId,
      schemaVersion: referenceSiteDefinition.schemaVersion,
      baseRevision: 0,
      edits: [{
        path: `${referenceSiteDefinition.site.id}.description`,
        value: "The patch won the preview race.",
      }],
      idempotencyKey: "preview-race-patch-1",
    });
    permitPersistence();
    await expect(previewOutcome).resolves.toMatchObject({
      error: {
        code: "STALE_REVISION",
        latestRevision: 1,
      },
    });
    await expect(
      database
        .prepare(
          `SELECT
             (
               SELECT COUNT(*)
               FROM mcp_preview_artifacts
               WHERE connection_id = 'connection-scoped'
                 AND idempotency_key = 'preview-race-1'
             ) AS artifact_count,
             (
               SELECT COUNT(*)
               FROM mcp_mutation_receipts
               WHERE site_id = ?1
                 AND actor_id = 'mcp-actor-scoped'
                 AND operation = 'foundry.preview.prepare'
                 AND idempotency_key = 'preview-race-1'
             ) AS receipt_count`,
        )
        .bind(referenceSiteDefinition.site.id)
        .first<{ artifact_count: number; receipt_count: number }>(),
    ).resolves.toEqual({ artifact_count: 0, receipt_count: 0 });
    await expect(
      store.revokeConnection({
        siteId: referenceSiteDefinition.site.id,
        connectionId: "connection-scoped",
        ownerMembershipId: "membership-owner",
        now: "2026-07-29T18:02:00.000Z",
        reason: "Scoped test complete.",
        inputHash: "8".repeat(64),
      }),
    ).resolves.toBe(true);
    await expect(
      database
        .prepare(
          `SELECT scopes_json FROM mcp_audit_events
           WHERE operation = 'foundry.connection.revoke'
             AND connection_id = 'connection-scoped'`,
        )
        .first<{ scopes_json: string }>(),
    ).resolves.toEqual({
      scopes_json: '["site.read","content.draft"]',
    });
  });

  it("atomically rejects one of two concurrent additive step-ups", async () => {
    const store = createD1McpConnectionStore(database);
    await store.createAuthorizationGrant({
      connectionId: "connection-step-up-race",
      actorId: "mcp-actor-step-up-race",
      siteId: referenceSiteDefinition.site.id,
      clientId: "https://client.example/metadata.json",
      redirectUri: "https://client.example/callback",
      ownerMembershipId: "membership-owner",
      codeHash: "code-hash-step-up-race-initial",
      codeChallenge: "challenge-step-up-race-initial",
      expiresAt: "2026-07-29T18:05:00.000Z",
      now: "2026-07-29T18:00:00.000Z",
      inputHash: "1".repeat(64),
      scopes: ["site.read"],
    });
    const stepUp = (scope: "content.draft" | "design.draft") =>
      store.createAuthorizationGrant({
        connectionId: `unused-${scope}`,
        actorId: `unused-${scope}`,
        siteId: referenceSiteDefinition.site.id,
        clientId: "https://client.example/metadata.json",
        redirectUri: "https://client.example/callback",
        ownerMembershipId: "membership-owner",
        codeHash: `code-hash-step-up-race-${scope}`,
        codeChallenge: `challenge-step-up-race-${scope}`,
        expiresAt: "2026-07-29T18:05:00.000Z",
        now: "2026-07-29T18:01:00.000Z",
        inputHash: (scope === "content.draft" ? "2" : "3").repeat(64),
        scopes: ["site.read", scope],
        stepUpConnectionId: "connection-step-up-race",
        stepUpExpectedScopes: ["site.read"],
      });

    const outcomes = await Promise.allSettled([
      stepUp("content.draft"),
      stepUp("design.draft"),
    ]);
    expect(outcomes.filter(({ status }) => status === "fulfilled"))
      .toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === "rejected"))
      .toHaveLength(1);
    const connection = await store.findCurrentConnection({
      connectionId: "connection-step-up-race",
      siteId: referenceSiteDefinition.site.id,
    });
    expect([
      ["site.read", "content.draft"],
      ["site.read", "design.draft"],
    ]).toContainEqual(connection?.scopes);
    await expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM mcp_authorization_codes
           WHERE code_hash IN (
             'code-hash-step-up-race-content.draft',
             'code-hash-step-up-race-design.draft'
           )`,
        )
        .first<{ count: number }>(),
    ).resolves.toEqual({ count: 1 });
    await expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM mcp_audit_events
           WHERE connection_id = 'connection-step-up-race'
             AND operation = 'foundry.connection.authorize'
             AND occurred_at = '2026-07-29T18:01:00.000Z'`,
        )
        .first<{ count: number }>(),
    ).resolves.toEqual({ count: 1 });
  });

  it("keeps an old refresh family bound to its pre-step-up scopes", async () => {
    const store = createD1McpConnectionStore(database);
    await store.createAuthorizationGrant({
      connectionId: "connection-refresh-scope",
      actorId: "mcp-actor-refresh-scope",
      siteId: referenceSiteDefinition.site.id,
      clientId: "https://client.example/metadata.json",
      redirectUri: "https://client.example/callback",
      ownerMembershipId: "membership-owner",
      codeHash: "code-refresh-scope-initial",
      codeChallenge: "challenge-refresh-scope-initial",
      expiresAt: "2026-07-29T18:05:00.000Z",
      now: "2026-07-29T18:00:00.000Z",
      inputHash: "4".repeat(64),
      scopes: ["site.read"],
    });
    await expect(
      store.exchangeAuthorizationCode({
        codeHash: "code-refresh-scope-initial",
        codeChallenge: "challenge-refresh-scope-initial",
        clientId: "https://client.example/metadata.json",
        redirectUri: "https://client.example/callback",
        refreshTokenHash: "refresh-scope-old",
        refreshFamilyId: "family-refresh-scope-old",
        refreshExpiresAt: "2026-08-29T18:00:00.000Z",
        now: "2026-07-29T18:01:00.000Z",
      }),
    ).resolves.toMatchObject({ scopes: ["site.read"] });
    await store.createAuthorizationGrant({
      connectionId: "unused-refresh-scope-step-up",
      actorId: "unused-refresh-scope-step-up",
      siteId: referenceSiteDefinition.site.id,
      clientId: "https://client.example/metadata.json",
      redirectUri: "https://client.example/callback",
      ownerMembershipId: "membership-owner",
      codeHash: "code-refresh-scope-step-up",
      codeChallenge: "challenge-refresh-scope-step-up",
      expiresAt: "2026-07-29T18:06:00.000Z",
      now: "2026-07-29T18:02:00.000Z",
      inputHash: "5".repeat(64),
      scopes: ["site.read", "content.draft"],
      stepUpConnectionId: "connection-refresh-scope",
      stepUpExpectedScopes: ["site.read"],
    });

    await expect(
      store.rotateRefreshToken({
        tokenHash: "refresh-scope-old",
        nextTokenHash: "refresh-scope-old-rotated",
        clientId: "https://client.example/metadata.json",
        nextExpiresAt: "2026-08-29T18:02:00.000Z",
        now: "2026-07-29T18:03:00.000Z",
      }),
    ).resolves.toMatchObject({
      state: "rotated",
      connection: {
        connectionId: "connection-refresh-scope",
        scopes: ["site.read"],
      },
    });
  });

  afterEach(async () => {
    await miniflare.dispose();
  });

  it("atomically creates an immutable site.read connection and one-time PKCE code", async () => {
    const store = createD1McpConnectionStore(database);
    await store.createAuthorizationGrant({
      connectionId: "connection-1",
      actorId: "mcp-actor-1",
      siteId: referenceSiteDefinition.site.id,
      clientId: "https://client.example/metadata.json",
      redirectUri: "https://client.example/callback",
      ownerMembershipId: "membership-owner",
      codeHash: "code-hash-1",
      codeChallenge: "challenge-1",
      expiresAt: "2026-07-29T18:05:00.000Z",
      now: "2026-07-29T18:00:00.000Z",
      inputHash: "a".repeat(64),
    });

    await expect(
      store.exchangeAuthorizationCode({
        codeHash: "code-hash-1",
        codeChallenge: "wrong-challenge",
        clientId: "https://client.example/metadata.json",
        redirectUri: "https://client.example/callback",
        refreshTokenHash: "wrong-refresh-hash",
        refreshFamilyId: "wrong-refresh-family",
        refreshExpiresAt: "2026-08-28T18:00:59.000Z",
        now: "2026-07-29T18:00:59.000Z",
      }),
    ).resolves.toBeNull();
    await expect(
      store.exchangeAuthorizationCode({
        codeHash: "code-hash-1",
        codeChallenge: "challenge-1",
        clientId: "https://client.example/metadata.json",
        redirectUri: "https://client.example/callback",
        refreshTokenHash: "refresh-hash-1",
        refreshFamilyId: "refresh-family-1",
        refreshExpiresAt: "2026-08-28T18:01:00.000Z",
        now: "2026-07-29T18:01:00.000Z",
      }),
    ).resolves.toEqual({
      connectionId: "connection-1",
      actorId: "mcp-actor-1",
      siteId: referenceSiteDefinition.site.id,
      clientId: "https://client.example/metadata.json",
      redirectUri: "https://client.example/callback",
      scopes: ["site.read"],
      status: "active",
      codeChallenge: "challenge-1",
    });
    await expect(
      store.exchangeAuthorizationCode({
        codeHash: "code-hash-1",
        codeChallenge: "challenge-1",
        clientId: "https://client.example/metadata.json",
        redirectUri: "https://client.example/callback",
        refreshTokenHash: "refresh-hash-replay",
        refreshFamilyId: "refresh-family-replay",
        refreshExpiresAt: "2026-08-28T18:01:01.000Z",
        now: "2026-07-29T18:01:01.000Z",
      }),
    ).resolves.toBeNull();
    await expect(
      database
        .prepare(
          `UPDATE mcp_connections SET actor_id = 'membership-owner'
           WHERE id = 'connection-1'`,
        )
        .run(),
    ).rejects.toThrow(/mcp_connection_identity_is_immutable/u);
  });

  it("rolls back authorization-code consumption when initial refresh creation fails", async () => {
    const store = createD1McpConnectionStore(database);
    await store.createAuthorizationGrant({
      connectionId: "connection-atomic-exchange",
      actorId: "actor-atomic-exchange",
      siteId: referenceSiteDefinition.site.id,
      clientId: "https://client.example/metadata.json",
      redirectUri: "https://client.example/callback",
      ownerMembershipId: "membership-owner",
      codeHash: "code-hash-atomic-exchange",
      codeChallenge: "challenge-atomic-exchange",
      expiresAt: "2026-07-29T18:05:00.000Z",
      now: "2026-07-29T18:00:00.000Z",
      inputHash: "b".repeat(64),
    });
    await database
      .prepare(
        `INSERT INTO mcp_refresh_tokens (
           token_hash, family_id, connection_id, oauth_client_id,
           expires_at, issued_at
         ) VALUES (
           'colliding-refresh-hash', 'existing-family',
           'connection-atomic-exchange',
           'https://client.example/metadata.json',
           '2026-08-28T18:00:00.000Z', '2026-07-29T18:00:00.000Z'
         )`,
      )
      .run();

    await expect(
      store.exchangeAuthorizationCode({
        codeHash: "code-hash-atomic-exchange",
        codeChallenge: "challenge-atomic-exchange",
        clientId: "https://client.example/metadata.json",
        redirectUri: "https://client.example/callback",
        refreshTokenHash: "colliding-refresh-hash",
        refreshFamilyId: "new-family",
        refreshExpiresAt: "2026-08-28T18:01:00.000Z",
        now: "2026-07-29T18:01:00.000Z",
      }),
    ).rejects.toThrow();
    await expect(
      database
        .prepare(
          `SELECT consumed_at FROM mcp_authorization_codes
           WHERE code_hash = 'code-hash-atomic-exchange'`,
        )
        .first<{ consumed_at: string | null }>(),
    ).resolves.toEqual({ consumed_at: null });
  });

  it("revokes in D1 before the next application command and preserves attribution", async () => {
    const store = createD1McpConnectionStore(database);
    await store.createAuthorizationGrant({
      connectionId: "connection-2",
      actorId: "mcp-actor-2",
      siteId: referenceSiteDefinition.site.id,
      clientId: "https://client.example/metadata.json",
      redirectUri: "https://client.example/callback",
      ownerMembershipId: "membership-owner",
      codeHash: "code-hash-2",
      codeChallenge: "challenge-2",
      expiresAt: "2026-07-29T18:05:00.000Z",
      now: "2026-07-29T18:00:00.000Z",
      inputHash: "b".repeat(64),
    });

    await expect(
      store.revokeConnection({
        siteId: referenceSiteDefinition.site.id,
        connectionId: "connection-2",
        ownerMembershipId: "membership-owner",
        now: "2026-07-29T18:02:00.000Z",
        reason: "Owner ended the test connection.",
        inputHash: "c".repeat(64),
      }),
    ).resolves.toBe(true);
    await expect(
      store.findCurrentConnection({
        siteId: referenceSiteDefinition.site.id,
        connectionId: "connection-2",
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        actorId: "mcp-actor-2",
        status: "revoked",
      }),
    );
    await expect(
      store.listConnections(referenceSiteDefinition.site.id),
    ).resolves.toEqual([
      expect.objectContaining({
        connectionId: "connection-2",
        clientId: "https://client.example/metadata.json",
        scopes: ["site.read"],
        status: "revoked",
        revokedAt: "2026-07-29T18:02:00.000Z",
      }),
    ]);
    await expect(
      database
        .prepare(
          `SELECT human_actor_id, revocation_reason, input_hash,
                  protocol_version
           FROM mcp_audit_events
           WHERE operation = 'foundry.connection.revoke'`,
        )
        .first(),
    ).resolves.toEqual({
      human_actor_id: "membership-owner",
      revocation_reason: "Owner ended the test connection.",
      input_hash: "c".repeat(64),
      protocol_version: "2025-11-25",
    });
  });

  it("writes attributable, redacted invocation history", async () => {
    const store = createD1McpConnectionStore(database);
    await store.createAuthorizationGrant({
      connectionId: "connection-3",
      actorId: "mcp-actor-3",
      siteId: referenceSiteDefinition.site.id,
      clientId: "https://client.example/metadata.json",
      redirectUri: "https://client.example/callback",
      ownerMembershipId: "membership-owner",
      codeHash: "code-hash-3",
      codeChallenge: "challenge-3",
      expiresAt: "2026-07-29T18:05:00.000Z",
      now: "2026-07-29T18:00:00.000Z",
      inputHash: "d".repeat(64),
    });
    const event: McpReadAuditEvent = {
      invocationId: "invocation-3",
      connectionId: "connection-3",
      actorId: "mcp-actor-3",
      siteId: referenceSiteDefinition.site.id,
      operation: "foundry.content.list",
      inputHash: "e".repeat(64),
      protocolVersion: "2025-11-25",
      scopesEvaluated: ["site.read"],
      outcome: "allowed",
      reason: null,
      occurredAt: "2026-07-29T18:02:00.000Z",
      contractVersion: mcpContractVersion,
    };
    await store.recordInvocation(event);

    await expect(
      database
        .prepare(
          `SELECT invocation_id, actor_id, operation, input_hash,
                  protocol_version, scopes_json, outcome, reason,
                  contract_version
           FROM mcp_audit_events WHERE invocation_id = ?1`,
        )
        .bind(event.invocationId)
        .first(),
    ).resolves.toEqual({
      invocation_id: "invocation-3",
      actor_id: "mcp-actor-3",
      operation: "foundry.content.list",
      input_hash: "e".repeat(64),
      protocol_version: "2025-11-25",
      scopes_json: '["site.read"]',
      outcome: "allowed",
      reason: null,
      contract_version: "foundry.mcp.v1",
    });
  });

  it("rotates refresh tokens once and revokes the whole grant on reuse", async () => {
    const store = createD1McpConnectionStore(database);
    await store.createAuthorizationGrant({
      connectionId: "connection-refresh",
      actorId: "mcp-actor-refresh",
      siteId: referenceSiteDefinition.site.id,
      clientId: "https://client.example/metadata.json",
      redirectUri: "https://client.example/callback",
      ownerMembershipId: "membership-owner",
      codeHash: "code-hash-refresh",
      codeChallenge: "challenge-refresh",
      expiresAt: "2026-07-29T18:05:00.000Z",
      now: "2026-07-29T18:00:00.000Z",
      inputHash: "f".repeat(64),
    });
    await store.exchangeAuthorizationCode({
      codeHash: "code-hash-refresh",
      codeChallenge: "challenge-refresh",
      clientId: "https://client.example/metadata.json",
      redirectUri: "https://client.example/callback",
      refreshTokenHash: "refresh-hash-1",
      refreshFamilyId: "refresh-family-1",
      refreshExpiresAt: "2026-08-28T18:00:00.000Z",
      now: "2026-07-29T18:00:00.000Z",
    });

    await expect(
      store.rotateRefreshToken({
        tokenHash: "refresh-hash-1",
        nextTokenHash: "refresh-hash-2",
        clientId: "https://client.example/metadata.json",
        nextExpiresAt: "2026-08-28T18:01:00.000Z",
        now: "2026-07-29T18:01:00.000Z",
      }),
    ).resolves.toEqual({
      state: "rotated",
      connection: expect.objectContaining({
        connectionId: "connection-refresh",
        status: "active",
      }),
    });
    await expect(
      store.rotateRefreshToken({
        tokenHash: "refresh-hash-1",
        nextTokenHash: "refresh-hash-3",
        clientId: "https://client.example/metadata.json",
        nextExpiresAt: "2026-08-28T18:02:00.000Z",
        now: "2026-07-29T18:02:00.000Z",
      }),
    ).resolves.toEqual({ state: "reuse_detected" });
    await expect(
      store.findCurrentConnection({
        siteId: referenceSiteDefinition.site.id,
        connectionId: "connection-refresh",
      }),
    ).resolves.toEqual(expect.objectContaining({ status: "revoked" }));
  });

  it("atomically enforces bounded rate buckets", async () => {
    const store = createD1McpConnectionStore(database);
    const input = {
      siteId: referenceSiteDefinition.site.id,
      bucketKey: "connection:tool",
      windowStartedAt: "2026-07-29T18:00:00.000Z",
      limit: 2,
    };
    await expect(store.consumeRateLimit(input)).resolves.toBe(true);
    await expect(store.consumeRateLimit(input)).resolves.toBe(true);
    await expect(store.consumeRateLimit(input)).resolves.toBe(false);
  });

  it("finds the latest verified live release through its site-bound workspace", async () => {
    const store = createD1McpConnectionStore(database);
    await database
      .prepare(
        `INSERT INTO content_workspaces (
           workspace_id, site_id, owner_actor_id, production_base,
           schema_version, renderer_version, current_revision,
           current_content_hash, lifecycle, created_at, updated_at
         ) VALUES (
           'workspace-live', ?1, 'membership-owner', 'base-sha', '1.3.0',
           'renderer-1', 1, 'content-hash', 'published', ?2, ?2
         )`,
      )
      .bind(
        referenceSiteDefinition.site.id,
        "2026-07-29T17:50:00.000Z",
      )
      .run();
    await database
      .prepare(
        `INSERT INTO content_revisions (
           workspace_id, revision, definition_json, content_hash,
           schema_version, renderer_version, production_base, request_hash,
           created_at, created_by
         ) VALUES (
           'workspace-live', 1, '{}', 'content-hash', '1.3.0',
           'renderer-1', 'base-sha', 'request-hash', ?1, 'membership-owner'
         )`,
      )
      .bind("2026-07-29T17:51:00.000Z")
      .run();
    await database
      .prepare(
        `INSERT INTO content_approvals (
           id, workspace_id, revision, fingerprint, channel,
           channel_configuration_hash, content_hash, design_hash,
           schema_version, renderer_version, production_base, artifact_hash,
           serialization_version, approved_by, approved_at
         ) VALUES (
           'approval-live', 'workspace-live', 1, 'fingerprint', 'site',
           'channel-hash', 'content-hash', 'design-hash', '1.3.0',
           'renderer-1', 'base-sha', 'artifact-hash', 'serialization-1',
           'membership-owner', ?1
         )`,
      )
      .bind("2026-07-29T17:52:00.000Z")
      .run();
    await database
      .prepare(
        `INSERT INTO content_publications (
           id, workspace_id, revision, approval_id, fingerprint,
           idempotency_key, command_identity, requested_by,
           contributors_json, expected_head, status, commit_sha,
           deployment_id, detail, requested_at, updated_at, mutation_token
         ) VALUES (
           'publication-live', 'workspace-live', 1, 'approval-live',
           'fingerprint', 'publish-key', 'command-id', 'membership-owner',
           '[]', 'base-sha', 'verified-live', ?1, 'deployment-live',
           'verified', ?2, ?3, 'mutation-token'
         )`,
      )
      .bind(
        "a".repeat(40),
        "2026-07-29T17:53:00.000Z",
        "2026-07-29T17:59:00.000Z",
      )
      .run();

    await expect(
      store.findLiveRelease(referenceSiteDefinition.site.id),
    ).resolves.toEqual({
      gitSha: "a".repeat(40),
      releaseId: "deployment-live",
      observedAt: "2026-07-29T17:59:00.000Z",
    });
  });

  it("prevents MCP audit history from being updated or deleted", async () => {
    const store = createD1McpConnectionStore(database);
    await store.createAuthorizationGrant({
      connectionId: "connection-immutable-audit",
      actorId: "actor-immutable-audit",
      siteId: referenceSiteDefinition.site.id,
      clientId: "https://client.example/metadata.json",
      redirectUri: "https://client.example/callback",
      ownerMembershipId: "membership-owner",
      codeHash: "code-hash-immutable-audit",
      codeChallenge: "challenge-immutable-audit",
      expiresAt: "2026-07-29T18:05:00.000Z",
      now: "2026-07-29T18:00:00.000Z",
      inputHash: "a".repeat(64),
    });

    await expect(
      database
        .prepare(
          `UPDATE mcp_audit_events SET outcome = 'denied'
           WHERE connection_id = 'connection-immutable-audit'`,
        )
        .run(),
    ).rejects.toThrow(/mcp_audit_events_are_immutable/u);
    await expect(
      database
        .prepare(
          `DELETE FROM mcp_audit_events
           WHERE connection_id = 'connection-immutable-audit'`,
        )
        .run(),
    ).rejects.toThrow(/mcp_audit_events_are_immutable/u);
  });

  it("rejects unbounded rate keys and removes expired rate buckets", async () => {
    const store = createD1McpConnectionStore(database);
    await database
      .prepare(
        `INSERT INTO mcp_rate_limit_buckets (
           site_id, bucket_key, window_started_at, request_count
         ) VALUES (?1, 'expired', '2026-07-28T18:00:00.000Z', 1)`,
      )
      .bind(referenceSiteDefinition.site.id)
      .run();

    await expect(
      store.consumeRateLimit({
        siteId: referenceSiteDefinition.site.id,
        bucketKey: "x".repeat(129),
        windowStartedAt: "2026-07-29T18:00:00.000Z",
        limit: 1,
      }),
    ).rejects.toThrow(/mcp_rate_limit_key_invalid/u);
    await store.consumeRateLimit({
      siteId: referenceSiteDefinition.site.id,
      bucketKey: "site",
      windowStartedAt: "2026-07-29T18:00:00.000Z",
      limit: 600,
    });
    await expect(
      database
        .prepare(
          `SELECT bucket_key FROM mcp_rate_limit_buckets
           WHERE bucket_key = 'expired'`,
        )
        .first(),
    ).resolves.toBeNull();
  });
});

it("upgrades the exact pre-blog schema without rewriting applied migrations", async () => {
  const upgradeMiniflare = new Miniflare({
    compatibilityDate: "2026-07-26",
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    d1Databases: ["FOUNDRY_DB"],
  });
  try {
    const upgradeDatabase =
      await upgradeMiniflare.getD1Database("FOUNDRY_DB");
    const applyMigration = async (migrationName: string) => {
      const migration = await readFile(
        new URL(`../migrations/${migrationName}`, import.meta.url),
        "utf8",
      );
      for (const statement of migration.trim().split(/\n\n+/u)) {
        await upgradeDatabase.prepare(statement).run();
      }
    };
    for (const migrationName of [
      "0001_human_access.sql",
      "0002_subscriber_ledger.sql",
      "0003_public_forms.sql",
      "0004_public_form_notifications.sql",
      "0005_content_revisions.sql",
      "0006_public_form_privacy.sql",
      "0007_content_publication.sql",
      "0008_media_assets.sql",
      "0009_content_publication_history_evidence.sql",
      "0010_content_publication_restore_identity.sql",
      "0011_blog_post_transition_audit.sql",
      "0012_content_approval_revision_hash.sql",
      "0013_blog_post_verified_state.sql",
      "0014_blog_post_artifact_fingerprints.sql",
      "0015_blog_post_render_artifacts.sql",
      "0016_campaign_authoring.sql",
      "0017_mcp_readonly_connections.sql",
    ]) {
      await applyMigration(migrationName);
    }
    await upgradeDatabase.batch([
      upgradeDatabase
        .prepare(
          `INSERT INTO human_users (id, email, created_at)
           VALUES ('upgrade-owner', 'upgrade@example.test', ?1)`,
        )
        .bind("2026-07-29T18:00:00.000Z"),
      upgradeDatabase
        .prepare(
          `INSERT INTO human_memberships (
             id, site_id, user_id, email, identity_issuer, identity_subject,
             role, status, created_at, updated_at
           ) VALUES (
             'upgrade-membership', ?1, 'upgrade-owner',
             'upgrade@example.test', 'https://access.example',
             'upgrade-owner', 'owner', 'active', ?2, ?2
           )`,
        )
        .bind(
          referenceSiteDefinition.site.id,
          "2026-07-29T18:00:00.000Z",
        ),
    ]);
    await upgradeDatabase.batch([
      upgradeDatabase.prepare(
        `INSERT INTO mcp_connections (
           id, actor_id, site_id, oauth_client_id, redirect_uri,
           scopes_json, status, created_by_membership_id, created_at
         ) VALUES (
           'upgrade-connection', 'upgrade-mcp-actor', ?1,
           'upgrade-client', 'https://client.example/callback',
           '["site.read"]', 'active', 'upgrade-membership', ?2
         )`,
      ).bind(
        referenceSiteDefinition.site.id,
        "2026-07-29T18:00:00.000Z",
      ),
      upgradeDatabase.prepare(
        `INSERT INTO mcp_authorization_codes (
           code_hash, connection_id, code_challenge, expires_at, created_at
         ) VALUES (
           'upgrade-code', 'upgrade-connection', 'challenge', ?1, ?2
         )`,
      ).bind(
        "2026-07-29T18:05:00.000Z",
        "2026-07-29T18:00:00.000Z",
      ),
      upgradeDatabase.prepare(
        `INSERT INTO mcp_refresh_tokens (
           token_hash, family_id, connection_id, oauth_client_id,
           expires_at, issued_at
         ) VALUES (
           'upgrade-refresh', 'upgrade-family', 'upgrade-connection',
           'upgrade-client', ?1, ?2
         )`,
      ).bind(
        "2026-08-29T18:00:00.000Z",
        "2026-07-29T18:00:00.000Z",
      ),
    ]);

    await applyMigration("0018_mcp_draft_scopes.sql");
    await applyMigration("0019_mcp_preview_artifacts.sql");
    await applyMigration("0020_mcp_mutation_receipts.sql");
    await applyMigration("0021_campaign_test_delivery.sql");
    await applyMigration("0022_blog_post_scheduling_archive.sql");
    await applyMigration("0023_mcp_publication_scopes.sql");

    await expect(
      upgradeDatabase
        .prepare(
          `SELECT connection.actor_id, code.connection_id,
                  token.connection_id
           FROM mcp_connections AS connection
           JOIN mcp_authorization_codes AS code
             ON code.connection_id = connection.id
           JOIN mcp_refresh_tokens AS token
             ON token.connection_id = connection.id
           WHERE connection.id = 'upgrade-connection'`,
        )
        .first(),
    ).resolves.toEqual({
      actor_id: "upgrade-mcp-actor",
      connection_id: "upgrade-connection",
    });
    await expect(upgradeDatabase.batch([
      upgradeDatabase
        .prepare(
          `INSERT INTO mcp_connections (
             id, actor_id, site_id, oauth_client_id, redirect_uri,
             scopes_json, status, created_by_membership_id, created_at
           ) VALUES (
             'draft-connection', 'draft-actor', ?1,
             'draft-client', 'https://client.example/draft',
             '["site.read"]', 'active', 'upgrade-membership', ?2
           )`,
        )
        .bind(
          referenceSiteDefinition.site.id,
          "2026-07-29T18:01:00.000Z",
        ),
      upgradeDatabase.prepare(
         `INSERT INTO mcp_connection_scopes (connection_id, scope)
         VALUES
           ('draft-connection', 'site.read'),
           ('draft-connection', 'content.draft')`,
      ),
    ])).resolves.toBeDefined();
    await expect(
      upgradeDatabase
        .prepare(
          `SELECT group_concat(scope, ',') AS scopes
           FROM (
             SELECT scope
             FROM mcp_connection_scopes
             WHERE connection_id = 'draft-connection'
             ORDER BY scope
           )`,
        )
        .first(),
    ).resolves.toEqual({
      scopes: "content.draft,site.read",
    });
    await expect(
      upgradeDatabase
        .prepare(
          `UPDATE mcp_connections
           SET actor_id = 'changed'
           WHERE id = 'upgrade-connection'`,
        )
        .run(),
    ).rejects.toThrow(/mcp_connection_identity_is_immutable/u);
    expect(
      await upgradeDatabase
        .prepare("PRAGMA foreign_key_check")
        .all(),
    ).toMatchObject({ results: [] });
    expect(
      await upgradeDatabase
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name = 'blog_post_schedules'`,
        )
        .first(),
    ).toEqual({ name: "blog_post_schedules" });
  } finally {
    await upgradeMiniflare.dispose();
  }
}, 15_000);
