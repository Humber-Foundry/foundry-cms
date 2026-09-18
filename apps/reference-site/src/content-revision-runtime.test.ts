import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  ContentRevisionConfigurationError,
  createContentActorId,
  isValidContentMutationIdempotencyKey,
} from "@humber-foundry/application";

import type { HumanAccessEnvironment } from "./human-access-configuration";
import {
  contentWorkspaceIdForActor,
  contentWorkspaceIdForMutation,
  gitContentProductionBase,
  isGitObjectId,
  openDefaultContentWorkspace,
  openDefaultWorkspaceIdempotencyKey,
  resolveContentReleaseInputs,
} from "./content-revision-runtime";
import { useMigratedTestDatabase } from "./test-support/migrated-test-database";

describe("content revision workspace routing", () => {
  it("gives each actor a stable independent workspace", async () => {
    const editorWorkspace = await contentWorkspaceIdForActor(
      createContentActorId("membership-editor"),
    );

    await expect(
      contentWorkspaceIdForActor(createContentActorId("membership-editor")),
    ).resolves.toBe(editorWorkspace);
    await expect(
      contentWorkspaceIdForActor(
        createContentActorId("membership-other-editor"),
      ),
    ).resolves.not.toBe(editorWorkspace);
    expect(editorWorkspace).toMatch(/^workspace_[a-f0-9]{24}$/);
  });

  it("derives retry-stable workspace IDs from mutation identity", async () => {
    const actorId = createContentActorId("membership-editor");
    const workspace = await contentWorkspaceIdForMutation(
      actorId,
      "create-workspace-request-0001",
    );

    await expect(
      contentWorkspaceIdForMutation(
        actorId,
        "create-workspace-request-0001",
      ),
    ).resolves.toBe(workspace);
    await expect(
      contentWorkspaceIdForMutation(
        actorId,
        "create-workspace-request-0002",
      ),
    ).resolves.not.toBe(workspace);
    expect(workspace).toMatch(/^workspace_[a-f0-9]{24}$/);
  });
});

describe("production base validation", () => {
  it("accepts only exact SHA-1 or SHA-256 object IDs", () => {
    expect(isGitObjectId("a".repeat(40))).toBe(true);
    expect(isGitObjectId("b".repeat(64))).toBe(true);
    expect(isGitObjectId("c".repeat(41))).toBe(false);
    expect(isGitObjectId("d".repeat(63))).toBe(false);
  });

  it("binds the deployed git object and exact content hash", () => {
    expect(
      gitContentProductionBase("a".repeat(40), "b".repeat(64)),
    ).toBe(`git:${"a".repeat(40)}@content:${"b".repeat(64)}`);
    expect(() =>
      gitContentProductionBase(`git:${"a".repeat(40)}`, "b".repeat(64)),
    ).toThrow(ContentRevisionConfigurationError);
  });

  it("uses the embedded Workers build commit as both renderer and production base", () => {
    expect(
      resolveContentReleaseInputs(
        {
          FOUNDRY_PRODUCTION_BASE: "a".repeat(40),
          CF_VERSION_METADATA: { id: "cloudflare-version" },
        },
        "b".repeat(40),
      ),
    ).toEqual({
      productionBaseCommit: "b".repeat(40),
      rendererVersion: "b".repeat(40),
    });
  });

  it("uses configured production base only as a bootstrap fallback", () => {
    expect(
      resolveContentReleaseInputs(
        {
          FOUNDRY_PRODUCTION_BASE: "a".repeat(40),
          CF_VERSION_METADATA: { id: "cloudflare-version" },
        },
        "",
      ),
    ).toEqual({
      productionBaseCommit: "a".repeat(40),
      rendererVersion: "a".repeat(40),
    });
    expect(() => resolveContentReleaseInputs({}, "")).toThrow(
      ContentRevisionConfigurationError,
    );
  });
});

describe("opening the default draft workspace", () => {
  const actorId = createContentActorId("membership-owner");
  const { database } = useMigratedTestDatabase(
    [
      "0005_content_revisions.sql",
      "0007_content_publication.sql",
      "0008_media_assets.sql",
      "0011_blog_post_transition_audit.sql",
      "0013_blog_post_verified_state.sql",
      "0014_blog_post_artifact_fingerprints.sql",
      "0015_blog_post_render_artifacts.sql",
      "0022_blog_post_scheduling_archive.sql",
    ],
    { compatibilityDate: "2026-07-26" },
  );

  function environment(): HumanAccessEnvironment {
    return {
      FOUNDRY_DB: database,
      FOUNDRY_PRODUCTION_BASE: "a".repeat(40),
    } as unknown as HumanAccessEnvironment;
  }

  async function countOf(statement: string, workspaceId: string) {
    const row = await database
      .prepare(statement)
      .bind(workspaceId)
      .first<{ count: number }>();
    return row?.count ?? 0;
  }

  const workspaceRows = (workspaceId: string) =>
    countOf(
      "SELECT COUNT(*) AS count FROM content_workspaces WHERE workspace_id = ?1",
      workspaceId,
    );
  const revisionRows = (workspaceId: string) =>
    countOf(
      "SELECT COUNT(*) AS count FROM content_revisions WHERE workspace_id = ?1",
      workspaceId,
    );

  it("creates the actor's own default workspace at revision 0", async () => {
    const opened = await openDefaultContentWorkspace(
      actorId,
      openDefaultWorkspaceIdempotencyKey,
      environment(),
    );

    expect(opened.workspaceId).toBe(await contentWorkspaceIdForActor(actorId));
    expect(opened.revision.revision).toBe(0);
    expect(opened.revision.workspaceId).toBe(opened.workspaceId);
    await expect(workspaceRows(opened.workspaceId)).resolves.toBe(1);
    await expect(revisionRows(opened.workspaceId)).resolves.toBe(1);
  });

  it("writes no revision audit event for the published base revision", async () => {
    const opened = await openDefaultContentWorkspace(
      actorId,
      openDefaultWorkspaceIdempotencyKey,
      environment(),
    );

    // Revision 0 is a copy of the published site, not somebody's edit. The
    // explicit `create_default_workspace` API operation calls this same
    // function, so both ways of opening the workspace leave the same rows.
    await expect(
      countOf(
        "SELECT COUNT(*) AS count FROM content_revision_audit_events WHERE workspace_id = ?1",
        opened.workspaceId,
      ),
    ).resolves.toBe(0);
  });

  it("returns the same single workspace when two first requests arrive together", async () => {
    const [first, second] = await Promise.all([
      openDefaultContentWorkspace(
        actorId,
        "dashboard-open-default-request-a",
        environment(),
      ),
      openDefaultContentWorkspace(
        actorId,
        "dashboard-open-default-request-b",
        environment(),
      ),
    ]);

    expect(second.workspaceId).toBe(first.workspaceId);
    expect(first.revision.revision).toBe(0);
    expect(second.revision.revision).toBe(0);
    expect(second.revision.inputs.contentHash).toBe(
      first.revision.inputs.contentHash,
    );
    await expect(workspaceRows(first.workspaceId)).resolves.toBe(1);
    await expect(revisionRows(first.workspaceId)).resolves.toBe(1);
  });

  it("reopens the existing workspace instead of creating a second one", async () => {
    const first = await openDefaultContentWorkspace(
      actorId,
      openDefaultWorkspaceIdempotencyKey,
      environment(),
    );
    const reopened = await openDefaultContentWorkspace(
      actorId,
      openDefaultWorkspaceIdempotencyKey,
      environment(),
    );

    expect(reopened.workspaceId).toBe(first.workspaceId);
    expect(reopened.revision.revision).toBe(0);
    await expect(workspaceRows(first.workspaceId)).resolves.toBe(1);
    await expect(revisionRows(first.workspaceId)).resolves.toBe(1);
  });

  it("gives each actor a separate workspace", async () => {
    const owner = await openDefaultContentWorkspace(
      actorId,
      openDefaultWorkspaceIdempotencyKey,
      environment(),
    );
    const editor = await openDefaultContentWorkspace(
      createContentActorId("membership-editor"),
      openDefaultWorkspaceIdempotencyKey,
      environment(),
    );

    expect(editor.workspaceId).not.toBe(owner.workspaceId);
  });

  it("uses an idempotency key the application operation accepts", () => {
    expect(
      isValidContentMutationIdempotencyKey(openDefaultWorkspaceIdempotencyKey),
    ).toBe(true);
  });
});
