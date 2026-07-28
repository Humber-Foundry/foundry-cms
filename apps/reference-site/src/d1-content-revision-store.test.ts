import { readFile } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";

import {
  ContentRevisionConflictError,
  ContentRevisionBookmarkError,
  ContentRevisionIdempotencyError,
  ContentWorkspaceAccessError,
  createContentActorId,
  createContentRevisionApplication,
  createContentWorkspaceId,
} from "@foundry/application";
import { referenceSiteDefinition } from "@foundry/site-definition";

import {
  createD1ContentRevisionStore,
  findLatestContentWorkspaceIdForActor,
} from "./d1-content-revision-store";

describe("D1 content revision store", () => {
  const editorActorId = createContentActorId("membership-editor");
  const collaboratorActorId = createContentActorId(
    "membership-collaborator",
  );
  const outsiderActorId = createContentActorId("membership-outsider");
  const workspaceId = createContentWorkspaceId("workspace_home");
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
    for (const name of [
      "0005_content_revisions.sql",
      "0008_media_assets.sql",
    ]) {
      const migration = await readFile(
        new URL(`../migrations/${name}`, import.meta.url),
        "utf8",
      );
      for (const statement of migration.trim().split(/\n\n+/)) {
        await database.prepare(statement).run();
      }
    }
  });

  afterEach(async () => {
    await miniflare.dispose();
  });

  function createApplication(
    actorId = editorActorId,
    targetWorkspaceId = workspaceId,
    now = "2026-07-27T12:00:00.000Z",
  ) {
    return createContentRevisionApplication({
      siteDefinition: referenceSiteDefinition,
      store: createD1ContentRevisionStore(
        database,
        referenceSiteDefinition.site.id,
        targetWorkspaceId,
      ),
      workspaceId: targetWorkspaceId,
      actorId,
      rendererVersion: "renderer-test-commit",
      productionBase: "published:site_foundry_reference@1.1.0",
      now: () => now,
    });
  }

  async function createWorkspace(
    application: ReturnType<typeof createApplication>,
    idempotencyKey: string,
  ) {
    return application.commands.create({
      actorId: editorActorId,
      workspaceId: application.workspaceId,
      idempotencyKey,
    });
  }

  it("persists immutable revisions and replays a completed key", async () => {
    const application = createApplication();
    await createWorkspace(application, "d1-content-create-save-0001");
    const command = {
      actorId: editorActorId,
      workspaceId,
      schemaVersion: referenceSiteDefinition.schemaVersion,
      baseRevision: 0,
      edits: [{ path: "section_hero.title", value: "Persisted in D1" }],
      idempotencyKey: "d1-content-save-0001",
    } as const;

    const first = await application.commands.save(command);
    const replay = await application.commands.save(command);
    const stored = await application.queries.getRevision(1, first.bookmark);

    expect(replay).toEqual(
      expect.objectContaining({
        workspaceId: first.workspaceId,
        revision: first.revision,
        definition: first.definition,
        inputs: first.inputs,
      }),
    );
    expect(first.bookmark).not.toBe("");
    expect(stored).toEqual(
      expect.objectContaining({
        workspaceId,
        revision: first.revision,
        definition: first.definition,
      }),
    );
    expect(
      await database
        .prepare("SELECT COUNT(*) AS count FROM content_revisions")
        .first<{ count: number }>(),
    ).toEqual({ count: 2 });
    expect(
      await database
        .prepare("SELECT COUNT(*) AS count FROM content_revision_audit_events")
        .first<{ count: number }>(),
    ).toEqual({ count: 1 });
    expect(
      await database
        .prepare(
          `SELECT owner_actor_id
           FROM content_workspaces
           WHERE workspace_id = ?1`,
        )
        .bind(workspaceId)
        .first<{ owner_actor_id: string }>(),
    ).toEqual({ owner_actor_id: "membership-editor" });
    expect(
      await database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM content_workspace_collaborators
           WHERE workspace_id = ?1`,
        )
        .bind(workspaceId)
        .first<{ count: number }>(),
    ).toEqual({ count: 0 });
  });

  it("preserves immutable stored 1.0 revisions without rewriting their fingerprinted definition", async () => {
    const legacy = structuredClone(
      referenceSiteDefinition,
    ) as unknown as Record<string, any>;
    legacy.definitionVersion = "1.0.0";
    legacy.schemaVersion = "1.0.0";
    delete legacy.design;
    legacy.home.sections.forEach(
      (section: Record<string, unknown>) => delete section.variant,
    );
    await database.batch([
      database
        .prepare(
          `INSERT INTO content_workspaces (
             workspace_id, site_id, owner_actor_id, production_base,
             schema_version, renderer_version, current_revision,
             current_content_hash, lifecycle, created_at, updated_at
           ) VALUES (?1, ?2, ?3, ?4, '1.0.0', ?5, 0, ?6, 'open', ?7, ?7)`,
        )
        .bind(
          workspaceId,
          referenceSiteDefinition.site.id,
          editorActorId,
          "published:site_foundry_reference@1.0.0",
          "renderer-test-commit",
          "legacy-content-hash",
          "2026-07-26T12:00:00.000Z",
        ),
      database
        .prepare(
          `INSERT INTO content_revisions (
             workspace_id, revision, definition_json, content_hash,
             schema_version, renderer_version, production_base, request_hash,
             created_at, created_by
           ) VALUES (?1, 0, ?2, ?3, '1.0.0', ?4, ?5, ?6, ?7, ?8)`,
        )
        .bind(
          workspaceId,
          JSON.stringify(legacy),
          "legacy-content-hash",
          "renderer-test-commit",
          "published:site_foundry_reference@1.0.0",
          "legacy-request-hash",
          "2026-07-26T12:00:00.000Z",
          "system:published-base",
        ),
    ]);
    const store = createD1ContentRevisionStore(
      database,
      referenceSiteDefinition.site.id,
      workspaceId,
    );
    await store.requireAccess(editorActorId);

    const restored = await store.getRevision(0);

    expect(restored?.inputs.schemaVersion).toBe("1.0.0");
    expect(restored?.definition).toEqual(legacy);
    expect(
      (restored?.definition as unknown as Record<string, unknown>).design,
    ).toBeUndefined();
  });

  it("atomically rejects a media binding after the occurrence head advances", async () => {
    const application = createApplication();
    await createWorkspace(application, "d1-content-media-race-create");
    await database
      .prepare(
        `INSERT INTO media_assets (
           site_id, asset_id, object_key, source_hash, file_name, content_type,
           byte_length, width, height, created_at, created_by
         ) VALUES (?1, 'asset_hero', 'media/site/asset/source', ?2,
           'hero.png', 'image/png', 128, 1600, 900, ?3, ?4)`,
      )
      .bind(
        referenceSiteDefinition.site.id,
        "a".repeat(64),
        "2026-07-27T12:00:00.000Z",
        editorActorId,
      )
      .run();
    for (const revision of [1, 2]) {
      await database
        .prepare(
          `INSERT INTO media_occurrence_revisions (
             site_id, workspace_id, occurrence_id, revision, asset_id,
             crop_json, created_at, created_by
           ) VALUES (?1, ?2, 'occurrence_home_hero', ?3, 'asset_hero',
             NULL, ?4, ?5)`,
        )
        .bind(
          referenceSiteDefinition.site.id,
          workspaceId,
          revision,
          "2026-07-27T12:00:00.000Z",
          editorActorId,
        )
        .run();
    }
    await database
      .prepare(
        `INSERT INTO media_occurrences (
           site_id, workspace_id, occurrence_id, current_revision,
           current_asset_id
         ) VALUES (?1, ?2, 'occurrence_home_hero', 2, 'asset_hero')`,
      )
      .bind(referenceSiteDefinition.site.id, workspaceId)
      .run();

    await expect(
      application.commands.saveMediaOccurrence({
        actorId: editorActorId,
        workspaceId,
        schemaVersion: referenceSiteDefinition.schemaVersion,
        baseRevision: 0,
        occurrence: {
          occurrenceId: "occurrence_home_hero",
          revision: 1,
          asset: {
            assetId: "asset_hero",
            width: 1600,
            height: 900,
            contentType: "image/png",
          },
          crop: null,
        },
        idempotencyKey: "d1-content-media-raced-head",
      }),
    ).rejects.toBeInstanceOf(ContentRevisionConflictError);
    await expect(application.queries.getCurrent()).resolves.toMatchObject({
      revision: 0,
    });
  });

  it("allows explicit collaborators and rejects outsiders", async () => {
    const owner = createApplication();
    await createWorkspace(owner, "d1-content-create-collaborator");
    await owner.commands.addCollaborator(collaboratorActorId);
    const collaborator = createApplication(collaboratorActorId);
    await expect(collaborator.queries.getCurrent()).resolves.toEqual(
      expect.objectContaining({ workspaceId }),
    );

    const outsider = createApplication(outsiderActorId);
    await expect(outsider.queries.getCurrent()).rejects.toThrow(
      "content_workspace_access_denied",
    );
  });

  it("does not create a missing workspace during an access check", async () => {
    const missingWorkspaceId = createContentWorkspaceId("workspace_missing");
    const store = createD1ContentRevisionStore(
      database,
      referenceSiteDefinition.site.id,
      missingWorkspaceId,
    );

    await expect(store.requireAccess(editorActorId)).rejects.toBeInstanceOf(
      ContentWorkspaceAccessError,
    );
    expect(
      await database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM content_workspaces
           WHERE workspace_id = ?1`,
        )
        .bind(missingWorkspaceId)
        .first<{ count: number }>(),
    ).toEqual({ count: 0 });
  });

  it("resumes the most recently updated accessible workspace", async () => {
    await expect(
      findLatestContentWorkspaceIdForActor(
        database,
        referenceSiteDefinition.site.id,
        editorActorId,
      ),
    ).resolves.toBeNull();

    await createApplication().commands.create({
      actorId: editorActorId,
      workspaceId,
      idempotencyKey: "d1-content-create-default",
    });
    const freshWorkspaceId = createContentWorkspaceId("workspace_fresh");
    await createApplication(
      editorActorId,
      freshWorkspaceId,
      "2026-07-27T13:00:00.000Z",
    ).commands.create({
      actorId: editorActorId,
      workspaceId: freshWorkspaceId,
      idempotencyKey: "d1-content-create-fresh",
    });

    await expect(
      findLatestContentWorkspaceIdForActor(
        database,
        referenceSiteDefinition.site.id,
        editorActorId,
      ),
    ).resolves.toBe(freshWorkspaceId);
    await expect(
      findLatestContentWorkspaceIdForActor(
        database,
        referenceSiteDefinition.site.id,
        outsiderActorId,
      ),
    ).resolves.toBeNull();
  });

  it("returns the current revision when optimistic concurrency fails", async () => {
    const application = createApplication();
    await createWorkspace(application, "d1-content-create-conflict");
    await application.commands.save({
      actorId: editorActorId,
      workspaceId,
      schemaVersion: referenceSiteDefinition.schemaVersion,
      baseRevision: 0,
      edits: [{ path: "section_hero.title", value: "Current revision" }],
      idempotencyKey: "d1-content-save-0002",
    });

    await expect(
      application.commands.save({
        actorId: editorActorId,
        workspaceId,
        schemaVersion: referenceSiteDefinition.schemaVersion,
        baseRevision: 0,
        edits: [{ path: "section_hero.title", value: "Stale revision" }],
        idempotencyKey: "d1-content-save-0003",
      }),
    ).rejects.toEqual(new ContentRevisionConflictError(1));
  });

  it("never acknowledges the losing definition in a concurrent save", async () => {
    const firstApplication = createApplication();
    const secondApplication = createApplication();
    await createWorkspace(firstApplication, "d1-content-create-concurrent");
    const [first, second] = await Promise.allSettled([
      firstApplication.commands.save({
        actorId: editorActorId,
        workspaceId,
        schemaVersion: referenceSiteDefinition.schemaVersion,
        baseRevision: 0,
        edits: [{ path: "section_hero.title", value: "Concurrent first" }],
        idempotencyKey: "d1-content-concurrent-0001",
      }),
      secondApplication.commands.save({
        actorId: editorActorId,
        workspaceId,
        schemaVersion: referenceSiteDefinition.schemaVersion,
        baseRevision: 0,
        edits: [{ path: "section_hero.title", value: "Concurrent second" }],
        idempotencyKey: "d1-content-concurrent-0002",
      }),
    ]);
    const fulfilled = [first, second].filter(
      (result) => result.status === "fulfilled",
    );
    const rejected = [first, second].filter(
      (result) => result.status === "rejected",
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const acknowledged = fulfilled[0] as PromiseFulfilledResult<
      Awaited<ReturnType<typeof firstApplication.commands.save>>
    >;
    const persisted = await firstApplication.queries.getRevision(1);
    expect(persisted?.definition).toEqual(acknowledged.value.definition);
    expect(rejected[0]).toEqual(
      expect.objectContaining({
        reason: expect.any(ContentRevisionConflictError),
      }),
    );
  });

  it("records one audit event for concurrent retries of the same key", async () => {
    const firstApplication = createApplication();
    const secondApplication = createApplication();
    await createWorkspace(firstApplication, "d1-content-create-retry");
    const command = {
      actorId: editorActorId,
      workspaceId,
      schemaVersion: referenceSiteDefinition.schemaVersion,
      baseRevision: 0,
      edits: [{ path: "section_hero.title", value: "One retried save" }],
      idempotencyKey: "d1-content-concurrent-0003",
    } as const;

    const [first, second] = await Promise.all([
      firstApplication.commands.save(command),
      secondApplication.commands.save(command),
    ]);

    expect(second).toEqual(
      expect.objectContaining({
        workspaceId: first.workspaceId,
        revision: first.revision,
        definition: first.definition,
      }),
    );
    expect(
      await database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM content_revision_audit_events
           WHERE workspace_id = ?1 AND revision = ?2`,
        )
        .bind(workspaceId, first.revision)
        .first<{ count: number }>(),
    ).toEqual({ count: 1 });
  });

  it("rechecks a raced receipt before reporting a stale base", async () => {
    const application = createApplication();
    await createWorkspace(application, "d1-content-create-raced-receipt");
    const base = await application.queries.getCurrent();
    const realStore = createD1ContentRevisionStore(
      database,
      referenceSiteDefinition.site.id,
      workspaceId,
    );
    const command: Parameters<typeof realStore.persist>[0] = {
      baseRevision: 0,
      idempotencyKey: "d1-content-raced-receipt",
      requestHash: "matching-request-hash",
      revision: {
        ...base,
        revision: 1,
        createdAt: "2026-07-27T12:01:00.000Z",
        createdBy: editorActorId,
      },
    };

    function storeWithFirstReceiptMiss(onMiss: () => Promise<void>) {
      let firstReceiptLookup = true;
      const racingDatabase = {
        prepare(query: string) {
          return database.prepare(query);
        },
        batch(statements: Parameters<typeof database.batch>[0]) {
          return database.batch(statements);
        },
        withSession(constraint?: "first-primary" | string) {
          const session = database.withSession(constraint);
          return {
            prepare(query: string) {
              const statement = session.prepare(query);
              if (
                firstReceiptLookup &&
                query.includes("FROM content_revision_receipts")
              ) {
                return {
                  bind(...values: unknown[]) {
                    const bound = statement.bind(...values);
                    return {
                      async first() {
                        firstReceiptLookup = false;
                        await onMiss();
                        return null;
                      },
                      run() {
                        return bound.run();
                      },
                    };
                  },
                };
              }
              return statement;
            },
            batch(statements: Parameters<typeof session.batch>[0]) {
              return session.batch(statements);
            },
            getBookmark() {
              return session.getBookmark();
            },
          };
        },
      } as unknown as Parameters<typeof createD1ContentRevisionStore>[0];
      return createD1ContentRevisionStore(
        racingDatabase,
        referenceSiteDefinition.site.id,
        workspaceId,
      );
    }

    const racedStore = storeWithFirstReceiptMiss(async () => {
      await realStore.persist(command);
    });
    await expect(racedStore.persist(command)).resolves.toEqual(
      expect.objectContaining({ workspaceId, revision: 1 }),
    );

    const mismatchedStore = storeWithFirstReceiptMiss(async () => {});
    await expect(
      mismatchedStore.persist({
        ...command,
        requestHash: "different-request-hash",
      }),
    ).rejects.toBeInstanceOf(ContentRevisionIdempotencyError);
  });

  it("rejects a key reused for different mutation input", async () => {
    const application = createApplication();
    await createWorkspace(application, "d1-content-create-idempotency");
    await application.commands.save({
      actorId: editorActorId,
      workspaceId,
      schemaVersion: referenceSiteDefinition.schemaVersion,
      baseRevision: 0,
      edits: [{ path: "section_hero.title", value: "First input" }],
      idempotencyKey: "d1-content-save-0004",
    });

    await expect(
      application.commands.save({
        actorId: editorActorId,
        workspaceId,
        schemaVersion: referenceSiteDefinition.schemaVersion,
        baseRevision: 0,
        edits: [{ path: "section_hero.title", value: "Different input" }],
        idempotencyKey: "d1-content-save-0004",
      }),
    ).rejects.toBeInstanceOf(ContentRevisionIdempotencyError);
  });

  it("scopes idempotency keys to one workspace", async () => {
    const otherWorkspaceId = createContentWorkspaceId("workspace_other");
    const first = createApplication();
    const second = createApplication(editorActorId, otherWorkspaceId);
    const sharedKey = "d1-content-save-shared";
    await createWorkspace(first, "d1-content-create-first");
    await createWorkspace(second, "d1-content-create-second");

    await first.commands.save({
      actorId: editorActorId,
      workspaceId,
      schemaVersion: referenceSiteDefinition.schemaVersion,
      baseRevision: 0,
      edits: [{ path: "section_hero.title", value: "First workspace" }],
      idempotencyKey: sharedKey,
    });
    await expect(
      second.commands.save({
        actorId: editorActorId,
        workspaceId: otherWorkspaceId,
        schemaVersion: referenceSiteDefinition.schemaVersion,
        baseRevision: 0,
        edits: [{ path: "section_hero.title", value: "Second workspace" }],
        idempotencyKey: sharedKey,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        workspaceId: otherWorkspaceId,
        revision: 1,
      }),
    );
    expect(
      await database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM content_revision_receipts
           WHERE idempotency_key = ?1`,
        )
        .bind(sharedKey)
        .first<{ count: number }>(),
    ).toEqual({ count: 2 });
  });

  it("prevents update and deletion of persisted revision rows", async () => {
    const application = createApplication();
    await application.commands.create({
      actorId: editorActorId,
      workspaceId,
      idempotencyKey: "d1-content-create-0001",
    });

    await expect(
      database
        .prepare(
          "UPDATE content_revisions SET created_by = 'changed' WHERE revision = 0",
        )
        .run(),
    ).rejects.toThrow(/content_revisions_are_immutable/);
    await expect(
      database
        .prepare("DELETE FROM content_revisions WHERE revision = 0")
        .run(),
    ).rejects.toThrow(/content_revisions_are_immutable/);
  });

  it("translates malformed bookmarks into a preview-safe domain error", async () => {
    const failingDatabase = {
      withSession() {
        return {
          prepare() {
            return {
              bind() {
                return {
                  async first() {
                    throw new Error("invalid_bookmark");
                  },
                };
              },
            };
          },
        };
      },
    } as unknown as Parameters<typeof createD1ContentRevisionStore>[0];
    const store = createD1ContentRevisionStore(
      failingDatabase,
      referenceSiteDefinition.site.id,
      workspaceId,
    );

    await expect(
      store.getRevision(0, "not-a-d1-bookmark"),
    ).rejects.toBeInstanceOf(ContentRevisionBookmarkError);
  });
});
