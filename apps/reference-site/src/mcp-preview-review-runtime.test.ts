import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createCanonicalPreviewArtifactHash,
  createContentActorId,
  createContentWorkspaceId,
} from "@humber-foundry/application";
import { referenceSiteDefinition } from "@humber-foundry/site-definition";

const mocks = vi.hoisted(() => ({
  first: vi.fn(),
  getRevision: vi.fn(),
  getRevisionWithBookmark: vi.fn(),
  isRevisionCurrent: vi.fn(),
  loadApplication: vi.fn(),
  loadEnvironment: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("./content-revision-runtime", () => ({
  loadContentRevisionApplication: mocks.loadApplication,
}));
vi.mock("./human-access-environment", () => ({
  loadHumanAccessEnvironment: mocks.loadEnvironment,
}));

import { loadMcpPreviewForHuman } from "./mcp-preview-review-runtime";

describe("MCP preview review runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects a hash-bound preview after renderer or production-base drift", async () => {
    const revision = {
      workspaceId: createContentWorkspaceId("workspace_mcp_preview_drift"),
      revision: 2,
      definition: referenceSiteDefinition,
      inputs: {
        contentHash: "b".repeat(64),
        schemaVersion: referenceSiteDefinition.schemaVersion,
        rendererVersion: "renderer-55",
        productionBase:
          `git:${"a".repeat(40)}@content:${"b".repeat(64)}`,
      },
      createdAt: "2026-07-29T20:00:00.000Z",
      createdBy: createContentActorId("mcp-agent-55"),
      bookmark: "preview-bookmark",
    };
    mocks.first.mockResolvedValue({
      actor_id: "agent-55",
      workspace_id: revision.workspaceId,
      revision: revision.revision,
      artifact_hash: await createCanonicalPreviewArtifactHash(revision),
    });
    mocks.loadEnvironment.mockResolvedValue({
      FOUNDRY_DB: {
        prepare: vi.fn(() => ({
          bind: vi.fn(() => ({ first: mocks.first })),
        })),
      },
    });
    mocks.getRevisionWithBookmark.mockResolvedValue(revision);
    mocks.isRevisionCurrent.mockResolvedValue(false);
    mocks.getRevision.mockResolvedValue({
      ...revision,
      revision: 0,
    });
    mocks.loadApplication.mockResolvedValue({
      queries: {
        getRevision: mocks.getRevision,
        getRevisionWithBookmark: mocks.getRevisionWithBookmark,
        isRevisionCurrent: mocks.isRevisionCurrent,
      },
    });

    await expect(
      loadMcpPreviewForHuman({
        previewId: "preview-drift",
        siteId: referenceSiteDefinition.site.id,
      }),
    ).resolves.toBeNull();
    expect(mocks.isRevisionCurrent).toHaveBeenCalledWith(revision);
    expect(mocks.getRevision).not.toHaveBeenCalled();
  });
});
