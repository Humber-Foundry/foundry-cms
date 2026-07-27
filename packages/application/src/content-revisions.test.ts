import { describe, expect, it } from "vitest";

import { referenceSiteDefinition } from "@foundry/site-definition";

import {
  ContentRevisionConflictError,
  ContentRevisionIdempotencyError,
  ContentRevisionStaleError,
  ContentWorkspaceAccessError,
  createContentActorId,
  ContentRevisionValidationError,
  createContentWorkspaceId,
  createContentRevisionApplication,
  createInMemoryContentRevisionStore,
  isContentRevisionRenderableBy,
} from "./content-revisions";

const editorActorId = createContentActorId("membership-editor");
const collaboratorActorId = createContentActorId(
  "membership-collaborator",
);
const outsiderActorId = createContentActorId("membership-outsider");

const applicationInputs = {
  workspaceId: createContentWorkspaceId("workspace_home"),
  actorId: editorActorId,
  rendererVersion: "renderer-commit-a",
  productionBase: "published:site_foundry_reference@1.0.0",
} as const;

const commandInputs = {
  workspaceId: applicationInputs.workspaceId,
  schemaVersion: "1.1.0",
} as const;

async function createWorkspace(
  application: ReturnType<typeof createContentRevisionApplication>,
  idempotencyKey: string,
) {
  return application.commands.create({
    actorId: editorActorId,
    workspaceId: applicationInputs.workspaceId,
    idempotencyKey,
  });
}

describe("content revision application", () => {
  it("keeps reads side-effect free until an explicit create command", async () => {
    const application = createContentRevisionApplication({
      siteDefinition: referenceSiteDefinition,
      store: createInMemoryContentRevisionStore(),
      ...applicationInputs,
    });

    await expect(application.queries.getCurrent()).rejects.toBeInstanceOf(
      ContentWorkspaceAccessError,
    );

    const command = {
      actorId: editorActorId,
      workspaceId: applicationInputs.workspaceId,
      idempotencyKey: "create-workspace-0001",
    } as const;
    const created = await application.commands.create(command);
    const replay = await application.commands.create(command);

    expect(created).toEqual(expect.objectContaining({ revision: 0 }));
    expect(replay).toEqual(created);
    await expect(application.queries.getCurrent()).resolves.toEqual(created);
  });

  it("creates an immutable revision for a schema-valid edit", async () => {
    const application = createContentRevisionApplication({
      siteDefinition: referenceSiteDefinition,
      store: createInMemoryContentRevisionStore(),
      ...applicationInputs,
    });
    await createWorkspace(application, "create-workspace-save-0001");

    const saved = await application.commands.save({
      actorId: editorActorId,
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
      schemaVersion: "1.1.0",
      rendererVersion: "renderer-commit-a",
      productionBase: "published:site_foundry_reference@1.0.0",
    });
    expect(Object.isFrozen(saved)).toBe(true);
    expect(
      isContentRevisionRenderableBy(saved, {
        rendererVersion: "renderer-commit-a",
        productionBase: applicationInputs.productionBase,
      }),
    ).toBe(true);
    expect(
      isContentRevisionRenderableBy(saved, {
        rendererVersion: "renderer-commit-b",
        productionBase: applicationInputs.productionBase,
      }),
    ).toBe(false);
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
    await createWorkspace(application, "create-workspace-replay-0001");
    const command = {
      actorId: editorActorId,
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
    await createWorkspace(application, "create-workspace-conflict-0001");

    await application.commands.save({
      actorId: editorActorId,
      ...commandInputs,
      baseRevision: 0,
      edits: [{ path: "section_hero.title", value: "First input" }],
      idempotencyKey: "save-section-hero-0003",
    });

    await expect(
      application.commands.save({
        actorId: editorActorId,
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
    await createWorkspace(application, "create-workspace-stale-0001");
    await application.commands.save({
      actorId: editorActorId,
      ...commandInputs,
      baseRevision: 0,
      edits: [{ path: "section_hero.title", value: "First editor" }],
      idempotencyKey: "save-section-hero-0004",
    });

    await expect(
      application.commands.save({
        actorId: editorActorId,
        ...commandInputs,
        baseRevision: 0,
        edits: [{ path: "section_hero.title", value: "Stale editor" }],
        idempotencyKey: "save-section-hero-0005",
      }),
    ).rejects.toEqual(new ContentRevisionConflictError(1));
  });

  it("authorizes workspace collaborators without conflating workspaces", async () => {
    const store = createInMemoryContentRevisionStore();
    const owner = createContentRevisionApplication({
      siteDefinition: referenceSiteDefinition,
      store,
      ...applicationInputs,
    });
    await createWorkspace(owner, "create-workspace-collaborator-0001");
    await owner.commands.addCollaborator(collaboratorActorId);
    const collaborator = createContentRevisionApplication({
      siteDefinition: referenceSiteDefinition,
      store,
      ...applicationInputs,
      actorId: collaboratorActorId,
    });

    await expect(collaborator.queries.getCurrent()).resolves.toEqual(
      expect.objectContaining({ workspaceId: applicationInputs.workspaceId }),
    );

    const outsider = createContentRevisionApplication({
      siteDefinition: referenceSiteDefinition,
      store,
      ...applicationInputs,
      actorId: outsiderActorId,
    });
    await expect(outsider.queries.getCurrent()).rejects.toBeInstanceOf(
      ContentWorkspaceAccessError,
    );
  });

  it("rejects revisions whose production base has gone stale", async () => {
    const store = createInMemoryContentRevisionStore();
    const original = createContentRevisionApplication({
      siteDefinition: referenceSiteDefinition,
      store,
      ...applicationInputs,
    });
    await original.commands.create({
      actorId: editorActorId,
      workspaceId: applicationInputs.workspaceId,
      idempotencyKey: "create-workspace-0002",
    });
    const changedBase = createContentRevisionApplication({
      siteDefinition: referenceSiteDefinition,
      store,
      ...applicationInputs,
      productionBase: "published:site_foundry_reference@2.0.0",
    });

    await expect(
      changedBase.commands.save({
        actorId: editorActorId,
        ...commandInputs,
        baseRevision: 0,
        edits: [{ path: "section_hero.title", value: "Stale base" }],
        idempotencyKey: "save-section-hero-0009",
      }),
    ).rejects.toBeInstanceOf(ContentRevisionStaleError);
  });

  it("acknowledges a replay that became stale after a production-base change", async () => {
    const store = createInMemoryContentRevisionStore();
    const original = createContentRevisionApplication({
      siteDefinition: referenceSiteDefinition,
      store,
      ...applicationInputs,
    });
    await createWorkspace(original, "create-workspace-replay-stale-0001");
    const command = {
      actorId: editorActorId,
      ...commandInputs,
      baseRevision: 0,
      edits: [{ path: "section_hero.title", value: "Recovered save" }],
      idempotencyKey: "save-section-hero-0010",
    } as const;
    const saved = await original.commands.save(command);
    const changedBase = createContentRevisionApplication({
      siteDefinition: referenceSiteDefinition,
      store,
      ...applicationInputs,
      productionBase: "published:site_foundry_reference@2.0.0",
    });

    await expect(changedBase.commands.save(command)).rejects.toEqual(
      expect.objectContaining({
        name: "ContentRevisionStaleError",
        acknowledgedRevision: saved.revision,
      }),
    );
  });

  it("rejects invalid fields with path-keyed feedback", async () => {
    const application = createContentRevisionApplication({
      siteDefinition: referenceSiteDefinition,
      store: createInMemoryContentRevisionStore(),
      ...applicationInputs,
    });
    await createWorkspace(application, "create-workspace-validation-0001");

    await expect(
      application.commands.save({
        actorId: editorActorId,
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
    await createWorkspace(application, "create-workspace-metadata-0001");

    await expect(
      application.commands.save({
        actorId: editorActorId,
        workspaceId: createContentWorkspaceId("workspace_other"),
        schemaVersion: "1.1.0",
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
        actorId: editorActorId,
        workspaceId: applicationInputs.workspaceId,
        schemaVersion: "2.0.0" as "1.1.0",
        baseRevision: 0,
        edits: [{ path: "section_hero.title", value: "Wrong schema" }],
        idempotencyKey: "save-section-hero-0008",
      }),
    ).rejects.toEqual(
      new ContentRevisionValidationError({
        schemaVersion: "Use Site Definition schema 1.1.0.",
      }),
    );
  });

  it("requires explicit creation before a save can claim a workspace", async () => {
    const application = createContentRevisionApplication({
      siteDefinition: referenceSiteDefinition,
      store: createInMemoryContentRevisionStore(),
      ...applicationInputs,
    });

    await expect(
      application.commands.save({
        actorId: editorActorId,
        ...commandInputs,
        baseRevision: 0,
        edits: [{ path: "section_hero.title", value: "Do not create" }],
        idempotencyKey: "save-without-workspace-0001",
      }),
    ).rejects.toBeInstanceOf(ContentWorkspaceAccessError);
    await expect(application.queries.getCurrent()).rejects.toBeInstanceOf(
      ContentWorkspaceAccessError,
    );
  });
});
