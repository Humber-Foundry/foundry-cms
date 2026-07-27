import { readFile } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";

import {
  createContentActorId,
  createContentApprovalFingerprint,
  createContentApprovalId,
  createContentPublicationId,
  createContentRevisionApplication,
  createContentWorkspaceId,
  createHumanMembershipId,
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
    const revisionApplication = createContentRevisionApplication({
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
      fingerprint: await createContentApprovalFingerprint(revision),
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
      detail: null,
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

  it("claims one active publication globally and records a blocked contender", async () => {
    const store = createD1ContentPublicationStore(database);
    await store.saveApproval(approval);
    const first = publication("1", "publish-d1-first-0001");
    const second = publication("2", "publish-d1-second-001");

    await expect(store.claimPublication(first)).resolves.toEqual({
      state: "claimed",
      publication: first,
    });
    await expect(store.claimPublication(second)).resolves.toEqual({
      state: "blocked",
      publication: expect.objectContaining({
        id: second.id,
        status: "blocked",
        detail: "publication_in_progress",
      }),
    });
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

  it("updates operational state with an append-only audit event", async () => {
    const store = createD1ContentPublicationStore(database);
    await store.saveApproval(approval);
    const requested = publication("1", "publish-d1-update-0001");
    await store.claimPublication(requested);
    const committed = {
      ...requested,
      status: "committed" as const,
      commitSha: "c".repeat(40),
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
});
