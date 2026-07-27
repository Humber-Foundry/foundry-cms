import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  contentWorkspaceIdForActor,
  isGitObjectId,
} from "./content-revision-runtime";

describe("content revision workspace routing", () => {
  it("gives each actor a stable independent workspace", async () => {
    const editorWorkspace = await contentWorkspaceIdForActor(
      "membership-editor",
    );

    await expect(
      contentWorkspaceIdForActor("membership-editor"),
    ).resolves.toBe(editorWorkspace);
    await expect(
      contentWorkspaceIdForActor("membership-other-editor"),
    ).resolves.not.toBe(editorWorkspace);
    expect(editorWorkspace).toMatch(/^workspace_[a-f0-9]{24}$/);
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
