import { describe, expect, it } from "vitest";

import { referenceSiteDefinition } from "@foundry/site-definition";

import {
  ContentRevisionConflictError,
  ContentRevisionIdempotencyError,
  ContentRevisionValidationError,
  createContentWorkspaceId,
  createContentRevisionApplication,
  createInMemoryContentRevisionStore,
  isContentRevisionRenderableBy,
} from "./content-revisions";

const applicationInputs = {
  workspaceId: createContentWorkspaceId("workspace_home"),
  rendererVersion: "renderer-commit-a",
  productionBase: "published:site_foundry_reference@1.0.0",
} as const;

const commandInputs = {
  workspaceId: applicationInputs.workspaceId,
  schemaVersion: "1.0.0",
} as const;

describe("content revision application", () => {
  it("creates an immutable revision for a schema-valid edit", async () => {
    const application = createContentRevisionApplication({
      siteDefinition: referenceSiteDefinition,
      store: createInMemoryContentRevisionStore(),
      ...applicationInputs,
    });

    const saved = await application.commands.save({
      actorId: "membership-editor",
      ...commandInputs,
      baseRevision: 0,
      edits: [
        {
          path: "section_hero.title",
          value: "A saved headline",
        },
      ],
      idempotencyKey: "save-section-hero-0001",
    });

    expect(saved.revision).toBe(1);
    expect(saved.definition.home.sections[0]).toEqual(
      expect.objectContaining({ title: "A saved headline" }),
    );
    expect(saved.inputs).toEqual({
      contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      schemaVersion: "1.0.0",
      rendererVersion: "renderer-commit-a",
      productionBase: "published:site_foundry_reference@1.0.0",
    });
    expect(Object.isFrozen(saved)).toBe(true);
    expect(isContentRevisionRenderableBy(saved, "renderer-commit-a")).toBe(
      true,
    );
    expect(isContentRevisionRenderableBy(saved, "renderer-commit-b")).toBe(
      false,
    );
    await expect(application.queries.getRevision(0)).resolves.toEqual(
      expect.objectContaining({ definition: referenceSiteDefinition }),
    );
  });

  it("replays one idempotency key without creating another revision", async () => {
    const application = createContentRevisionApplication({
      siteDefinition: referenceSiteDefinition,
      store: createInMemoryContentRevisionStore(),
      ...applicationInputs,
    });
    const command = {
      actorId: "membership-editor",
      ...commandInputs,
      baseRevision: 0,
      edits: [{ path: "section_hero.title", value: "One save" }],
      idempotencyKey: "save-section-hero-0002",
    } as const;

    const first = await application.commands.save(command);
    const replay = await application.commands.save(command);

    expect(replay).toEqual(first);
    await expect(application.queries.getCurrent()).resolves.toEqual(
      expect.objectContaining({ revision: 1 }),
    );
  });

  it("rejects reuse of an idempotency key for different input", async () => {
    const application = createContentRevisionApplication({
      siteDefinition: referenceSiteDefinition,
      store: createInMemoryContentRevisionStore(),
      ...applicationInputs,
    });

    await application.commands.save({
      actorId: "membership-editor",
      ...commandInputs,
      baseRevision: 0,
      edits: [{ path: "section_hero.title", value: "First input" }],
      idempotencyKey: "save-section-hero-0003",
    });

    await expect(
      application.commands.save({
        actorId: "membership-editor",
        ...commandInputs,
        baseRevision: 0,
        edits: [{ path: "section_hero.title", value: "Different input" }],
        idempotencyKey: "save-section-hero-0003",
      }),
    ).rejects.toBeInstanceOf(ContentRevisionIdempotencyError);
  });

  it("returns an explicit conflict for a stale base revision", async () => {
    const application = createContentRevisionApplication({
      siteDefinition: referenceSiteDefinition,
      store: createInMemoryContentRevisionStore(),
      ...applicationInputs,
    });
    await application.commands.save({
      actorId: "membership-editor",
      ...commandInputs,
      baseRevision: 0,
      edits: [{ path: "section_hero.title", value: "First editor" }],
      idempotencyKey: "save-section-hero-0004",
    });

    await expect(
      application.commands.save({
        actorId: "membership-other-editor",
        ...commandInputs,
        baseRevision: 0,
        edits: [{ path: "section_hero.title", value: "Stale editor" }],
        idempotencyKey: "save-section-hero-0005",
      }),
    ).rejects.toEqual(new ContentRevisionConflictError(1));
  });

  it("rejects invalid fields with path-keyed feedback", async () => {
    const application = createContentRevisionApplication({
      siteDefinition: referenceSiteDefinition,
      store: createInMemoryContentRevisionStore(),
      ...applicationInputs,
    });

    await expect(
      application.commands.save({
        actorId: "membership-editor",
        ...commandInputs,
        baseRevision: 0,
        edits: [{ path: "section_hero.title", value: "" }],
        idempotencyKey: "save-section-hero-0006",
      }),
    ).rejects.toEqual(
      new ContentRevisionValidationError({
        "section_hero.title": "Enter at least one visible character.",
      }),
    );
  });

  it("rejects mutation metadata from another workspace or schema", async () => {
    const application = createContentRevisionApplication({
      siteDefinition: referenceSiteDefinition,
      store: createInMemoryContentRevisionStore(),
      ...applicationInputs,
    });

    await expect(
      application.commands.save({
        actorId: "membership-editor",
        workspaceId: createContentWorkspaceId("workspace_other"),
        schemaVersion: "1.0.0",
        baseRevision: 0,
        edits: [{ path: "section_hero.title", value: "Wrong workspace" }],
        idempotencyKey: "save-section-hero-0007",
      }),
    ).rejects.toEqual(
      new ContentRevisionValidationError({
        workspaceId: "This workspace is not available.",
      }),
    );
    await expect(
      application.commands.save({
        actorId: "membership-editor",
        workspaceId: applicationInputs.workspaceId,
        schemaVersion: "2.0.0" as "1.0.0",
        baseRevision: 0,
        edits: [{ path: "section_hero.title", value: "Wrong schema" }],
        idempotencyKey: "save-section-hero-0008",
      }),
    ).rejects.toEqual(
      new ContentRevisionValidationError({
        schemaVersion: "Use Site Definition schema 1.0.0.",
      }),
    );
  });
});
