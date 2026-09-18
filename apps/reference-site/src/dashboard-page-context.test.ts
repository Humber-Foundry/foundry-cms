import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ContentRevisionConfigurationError,
  ContentWorkspaceAccessError,
} from "@humber-foundry/application";
import { referenceSiteDefinition } from "@humber-foundry/site-definition";

const mocks = vi.hoisted(() => ({
  createMutationToken: vi.fn(),
  defaultWorkspaceId: vi.fn(),
  durableSchemaRecoveryEdits: vi.fn(),
  getCurrent: vi.fn(),
  getPublishedSite: vi.fn(),
  getRevision: vi.fn(),
  isRevisionCurrent: vi.fn(),
  latestWorkspaceId: vi.fn(),
  loadAccess: vi.fn(),
  loadApplication: vi.fn(),
  openDefaultWorkspace: vi.fn(),
  previewUrl: vi.fn(),
  requireExistingAccess: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    // Per-request memoization is React's job. These tests drive one call at a
    // time, so `cache` passes the function straight through and every test
    // starts from the same mocked inputs.
    ...actual,
    cache: <T>(callback: T): T => callback,
  };
});
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", () => ({
  notFound() {
    throw new Error("not_found");
  },
}));
vi.mock("@/src/human-access-runtime", () => ({
  loadHumanAccessRequestContext: mocks.loadAccess,
}));
vi.mock("@/src/human-mutation-runtime", () => ({
  createHumanMutationToken: mocks.createMutationToken,
}));
vi.mock("@/src/content-revision-runtime", () => ({
  contentWorkspaceIdForActor: mocks.defaultWorkspaceId,
  latestContentWorkspaceIdForActor: mocks.latestWorkspaceId,
  loadContentRevisionApplication: mocks.loadApplication,
  openDefaultContentWorkspace: mocks.openDefaultWorkspace,
  openDefaultWorkspaceIdempotencyKey: "dashboard-open-default-workspace",
  requireExistingContentWorkspaceAccess: mocks.requireExistingAccess,
}));
vi.mock("@/src/content-revision-links", () => ({
  revisionPreviewGatewayUrl: mocks.previewUrl,
}));
vi.mock("@/foundry/site-definition.server", () => ({
  installedSite: { application: { queries: { getPublishedSite: mocks.getPublishedSite } } },
}));
vi.mock("@/src/content-schema-recovery", () => ({
  durableSchemaRecoveryEdits: mocks.durableSchemaRecoveryEdits,
}));

import { loadDashboardWorkspace } from "./dashboard-page-context";

const ownWorkspaceId = "workspace_aaaaaaaaaaaaaaaaaaaaaaaa";
const otherWorkspaceId = "workspace_bbbbbbbbbbbbbbbbbbbbbbbb";

function revisionOf(
  workspaceId: string,
  revision = 0,
  schemaVersion: string = referenceSiteDefinition.schemaVersion,
) {
  return {
    workspaceId,
    revision,
    createdAt: "2026-09-18T12:00:00.000Z",
    definition: referenceSiteDefinition,
    inputs: {
      contentHash: "content-hash",
      schemaVersion,
      rendererVersion: "renderer-a",
      productionBase: "production-a",
    },
  };
}

describe("dashboard workspace resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadAccess.mockResolvedValue({
      state: "authorized",
      identity: { binding: { issuer: "issuer", subject: "subject" } },
      membership: { id: "membership-owner" },
    });
    mocks.getPublishedSite.mockResolvedValue(referenceSiteDefinition);
    mocks.createMutationToken.mockResolvedValue("mutation-token");
    mocks.previewUrl.mockImplementation(
      (workspaceId: string, revision: number) =>
        `/__foundry/preview/${workspaceId}/${revision}`,
    );
    mocks.defaultWorkspaceId.mockResolvedValue(ownWorkspaceId);
    mocks.isRevisionCurrent.mockResolvedValue(true);
    mocks.loadApplication.mockResolvedValue({
      queries: {
        getCurrent: mocks.getCurrent,
        getRevision: mocks.getRevision,
        isRevisionCurrent: mocks.isRevisionCurrent,
      },
    });
    mocks.requireExistingAccess.mockResolvedValue(undefined);
    mocks.getCurrent.mockResolvedValue(revisionOf(ownWorkspaceId));
    mocks.openDefaultWorkspace.mockResolvedValue({
      workspaceId: ownWorkspaceId,
      revision: revisionOf(ownWorkspaceId),
    });
  });

  it("creates the draft workspace on a first visit so no destination asks for one", async () => {
    mocks.latestWorkspaceId.mockResolvedValue(null);
    const workspace = await loadDashboardWorkspace(undefined, "/dash/blog");

    expect(mocks.openDefaultWorkspace).toHaveBeenCalledTimes(1);
    expect(mocks.openDefaultWorkspace).toHaveBeenCalledWith(
      "membership-owner",
      "dashboard-open-default-workspace",
    );
    expect(workspace.workspaceId).toBe(ownWorkspaceId);
    expect(workspace.contentRevision.revision).toBe(0);
    expect(workspace.previewUrl).toBe(
      `/__foundry/preview/${ownWorkspaceId}/0`,
    );
    expect(workspace.activeWorkspaceUrl).toBe(
      `/dash/blog?workspace=${ownWorkspaceId}`,
    );
    expect(workspace.schemaRecovery).toBeUndefined();
  });

  it("reuses the person's most recent workspace and creates nothing", async () => {
    mocks.latestWorkspaceId.mockResolvedValue(otherWorkspaceId);
    mocks.getCurrent.mockResolvedValue(revisionOf(otherWorkspaceId, 4));
    const workspace = await loadDashboardWorkspace(undefined, "/dash");

    expect(mocks.openDefaultWorkspace).not.toHaveBeenCalled();
    expect(workspace.workspaceId).toBe(otherWorkspaceId);
    expect(workspace.contentRevision.revision).toBe(4);
  });

  it("resolves one workspace when two first requests arrive together", async () => {
    mocks.latestWorkspaceId.mockResolvedValue(null);
    const [first, second] = await Promise.all([
      loadDashboardWorkspace(undefined, "/dash"),
      loadDashboardWorkspace(undefined, "/dash"),
    ]);

    expect(second.workspaceId).toBe(first.workspaceId);
    expect(second.contentRevision.revision).toBe(
      first.contentRevision.revision,
    );
  });

  it("opens a workspace id from the URL when the person can still open it", async () => {
    mocks.getCurrent.mockResolvedValue(revisionOf(otherWorkspaceId, 2));
    const workspace = await loadDashboardWorkspace(
      otherWorkspaceId,
      "/dash/pages",
    );

    expect(workspace.workspaceId).toBe(otherWorkspaceId);
    expect(workspace.activeWorkspaceUrl).toBe(
      `/dash/pages?workspace=${otherWorkspaceId}`,
    );
    expect(mocks.openDefaultWorkspace).not.toHaveBeenCalled();
  });

  it("falls back to the person's own workspace when the URL holds a workspace that is gone", async () => {
    mocks.latestWorkspaceId.mockResolvedValue(null);
    mocks.requireExistingAccess.mockRejectedValueOnce(
      new ContentWorkspaceAccessError(),
    );
    const workspace = await loadDashboardWorkspace(
      otherWorkspaceId,
      "/dash/blog",
    );

    expect(workspace.workspaceId).toBe(ownWorkspaceId);
    expect(workspace.activeWorkspaceUrl).toBe(
      `/dash/blog?workspace=${ownWorkspaceId}`,
    );
    expect(workspace.contentRevision.revision).toBe(0);
  });

  it("falls back to the person's own workspace when the URL holds a malformed id", async () => {
    mocks.latestWorkspaceId.mockResolvedValue(null);
    const workspace = await loadDashboardWorkspace("not-a-workspace", "/dash");

    expect(workspace.workspaceId).toBe(ownWorkspaceId);
    expect(workspace.activeWorkspaceUrl).toBe(
      `/dash?workspace=${ownWorkspaceId}`,
    );
  });

  it("never returns a link to a workspace it could not open", async () => {
    mocks.latestWorkspaceId.mockResolvedValue(otherWorkspaceId);
    mocks.requireExistingAccess.mockRejectedValueOnce(
      new ContentWorkspaceAccessError(),
    );
    mocks.getCurrent.mockResolvedValue(revisionOf(otherWorkspaceId, 1));
    const workspace = await loadDashboardWorkspace(
      "workspace_cccccccccccccccccccccccc",
      "/dash/design",
    );

    expect(workspace.activeWorkspaceUrl).toBe(
      `/dash/design?workspace=${otherWorkspaceId}`,
    );
    expect(workspace.contentRevision.workspaceId).toBe(otherWorkspaceId);
  });

  it("reports the edits to carry across when the draft was written for an older site schema", async () => {
    mocks.latestWorkspaceId.mockResolvedValue(ownWorkspaceId);
    mocks.getCurrent.mockResolvedValue(
      revisionOf(ownWorkspaceId, 5, "0.0.1"),
    );
    mocks.getRevision.mockResolvedValue(revisionOf(ownWorkspaceId, 0, "0.0.1"));
    const carried = [
      { path: "home.hero.title", value: "New title", baseValue: "Old title" },
    ];
    mocks.durableSchemaRecoveryEdits.mockReturnValue(carried);
    const workspace = await loadDashboardWorkspace(undefined, "/dash/pages");

    expect(workspace.schemaRecovery).toEqual(carried);
    expect(workspace.contentRevision.revision).toBe(5);
  });

  it("reports a missing base revision as a not-found page", async () => {
    mocks.latestWorkspaceId.mockResolvedValue(ownWorkspaceId);
    mocks.getCurrent.mockResolvedValue(
      revisionOf(ownWorkspaceId, 5, "0.0.1"),
    );
    mocks.getRevision.mockResolvedValue(null);
    await expect(
      loadDashboardWorkspace(undefined, "/dash/pages"),
    ).rejects.toThrow("not_found");
  });

  it("reports a configuration failure as a not-found page", async () => {
    mocks.latestWorkspaceId.mockResolvedValue(ownWorkspaceId);
    mocks.getCurrent.mockRejectedValue(
      new ContentRevisionConfigurationError(),
    );
    await expect(
      loadDashboardWorkspace(undefined, "/dash"),
    ).rejects.toThrow("not_found");
  });

  it("reports a stale draft so the destination can offer a fresh one", async () => {
    mocks.latestWorkspaceId.mockResolvedValue(ownWorkspaceId);
    mocks.getCurrent.mockResolvedValue(revisionOf(ownWorkspaceId, 3));
    mocks.isRevisionCurrent.mockResolvedValue(false);
    const workspace = await loadDashboardWorkspace(undefined, "/dash");

    expect(workspace.contentStale).toBe(true);
  });
});
