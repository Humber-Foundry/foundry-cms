import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  ContentRevisionConfigurationError,
  createContentActorId,
} from "@foundry/application";

import {
  contentWorkspaceIdForActor,
  contentWorkspaceIdForMutation,
  gitContentProductionBase,
  isGitObjectId,
  resolveContentReleaseInputs,
} from "./content-revision-runtime";

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
