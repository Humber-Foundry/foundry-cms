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
      "0005_content_revisions.sql",
      "0007_content_publication.sql",
    ]) {
      const migration = await readFile(
        new URL(`../migrations/${migrationName}`, import.meta.url),
        "utf8",
      );
      for (const statement of migration.trim().split(/\n\n+/)) {
        await database.prepare(statement).run();
      }
    }
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
          `UPDATE content_approvals
           SET approved_by = 'membership-other'
           WHERE id = ?1`,
        )
        .bind(approval.id)
        .run(),
    ).rejects.toThrow(/content_approvals_are_immutable/u);
  });

  it("invalidates approval in the same D1 transaction that records a later revision", async () => {
    const store = createD1ContentPublicationStore(database);
    await store.saveApproval(approval);

    await revisionApplication.commands.save({
      actorId,
      workspaceId,
      schemaVersion: "1.1.0",
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
      schemaVersion: "1.1.0",
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
      schemaVersion: "1.1.0",
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
        schemaVersion: "1.1.0",
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
        schemaVersion: "1.1.0",
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
        schemaVersion: "1.1.0",
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
        schemaVersion: "1.1.0",
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
