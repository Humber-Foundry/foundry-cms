import { readFile } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";

import {
  ContentRevisionConflictError,
  ContentRevisionIdempotencyError,
  createContentRevisionApplication,
  createContentWorkspaceId,
} from "@foundry/application";
import { referenceSiteDefinition } from "@foundry/site-definition";

import { createD1ContentRevisionStore } from "./d1-content-revision-store";

describe("D1 content revision store", () => {
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
    const migration = await readFile(
      new URL("../migrations/0002_content_revisions.sql", import.meta.url),
      "utf8",
    );
    for (const statement of migration.trim().split(/\n\n+/)) {
      await database.prepare(statement).run();
    }
  });

  afterEach(async () => {
    await miniflare.dispose();
  });

  function createApplication(actorId = "membership-editor") {
    return createContentRevisionApplication({
      siteDefinition: referenceSiteDefinition,
      store: createD1ContentRevisionStore(
        database,
        referenceSiteDefinition.site.id,
        workspaceId,
      ),
      workspaceId,
      actorId,
      rendererVersion: "renderer-test-commit",
      productionBase: "published:site_foundry_reference@1.0.0",
      now: () => "2026-07-27T12:00:00.000Z",
    });
  }

  it("persists immutable revisions and replays a completed key", async () => {
    const application = createApplication();
    const command = {
      actorId: "membership-editor",
      workspaceId,
      schemaVersion: "1.0.0",
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

  it("allows explicit collaborators and rejects outsiders", async () => {
    const owner = createApplication();
    await owner.commands.addCollaborator("membership-collaborator");
    const collaborator = createApplication("membership-collaborator");
    await expect(collaborator.queries.getCurrent()).resolves.toEqual(
      expect.objectContaining({ workspaceId }),
    );

    const outsider = createApplication("membership-outsider");
    await expect(outsider.queries.getCurrent()).rejects.toThrow(
      "content_workspace_access_denied",
    );
  });

  it("returns the current revision when optimistic concurrency fails", async () => {
    const application = createApplication();
    await application.commands.save({
      actorId: "membership-editor",
      workspaceId,
      schemaVersion: "1.0.0",
      baseRevision: 0,
      edits: [{ path: "section_hero.title", value: "Current revision" }],
      idempotencyKey: "d1-content-save-0002",
    });

    await expect(
      application.commands.save({
        actorId: "membership-editor",
        workspaceId,
        schemaVersion: "1.0.0",
        baseRevision: 0,
        edits: [{ path: "section_hero.title", value: "Stale revision" }],
        idempotencyKey: "d1-content-save-0003",
      }),
    ).rejects.toEqual(new ContentRevisionConflictError(1));
  });

  it("rejects a key reused for different mutation input", async () => {
    const application = createApplication();
    await application.commands.save({
      actorId: "membership-editor",
      workspaceId,
      schemaVersion: "1.0.0",
      baseRevision: 0,
      edits: [{ path: "section_hero.title", value: "First input" }],
      idempotencyKey: "d1-content-save-0004",
    });

    await expect(
      application.commands.save({
        actorId: "membership-editor",
        workspaceId,
        schemaVersion: "1.0.0",
        baseRevision: 0,
        edits: [{ path: "section_hero.title", value: "Different input" }],
        idempotencyKey: "d1-content-save-0004",
      }),
    ).rejects.toBeInstanceOf(ContentRevisionIdempotencyError);
  });

  it("prevents update and deletion of persisted revision rows", async () => {
    const application = createApplication();
    await application.queries.getCurrent();

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
});
