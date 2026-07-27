import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  createContentActorId,
} from "@foundry/application";

import {
  contentWorkspaceIdForActor,
  contentWorkspaceIdForMutation,
  isGitObjectId,
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
});
