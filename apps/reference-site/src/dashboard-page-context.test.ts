import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ContentRevisionConfigurationError,
  ContentWorkspaceAccessError,
} from "@humber-foundry/application";
import { referenceSiteDefinition } from "@humber-foundry/site-definition";

const mocks = vi.hoisted(() => ({
  createMutationToken: vi.fn(),
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
  redirect(destination: string) {
    throw new Error(`redirect:${destination}`);
  },
}));
vi.mock("@/src/human-access-runtime", () => ({
  loadHumanAccessRequestContext: mocks.loadAccess,
}));
vi.mock("@/src/human-mutation-runtime", () => ({
  createHumanMutationToken: mocks.createMutationToken,
}));
vi.mock("@/src/content-revision-runtime", () => ({
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

import {
  loadDashboardWorkspace,
  readWorkspaceSearchParams,
} from "./dashboard-page-context";

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

  it("opens the workspace through the shared operation, not its own create", async () => {
    mocks.latestWorkspaceId.mockResolvedValue(null);
    await loadDashboardWorkspace(undefined, "/dash");

    // Whether that operation is safe for two requests at once is proved
    // against a real database in content-revision-runtime.test.ts.
    expect(mocks.openDefaultWorkspace).toHaveBeenCalledTimes(1);
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

  it("sends a URL holding a workspace that is gone to the person's own draft", async () => {
    mocks.latestWorkspaceId.mockResolvedValue(null);
    mocks.requireExistingAccess.mockRejectedValueOnce(
      new ContentWorkspaceAccessError(),
    );

    // Not a missing page. The dead id is swapped for a workspace they can
    // open, so the address bar and every sidebar link stop carrying it.
    await expect(
      loadDashboardWorkspace(otherWorkspaceId, "/dash/blog"),
    ).rejects.toThrow(`redirect:/dash/blog?workspace=${ownWorkspaceId}`);
  });

  it("sends a URL holding a malformed workspace id to the person's own draft", async () => {
    mocks.latestWorkspaceId.mockResolvedValue(null);

    await expect(
      loadDashboardWorkspace("not-a-workspace", "/dash"),
    ).rejects.toThrow(`redirect:/dash?workspace=${ownWorkspaceId}`);
  });

  it("sends a URL holding somebody else's workspace to the person's own draft", async () => {
    mocks.latestWorkspaceId.mockResolvedValue(otherWorkspaceId);
    mocks.requireExistingAccess.mockRejectedValueOnce(
      new ContentWorkspaceAccessError(),
    );

    await expect(
      loadDashboardWorkspace(
        "workspace_cccccccccccccccccccccccc",
        "/dash/design",
      ),
    ).rejects.toThrow(`redirect:/dash/design?workspace=${otherWorkspaceId}`);
  });

  it("carries a recovery in progress through the redirect", async () => {
    mocks.latestWorkspaceId.mockResolvedValue(null);
    mocks.requireExistingAccess.mockRejectedValueOnce(
      new ContentWorkspaceAccessError(),
    );

    // Dropping the pointer would strand the preserved edits in the browser.
    await expect(
      loadDashboardWorkspace(otherWorkspaceId, "/dash/pages", {
        id: "12345678-1234-4123-8123-123456789abc",
        sourceWorkspaceId: otherWorkspaceId,
      }),
    ).rejects.toThrow(
      `redirect:/dash/pages?workspace=${ownWorkspaceId}` +
        "&recovery=12345678-1234-4123-8123-123456789abc" +
        `&recoverFrom=${otherWorkspaceId}`,
    );
  });

  it("keeps a real fault inside the access check visible", async () => {
    mocks.latestWorkspaceId.mockResolvedValue(null);
    mocks.requireExistingAccess.mockRejectedValueOnce(
      new TypeError("some_other_bug"),
    );

    await expect(
      loadDashboardWorkspace(otherWorkspaceId, "/dash"),
    ).rejects.toThrow("some_other_bug");
  });

  it("reports a configuration failure while resolving as a not-found page", async () => {
    mocks.latestWorkspaceId.mockRejectedValue(
      new ContentRevisionConfigurationError(),
    );

    await expect(loadDashboardWorkspace(undefined, "/dash")).rejects.toThrow(
      "not_found",
    );
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

describe("dashboard search parameters", () => {
  const recoveryId = "12345678-1234-4123-8123-123456789abc";

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadAccess.mockResolvedValue({
      state: "authorized",
      identity: { binding: { issuer: "issuer", subject: "subject" } },
      membership: { id: "membership-owner" },
    });
    mocks.requireExistingAccess.mockResolvedValue(undefined);
  });

  it("honours a recovery pair whose source workspace can still be opened", async () => {
    await expect(
      readWorkspaceSearchParams(
        Promise.resolve({
          workspace: ownWorkspaceId,
          recovery: recoveryId,
          recoverFrom: otherWorkspaceId,
        }),
      ),
    ).resolves.toEqual({
      workspace: ownWorkspaceId,
      staleRecovery: { id: recoveryId, sourceWorkspaceId: otherWorkspaceId },
    });
  });

  it("drops a recovery pair whose source workspace is gone", async () => {
    mocks.requireExistingAccess.mockRejectedValue(
      new ContentWorkspaceAccessError(),
    );

    // The edits live in this person's own browser, so a stale or shared link
    // points at edits it does not have. The destination still opens.
    await expect(
      readWorkspaceSearchParams(
        Promise.resolve({
          workspace: ownWorkspaceId,
          recovery: recoveryId,
          recoverFrom: otherWorkspaceId,
        }),
      ),
    ).resolves.toEqual({ workspace: ownWorkspaceId });
  });

  it("drops a malformed recovery pair without reading the workspace", async () => {
    await expect(
      readWorkspaceSearchParams(
        Promise.resolve({
          workspace: ownWorkspaceId,
          recovery: "not-a-uuid",
          recoverFrom: otherWorkspaceId,
        }),
      ),
    ).resolves.toEqual({ workspace: ownWorkspaceId });
    expect(mocks.requireExistingAccess).not.toHaveBeenCalled();
  });

  it("drops a recovery pair naming a malformed source workspace", async () => {
    await expect(
      readWorkspaceSearchParams(
        Promise.resolve({
          recovery: recoveryId,
          recoverFrom: "not-a-workspace",
        }),
      ),
    ).resolves.toEqual({ workspace: undefined });
  });
});
