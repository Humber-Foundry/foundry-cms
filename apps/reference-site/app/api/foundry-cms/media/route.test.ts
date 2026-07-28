import { beforeEach, describe, expect, it, vi } from "vitest";
import { ContentRevisionConflictError } from "@foundry/application";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  loadIdentity: vi.fn(),
  verifyMutation: vi.fn(),
  loadApplication: vi.fn(),
  upload: vi.fn(),
  replace: vi.fn(),
  crop: vi.fn(),
  delete: vi.fn(),
  listAssets: vi.fn(),
  listOccurrences: vi.fn(),
  getSource: vi.fn(),
  getAsset: vi.fn(),
  saveMediaOccurrence: vi.fn(),
  loadContentApplication: vi.fn(),
  getCurrentContent: vi.fn(),
}));
vi.mock("../../../../src/human-access-runtime", () => ({
  authorizeAuthenticatedHumanIdentity: mocks.authorize,
  loadHumanIdentityRequestContext: mocks.loadIdentity,
}));
vi.mock("../../../../src/human-mutation-runtime", () => ({
  verifyHumanMutation: mocks.verifyMutation,
}));
vi.mock("../../../../src/media-asset-runtime", () => ({
  MediaAssetConfigurationError: class extends Error {},
  loadMediaAssetApplication: mocks.loadApplication,
}));
vi.mock("../../../../src/content-revision-runtime", () => ({
  loadContentRevisionApplication: mocks.loadContentApplication,
}));

import { GET, POST } from "./route";

describe("media endpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const identity = {
      binding: { issuer: "issuer", subject: "subject" },
      email: "editor@example.com",
      nonce: "nonce",
    };
    mocks.loadIdentity.mockResolvedValue({ identity });
    mocks.authorize.mockResolvedValue({
      state: "authorized",
      identity,
      membership: { id: "membership-editor", role: "editor" },
    });
    mocks.verifyMutation.mockResolvedValue(undefined);
    mocks.listAssets.mockResolvedValue([]);
    mocks.listOccurrences.mockResolvedValue([]);
    mocks.getAsset.mockResolvedValue({
      assetId: "asset_replacement",
      width: 1600,
      height: 900,
      contentType: "image/png",
    });
    mocks.saveMediaOccurrence.mockResolvedValue({
      workspaceId: "workspace_editor",
      revision: 3,
    });
    mocks.loadContentApplication.mockResolvedValue({
      commands: { saveMediaOccurrence: mocks.saveMediaOccurrence },
      queries: { getCurrent: mocks.getCurrentContent },
    });
    mocks.getCurrentContent.mockResolvedValue({ revision: 3 });
    mocks.loadApplication.mockResolvedValue({
      commands: {
        upload: mocks.upload,
        replaceOccurrence: mocks.replace,
        cropOccurrence: mocks.crop,
        delete: mocks.delete,
      },
      queries: {
        listAssets: mocks.listAssets,
        listOccurrences: mocks.listOccurrences,
        getSource: mocks.getSource,
        getAsset: mocks.getAsset,
      },
    });
  });

  it("reconciles a content-head race without duplicating the occurrence mutation", async () => {
    mocks.replace.mockResolvedValue({
      occurrenceId: "occurrence_home_hero",
      revision: 2,
      assetId: "asset_replacement",
      crop: null,
    });
    mocks.saveMediaOccurrence
      .mockRejectedValueOnce(new ContentRevisionConflictError(3))
      .mockResolvedValueOnce({
        workspaceId: "workspace_editor",
        revision: 4,
      });
    const response = await POST(
      new Request("https://foundry.example/api/foundry-cms/media", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "recover-compound-media-0001",
        },
        body: JSON.stringify({
          operation: "replace",
          occurrenceId: "occurrence_home_hero",
          assetId: "asset_replacement",
          baseRevision: 1,
          workspaceId: "workspace_editor",
          contentBaseRevision: 2,
        }),
      }),
    );

    expect(response.status).toBe(201);
    expect(mocks.replace).toHaveBeenCalledOnce();
    expect(mocks.saveMediaOccurrence).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ baseRevision: 3 }),
    );
  });

  it("derives the editor actor and changes only the requested occurrence", async () => {
    mocks.replace.mockResolvedValue({
      occurrenceId: "occurrence_home_hero",
      revision: 2,
      assetId: "asset_replacement",
      crop: null,
    });
    const response = await POST(
      new Request("https://foundry.example/api/foundry-cms/media", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "replace-media-route-0001",
        },
        body: JSON.stringify({
          operation: "replace",
          occurrenceId: "occurrence_home_hero",
          assetId: "asset_replacement",
          baseRevision: 1,
          workspaceId: "workspace_editor",
          contentBaseRevision: 2,
        }),
      }),
    );

    expect(response.status).toBe(201);
    expect(mocks.replace).toHaveBeenCalledWith({
      actorId: "membership-editor",
      occurrenceId: "occurrence_home_hero",
      assetId: "asset_replacement",
      baseRevision: 1,
      idempotencyKey: "replace-media-route-0001",
    });
    expect(mocks.verifyMutation).toHaveBeenCalledOnce();
    expect(mocks.saveMediaOccurrence).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "membership-editor",
        workspaceId: "workspace_editor",
        baseRevision: 2,
        occurrence: expect.objectContaining({
          occurrenceId: "occurrence_home_hero",
          revision: 2,
          asset: expect.objectContaining({
            assetId: "asset_replacement",
          }),
        }),
      }),
    );
  });

  it("serves a private source only through the authenticated site application", async () => {
    mocks.getSource.mockResolvedValue({
      body: new Uint8Array([1, 2, 3]),
      contentType: "image/png",
    });

    const response = await GET(
      new Request(
        "https://foundry.example/api/foundry-cms/media?assetId=asset_hero",
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.getSource).toHaveBeenCalledWith("asset_hero");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });

  it("lists only the assets and occurrences returned by the site-scoped application", async () => {
    mocks.listAssets.mockResolvedValue([{ assetId: "asset_hero" }]);
    mocks.listOccurrences.mockResolvedValue([
      { occurrenceId: "occurrence_home_hero" },
    ]);

    const response = await GET(
      new Request("https://foundry.example/api/foundry-cms/media"),
    );

    await expect(response.json()).resolves.toEqual({
      assets: [{ assetId: "asset_hero" }],
      occurrences: [{ occurrenceId: "occurrence_home_hero" }],
    });
  });
});
