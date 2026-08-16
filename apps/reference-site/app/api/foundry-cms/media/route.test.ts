import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ContentRevisionConflictError,
  ContentWorkspaceAccessError,
  MediaMutationInProgressError,
} from "@humber-foundry/application";
import { AccessIdentityUnavailableError } from "../../../../src/access-identity";
import { HumanRequestIntegrityError } from "../../../../src/human-request-integrity";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  loadIdentity: vi.fn(),
  verifyMutation: vi.fn(),
  verifyMediaAccess: vi.fn(),
  createMediaAccess: vi.fn(),
  createMediaLibrary: vi.fn(),
  verifyMediaLibrary: vi.fn(),
  loadApplication: vi.fn(),
  upload: vi.fn(),
  replace: vi.fn(),
  crop: vi.fn(),
  delete: vi.fn(),
  grantAccess: vi.fn(),
  listAssets: vi.fn(),
  listOccurrences: vi.fn(),
  getSource: vi.fn(),
  getThumbnailSource: vi.fn(),
  getAsset: vi.fn(),
  getOccurrence: vi.fn(),
  getReplacementReceipt: vi.fn(),
  saveMediaOccurrence: vi.fn(),
  loadContentApplication: vi.fn(),
  getCurrentContent: vi.fn(),
  getContentRevision: vi.fn(),
  isRevisionCurrent: vi.fn(),
}));
vi.mock("../../../../src/human-access-runtime", () => ({
  authorizeAuthenticatedHumanIdentity: mocks.authorize,
  loadHumanIdentityRequestContext: mocks.loadIdentity,
}));
vi.mock("../../../../src/human-mutation-runtime", () => ({
  createHumanMediaAccessToken: mocks.createMediaAccess,
  createHumanMediaLibraryToken: mocks.createMediaLibrary,
  verifyHumanMediaAccessToken: mocks.verifyMediaAccess,
  verifyHumanMediaLibraryToken: mocks.verifyMediaLibrary,
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
    vi.resetAllMocks();
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
    mocks.verifyMediaAccess.mockResolvedValue(undefined);
    mocks.createMediaAccess.mockResolvedValue({
      token: "signed-media-access",
      expiresAt: 1_785_124_800,
    });
    mocks.createMediaLibrary.mockResolvedValue({
      token: "signed-media-library",
      expiresAt: 1_785_124_800,
    });
    mocks.verifyMediaLibrary.mockResolvedValue(undefined);
    mocks.listAssets.mockResolvedValue([]);
    mocks.listOccurrences.mockResolvedValue([]);
    mocks.getAsset.mockResolvedValue({
      assetId: "asset_replacement",
      width: 1600,
      height: 900,
      contentType: "image/png",
    });
    mocks.getOccurrence.mockResolvedValue({
      occurrenceId: "occurrence_home_hero",
      revision: 2,
      assetId: "asset_replacement",
      crop: null,
    });
    mocks.saveMediaOccurrence.mockResolvedValue({
      workspaceId: "workspace_editor",
      revision: 3,
    });
    mocks.loadContentApplication.mockResolvedValue({
      commands: { saveMediaOccurrence: mocks.saveMediaOccurrence },
      queries: {
        getCurrent: mocks.getCurrentContent,
        getRevision: mocks.getContentRevision,
        isRevisionCurrent: mocks.isRevisionCurrent,
      },
    });
    mocks.getCurrentContent.mockResolvedValue({
      revision: 3,
      definition: { home: { media: [] } },
    });
    mocks.getContentRevision.mockResolvedValue({
      revision: 2,
      definition: { home: { media: [] } },
    });
    mocks.isRevisionCurrent.mockResolvedValue(true);
    mocks.loadApplication.mockResolvedValue({
      commands: {
        upload: mocks.upload,
        replaceOccurrence: mocks.replace,
        cropOccurrence: mocks.crop,
        delete: mocks.delete,
        grantAccess: mocks.grantAccess,
      },
      queries: {
        listAssets: mocks.listAssets,
        listOccurrences: mocks.listOccurrences,
        getSource: mocks.getSource,
        getThumbnailSource: mocks.getThumbnailSource,
        getAsset: mocks.getAsset,
        getOccurrence: mocks.getOccurrence,
        getReplacementReceipt: mocks.getReplacementReceipt,
      },
    });
  });

  it("reports Access key-service outages as unavailable", async () => {
    mocks.loadIdentity.mockRejectedValue(new AccessIdentityUnavailableError());

    const response = await GET(
      new Request(
        "https://foundry.example/api/foundry-cms/media?workspaceId=workspace_editor",
      ),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "request_check_unavailable",
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
    const firstContentKey =
      mocks.saveMediaOccurrence.mock.calls[0]?.[0].idempotencyKey;
    const rebasedContentKey =
      mocks.saveMediaOccurrence.mock.calls[1]?.[0].idempotencyKey;
    expect(mocks.saveMediaOccurrence).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ baseRevision: 3 }),
    );
    expect(rebasedContentKey).not.toBe(firstContentKey);
  });

  it("replays a completed replace after its success response was lost", async () => {
    const completedOccurrence = {
      occurrenceId: "occurrence_home_hero",
      revision: 2,
      assetId: "asset_replacement",
      crop: null,
    } as const;
    mocks.getOccurrence.mockResolvedValue(completedOccurrence);
    mocks.replace.mockResolvedValue(completedOccurrence);
    mocks.getCurrentContent.mockResolvedValue({
      revision: 3,
      definition: {
        home: {
          media: [
            {
              occurrenceId: "occurrence_home_hero",
              revision: 2,
              asset: {
                assetId: "asset_replacement",
                width: 1600,
                height: 900,
                contentType: "image/png",
              },
              crop: null,
            },
          ],
        },
      },
    });

    const response = await POST(
      new Request("https://foundry.example/api/foundry-cms/media", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "lost-replace-response-0001",
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
    expect(mocks.saveMediaOccurrence).not.toHaveBeenCalled();
  });

  it("proves a completed replacement receipt without creating a mutation", async () => {
    const completedOccurrence = {
      occurrenceId: "occurrence_home_hero",
      revision: 2,
      assetId: "asset_replacement",
      crop: null,
    } as const;
    mocks.getReplacementReceipt.mockResolvedValue(completedOccurrence);
    mocks.getOccurrence.mockResolvedValue(completedOccurrence);

    const response = await POST(
      new Request("https://foundry.example/api/foundry-cms/media", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "lost-replace-response-0001",
        },
        body: JSON.stringify({
          operation: "replace",
          requireReplay: true,
          occurrenceId: "occurrence_home_hero",
          assetId: "asset_replacement",
          baseRevision: 1,
          workspaceId: "workspace_editor",
          contentBaseRevision: 2,
        }),
      }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ mutationReplay: true }),
    );
    expect(mocks.getReplacementReceipt).toHaveBeenCalledOnce();
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it("rejects replacement proof when no matching receipt exists", async () => {
    mocks.getReplacementReceipt.mockResolvedValue(null);

    const response = await POST(
      new Request("https://foundry.example/api/foundry-cms/media", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "missing-replace-receipt-0001",
        },
        body: JSON.stringify({
          operation: "replace",
          requireReplay: true,
          occurrenceId: "occurrence_home_hero",
          assetId: "asset_replacement",
          baseRevision: 1,
          workspaceId: "workspace_editor",
          contentBaseRevision: 2,
        }),
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "content_revision_conflict",
      currentRevision: 3,
    });
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(mocks.saveMediaOccurrence).not.toHaveBeenCalled();
  });

  it("does not bind an obsolete replay receipt over the current media head", async () => {
    const obsoleteReceipt = {
      occurrenceId: "occurrence_home_hero",
      revision: 1,
      assetId: "asset_replacement",
      crop: null,
    } as const;
    mocks.replace.mockResolvedValue(obsoleteReceipt);
    mocks.getOccurrence.mockResolvedValue({
      ...obsoleteReceipt,
      revision: 2,
      assetId: "asset_newer",
    });
    mocks.getCurrentContent.mockResolvedValue({
      revision: 3,
      definition: {
        home: {
          media: [
            {
              occurrenceId: "occurrence_home_hero",
              revision: 1,
              asset: {
                assetId: "asset_replacement",
                width: 1600,
                height: 900,
                contentType: "image/png",
              },
              crop: null,
            },
          ],
        },
      },
    });

    const response = await POST(
      new Request("https://foundry.example/api/foundry-cms/media", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "obsolete-replace-receipt-0001",
        },
        body: JSON.stringify({
          operation: "replace",
          occurrenceId: "occurrence_home_hero",
          assetId: "asset_replacement",
          baseRevision: 0,
          workspaceId: "workspace_editor",
          contentBaseRevision: 2,
        }),
      }),
    );

    expect(response.status).toBe(409);
    expect(mocks.replace).toHaveBeenCalledOnce();
    expect(mocks.saveMediaOccurrence).not.toHaveBeenCalled();
  });

  it("replays a completed crop after its success response was lost", async () => {
    const completedOccurrence = {
      occurrenceId: "occurrence_home_hero",
      revision: 2,
      assetId: "asset_replacement",
      crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
    } as const;
    mocks.getOccurrence.mockResolvedValue(completedOccurrence);
    mocks.crop.mockResolvedValue(completedOccurrence);
    mocks.getCurrentContent.mockResolvedValue({
      revision: 3,
      definition: {
        home: {
          media: [
            {
              occurrenceId: "occurrence_home_hero",
              revision: 2,
              asset: {
                assetId: "asset_replacement",
                width: 1600,
                height: 900,
                contentType: "image/png",
              },
              crop: completedOccurrence.crop,
            },
          ],
        },
      },
    });

    const response = await POST(
      new Request("https://foundry.example/api/foundry-cms/media", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "lost-crop-response-0001",
        },
        body: JSON.stringify({
          operation: "crop",
          occurrenceId: "occurrence_home_hero",
          baseRevision: 1,
          crop: completedOccurrence.crop,
          workspaceId: "workspace_editor",
          contentBaseRevision: 2,
        }),
      }),
    );

    expect(response.status).toBe(201);
    expect(mocks.crop).toHaveBeenCalledOnce();
    expect(mocks.saveMediaOccurrence).not.toHaveBeenCalled();
  });

  it.each([null, "1", 1.5, -1])(
    "rejects malformed occurrence base revision %j",
    async (baseRevision) => {
      const response = await POST(
        new Request("https://foundry.example/api/foundry-cms/media", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": "reject-malformed-base-0001",
          },
          body: JSON.stringify({
            operation: "replace",
            occurrenceId: "occurrence_home_hero",
            assetId: "asset_replacement",
            baseRevision,
            workspaceId: "workspace_editor",
            contentBaseRevision: 2,
          }),
        }),
      );

      expect(response.status).toBe(422);
      expect(mocks.replace).not.toHaveBeenCalled();
    },
  );

  it("rejects crop coordinates encoded as strings", async () => {
    const response = await POST(
      new Request("https://foundry.example/api/foundry-cms/media", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "reject-string-crop-0001",
        },
        body: JSON.stringify({
          operation: "crop",
          occurrenceId: "occurrence_home_hero",
          baseRevision: 1,
          crop: { x: "0", y: 0, width: 1, height: 1 },
          workspaceId: "workspace_editor",
          contentBaseRevision: 2,
        }),
      }),
    );

    expect(response.status).toBe(422);
    expect(mocks.crop).not.toHaveBeenCalled();
  });

  it("crops an inherited content occurrence into workspace-local revision one", async () => {
    mocks.getOccurrence
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        occurrenceId: "occurrence_home_hero",
        revision: 1,
        assetId: "asset_replacement",
        crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
      });
    mocks.getCurrentContent.mockResolvedValue({
      revision: 2,
      definition: {
        home: {
          media: [
            {
              occurrenceId: "occurrence_home_hero",
              revision: 8,
              asset: {
                assetId: "asset_replacement",
                width: 1600,
                height: 900,
                contentType: "image/png",
              },
              crop: null,
            },
          ],
        },
      },
    });
    mocks.getContentRevision.mockResolvedValue({
      revision: 2,
      definition: {
        home: {
          media: [
            {
              occurrenceId: "occurrence_home_hero",
              revision: 8,
              asset: {
                assetId: "asset_replacement",
                width: 1600,
                height: 900,
                contentType: "image/png",
              },
              crop: null,
            },
          ],
        },
      },
    });
    mocks.crop.mockResolvedValue({
      occurrenceId: "occurrence_home_hero",
      revision: 1,
      assetId: "asset_replacement",
      crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
    });

    const response = await POST(
      new Request("https://foundry.example/api/foundry-cms/media", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "crop-inherited-media-0001",
        },
        body: JSON.stringify({
          operation: "crop",
          occurrenceId: "occurrence_home_hero",
          baseRevision: 0,
          crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
          workspaceId: "workspace_editor",
          contentBaseRevision: 2,
        }),
      }),
    );

    expect(response.status).toBe(201);
    expect(mocks.crop).toHaveBeenCalledWith(
      expect.objectContaining({
        assetId: "asset_replacement",
        baseRevision: 0,
      }),
    );
  });

  it("does not rebind an older occurrence over a newer same-slot revision", async () => {
    mocks.getOccurrence.mockResolvedValue(null);
    mocks.getContentRevision.mockResolvedValue({
      revision: 2,
      definition: {
        home: {
          media: [
            {
              occurrenceId: "occurrence_home_hero",
              revision: 2,
              asset: {
                assetId: "asset_inherited",
                width: 800,
                height: 600,
                contentType: "image/png",
              },
              crop: null,
            },
          ],
        },
      },
    });
    mocks.getCurrentContent.mockResolvedValue({
      revision: 3,
      definition: {
        home: {
          media: [
            {
              occurrenceId: "occurrence_home_hero",
              revision: 3,
              asset: {
                assetId: "asset_newer",
                width: 1200,
                height: 800,
                contentType: "image/webp",
              },
              crop: { x: 0.1, y: 0, width: 0.9, height: 1 },
            },
          ],
        },
      },
    });

    const response = await POST(
      new Request("https://foundry.example/api/foundry-cms/media", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "reject-stale-media-slot-0001",
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

    expect(response.status).toBe(409);
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(mocks.saveMediaOccurrence).not.toHaveBeenCalled();
  });

  it("rebases when inherited media has the same revision number but different content", async () => {
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
    mocks.getContentRevision.mockResolvedValue({
      revision: 2,
      definition: {
        home: {
          media: [
            {
              occurrenceId: "occurrence_home_hero",
              revision: 2,
              asset: {
                assetId: "asset_inherited",
                width: 800,
                height: 600,
                contentType: "image/png",
              },
              crop: null,
            },
          ],
        },
      },
    });
    mocks.getCurrentContent
      .mockResolvedValueOnce({
        revision: 2,
        definition: {
          home: {
            media: [
              {
                occurrenceId: "occurrence_home_hero",
                revision: 2,
                asset: {
                  assetId: "asset_inherited",
                  width: 800,
                  height: 600,
                  contentType: "image/png",
                },
                crop: null,
              },
            ],
          },
        },
      })
      .mockResolvedValueOnce({
        revision: 3,
        definition: {
          home: {
            media: [
              {
                occurrenceId: "occurrence_home_hero",
                revision: 2,
                asset: {
                  assetId: "asset_inherited",
                  width: 800,
                  height: 600,
                  contentType: "image/png",
                },
                crop: null,
              },
            ],
          },
        },
      });

    const response = await POST(
      new Request("https://foundry.example/api/foundry-cms/media", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "rebase-inherited-media-0001",
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
    expect(mocks.saveMediaOccurrence).toHaveBeenCalledTimes(2);
    expect(mocks.saveMediaOccurrence).toHaveBeenLastCalledWith(
      expect.objectContaining({ baseRevision: 3 }),
    );
  });

  it("validates workspace access before appending a media occurrence", async () => {
    mocks.getCurrentContent.mockRejectedValueOnce(
      new ContentWorkspaceAccessError(),
    );

    const response = await POST(
      new Request("https://foundry.example/api/foundry-cms/media", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "reject-workspace-before-media",
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

    expect(response.status).toBe(403);
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it("rejects a stale workspace before appending a media occurrence", async () => {
    mocks.isRevisionCurrent.mockResolvedValueOnce(false);

    const response = await POST(
      new Request("https://foundry.example/api/foundry-cms/media", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "reject-stale-before-media-0001",
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

    expect(response.status).toBe(409);
    expect(mocks.replace).not.toHaveBeenCalled();
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
      workspaceId: "workspace_editor",
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

  it("derives upload content type from validated bytes when the browser omits it", async () => {
    const png = Uint8Array.from(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    const source = new File([png], "pixel.png");
    const form = new FormData();
    form.set("assetId", "asset_pixel");
    form.set("source", source);
    mocks.upload.mockResolvedValue({ assetId: "asset_pixel" });

    const response = await POST(
      new Request("https://foundry.example/api/foundry-cms/media", {
        method: "POST",
        headers: {
          "content-length": String(png.byteLength + 1024),
          "idempotency-key": "upload-without-mime-0001",
        },
        body: form,
      }),
    );

    expect(response.status).toBe(201);
    expect(mocks.upload).toHaveBeenCalledWith(
      expect.objectContaining({
        assetId: "asset_pixel",
        contentType: "image/png",
        width: 1,
        height: 1,
      }),
    );
  });

  it("returns a retry window while another media mutation owns the lease", async () => {
    mocks.delete.mockRejectedValue(new MediaMutationInProgressError());

    const response = await POST(
      new Request("https://foundry.example/api/foundry-cms/media", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "retry-active-delete-lease",
        },
        body: JSON.stringify({
          operation: "delete",
          assetId: "asset_replacement",
        }),
      }),
    );

    expect(response.status).toBe(409);
    expect(response.headers.get("retry-after")).toBe("30");
    await expect(response.json()).resolves.toEqual({
      error: "media_mutation_in_progress",
    });
  });

  it("rejects oversized or unbounded multipart requests before parsing", async () => {
    const oversized = new Request(
      "https://foundry.example/api/foundry-cms/media",
      {
        method: "POST",
        headers: {
          "content-length": String(21 * 1024 * 1024),
          "content-type": "multipart/form-data; boundary=unused",
          "idempotency-key": "oversized-upload-0001",
        },
        body: "--unused--",
      },
    );
    const unknownLength = new Request(
      "https://foundry.example/api/foundry-cms/media",
      {
        method: "POST",
        headers: {
          "content-type": "multipart/form-data; boundary=unused",
          "idempotency-key": "unbounded-upload-0001",
        },
        body: "--unused--",
      },
    );

    await expect(POST(oversized)).resolves.toMatchObject({ status: 422 });
    await expect(POST(unknownLength)).resolves.toMatchObject({ status: 422 });
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it("serves a private source only through the authenticated site application", async () => {
    mocks.getSource.mockResolvedValue({
      body: new Uint8Array([1, 2, 3]),
      contentType: "image/png",
    });

    const response = await GET(
      new Request(
        "https://foundry.example/api/foundry-cms/media?assetId=asset_hero&accessToken=signed-media-access",
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.verifyMediaAccess).toHaveBeenCalledWith(
      "signed-media-access",
      expect.objectContaining({
        binding: { issuer: "issuer", subject: "subject" },
      }),
      "asset_hero",
    );
    expect(mocks.getSource).toHaveBeenCalledWith("asset_hero");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });

  it("rejects private source reads without an issued media capability", async () => {
    mocks.verifyMediaAccess.mockRejectedValue(
      new HumanRequestIntegrityError(),
    );

    const response = await GET(
      new Request(
        "https://foundry.example/api/foundry-cms/media?assetId=asset_hero",
      ),
    );

    expect(response.status).toBe(403);
    expect(mocks.getSource).not.toHaveBeenCalled();
  });

  it("audits access before issuing a private media capability", async () => {
    mocks.grantAccess.mockResolvedValue({
      assets: [{ assetId: "asset_hero" }],
      occurrences: [
        {
          occurrenceId: "occurrence_home_hero",
          assetId: "asset_hero",
        },
      ],
      accessGrantedAt: "2026-07-27T12:00:00.000Z",
    });

    const response = await POST(
      new Request("https://foundry.example/api/foundry-cms/media", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "grant-media-access-0001",
        },
        body: JSON.stringify({
          operation: "access",
          workspaceId: "workspace_editor",
        }),
      }),
    );

    await expect(response.json()).resolves.toEqual({
      libraryToken: "signed-media-library",
      libraryTokenExpiresAt: 1_785_124_800,
      assets: [{ assetId: "asset_hero" }],
      occurrences: [
        {
          occurrenceId: "occurrence_home_hero",
          assetId: "asset_hero",
        },
      ],
      accessToken: "signed-media-access",
      accessTokenExpiresAt: 1_785_124_800,
    });
    expect(mocks.grantAccess).toHaveBeenCalledWith({
      actorId: "membership-editor",
      workspaceId: "workspace_editor",
      idempotencyKey: "grant-media-access-0001",
    });
    expect(mocks.createMediaAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        binding: { issuer: "issuer", subject: "subject" },
      }),
      ["asset_hero"],
      "2026-07-27T12:00:00.000Z",
    );
  });

  it("limits media capabilities to assets used by current occurrences", async () => {
    mocks.getCurrentContent.mockResolvedValue({
      revision: 3,
      definition: {
        home: {
          media: [
            {
              occurrenceId: "occurrence_home_hero",
              revision: 0,
              asset: { assetId: "asset_inherited" },
              crop: null,
            },
          ],
        },
      },
    });
    mocks.grantAccess.mockResolvedValue({
      assets: Array.from({ length: 500 }, (_, index) => ({
        assetId: `asset_catalog_${index}`,
      })),
      occurrences: [
        { occurrenceId: "occurrence_home_hero", assetId: "asset_catalog_7" },
        { occurrenceId: "occurrence_home_detail", assetId: "asset_catalog_9" },
        { occurrenceId: "occurrence_duplicate", assetId: "asset_catalog_7" },
      ],
      accessGrantedAt: "2026-07-27T12:00:00.000Z",
    });

    await POST(
      new Request("https://foundry.example/api/foundry-cms/media", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "bounded-media-access-0001",
        },
        body: JSON.stringify({
          operation: "access",
          workspaceId: "workspace_editor",
        }),
      }),
    );

    expect(mocks.createMediaAccess).toHaveBeenCalledWith(
      expect.any(Object),
      ["asset_catalog_7", "asset_catalog_9", "asset_inherited"],
      "2026-07-27T12:00:00.000Z",
    );
  });

  it("checks workspace access before granting private media access", async () => {
    mocks.getCurrentContent.mockRejectedValueOnce(
      new ContentWorkspaceAccessError(),
    );

    const response = await POST(
      new Request("https://foundry.example/api/foundry-cms/media", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operation: "access",
          workspaceId: "workspace_other",
        }),
      }),
    );

    expect(response.status).toBe(403);
    expect(mocks.grantAccess).not.toHaveBeenCalled();
  });
});

const onePixelPng = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ),
);

describe("media thumbnails", () => {
  beforeEach(() => {
    vi.resetAllMocks();
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
    mocks.verifyMediaAccess.mockResolvedValue(undefined);
    mocks.loadApplication.mockResolvedValue({
      commands: {
        upload: mocks.upload,
        replaceOccurrence: mocks.replace,
        cropOccurrence: mocks.crop,
        delete: mocks.delete,
        grantAccess: mocks.grantAccess,
      },
      queries: {
        listAssets: mocks.listAssets,
        listOccurrences: mocks.listOccurrences,
        getSource: mocks.getSource,
        getThumbnailSource: mocks.getThumbnailSource,
        getAsset: mocks.getAsset,
        getOccurrence: mocks.getOccurrence,
        getReplacementReceipt: mocks.getReplacementReceipt,
      },
    });
  });

  function uploadRequest(form: FormData, contentLength: number) {
    return new Request("https://foundry.example/api/foundry-cms/media", {
      method: "POST",
      headers: {
        "content-length": String(contentLength),
        "idempotency-key": "upload-with-thumbnail-0001",
      },
      body: form,
    });
  }

  it("passes an uploaded thumbnail to the library with bytes-derived metadata", async () => {
    const form = new FormData();
    form.set("assetId", "asset_pixel");
    form.set("source", new File([onePixelPng], "pixel.png"));
    form.set("thumbnail", new File([onePixelPng], "thumbnail"));
    mocks.upload.mockResolvedValue({ assetId: "asset_pixel" });

    const response = await POST(
      uploadRequest(form, onePixelPng.byteLength * 2 + 1024),
    );

    expect(response.status).toBe(201);
    expect(mocks.upload).toHaveBeenCalledWith(
      expect.objectContaining({
        assetId: "asset_pixel",
        thumbnail: {
          contentType: "image/png",
          byteLength: onePixelPng.byteLength,
          width: 1,
          height: 1,
          source: expect.any(Uint8Array),
        },
      }),
    );
  });

  it("uploads without a thumbnail when the browser did not send one", async () => {
    const form = new FormData();
    form.set("assetId", "asset_pixel");
    form.set("source", new File([onePixelPng], "pixel.png"));
    mocks.upload.mockResolvedValue({ assetId: "asset_pixel" });

    const response = await POST(
      uploadRequest(form, onePixelPng.byteLength + 1024),
    );

    expect(response.status).toBe(201);
    expect(mocks.upload).toHaveBeenCalledWith(
      expect.not.objectContaining({ thumbnail: expect.anything() }),
    );
  });

  it("rejects an upload whose thumbnail part is not an image file", async () => {
    const form = new FormData();
    form.set("assetId", "asset_pixel");
    form.set("source", new File([onePixelPng], "pixel.png"));
    form.set("thumbnail", new File([new Uint8Array([1, 2, 3])], "thumbnail"));

    const response = await POST(
      uploadRequest(form, onePixelPng.byteLength + 1024),
    );

    expect(response.status).toBe(422);
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it("rejects an upload whose thumbnail part is larger than the thumbnail limit", async () => {
    const form = new FormData();
    form.set("assetId", "asset_pixel");
    form.set("source", new File([onePixelPng], "pixel.png"));
    form.set(
      "thumbnail",
      new File([new Uint8Array(512 * 1024 + 1)], "thumbnail"),
    );

    const response = await POST(
      uploadRequest(form, onePixelPng.byteLength + 512 * 1024 + 2048),
    );

    expect(response.status).toBe(422);
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it("serves the stored thumbnail when the gallery asks for that variant", async () => {
    mocks.getThumbnailSource.mockResolvedValue({
      body: new Uint8Array([7, 7, 7]),
      contentType: "image/webp",
    });

    const response = await GET(
      new Request(
        "https://foundry.example/api/foundry-cms/media?assetId=asset_hero&libraryToken=signed-media-library&variant=thumbnail",
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(response.headers.get("x-foundry-media-variant")).toBe("thumbnail");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.getSource).not.toHaveBeenCalled();
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([7, 7, 7]),
    );
  });

  it("never serves the source in a thumbnail's place", async () => {
    // The library capability names no asset. If a missing thumbnail fell back
    // to the source, that capability would become a way to read every
    // full-resolution original on the site.
    mocks.getThumbnailSource.mockResolvedValue(null);
    mocks.getSource.mockResolvedValue({
      body: new Uint8Array([1, 2, 3]),
      contentType: "image/png",
    });

    const response = await GET(
      new Request(
        "https://foundry.example/api/foundry-cms/media?assetId=asset_hero&libraryToken=signed-media-library&variant=thumbnail",
      ),
    );

    expect(response.status).toBe(404);
    expect(mocks.getSource).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      error: "media_not_found",
    });
  });

  it("refuses a thumbnail without the library capability", async () => {
    mocks.verifyMediaLibrary.mockRejectedValue(
      new HumanRequestIntegrityError(),
    );

    const response = await GET(
      new Request(
        "https://foundry.example/api/foundry-cms/media?assetId=asset_hero&variant=thumbnail",
      ),
    );

    expect(response.status).toBe(403);
    expect(mocks.getThumbnailSource).not.toHaveBeenCalled();
    expect(mocks.getSource).not.toHaveBeenCalled();
  });

  it("never unlocks a thumbnail with the per-asset capability alone", async () => {
    // The two capabilities have different audiences on purpose. A thumbnail
    // is checked against the library capability and nothing else.
    mocks.verifyMediaLibrary.mockRejectedValue(
      new HumanRequestIntegrityError(),
    );
    mocks.verifyMediaAccess.mockResolvedValue(undefined);

    const response = await GET(
      new Request(
        "https://foundry.example/api/foundry-cms/media?assetId=asset_hero&accessToken=signed-media-access&variant=thumbnail",
      ),
    );

    expect(response.status).toBe(403);
    expect(mocks.verifyMediaAccess).not.toHaveBeenCalled();
  });

  it("never unlocks a full-resolution source with the library capability", async () => {
    mocks.verifyMediaAccess.mockRejectedValue(new HumanRequestIntegrityError());
    mocks.verifyMediaLibrary.mockResolvedValue(undefined);
    mocks.getThumbnailSource.mockResolvedValue(null);
    mocks.getSource.mockResolvedValue({
      body: new Uint8Array([1, 2, 3]),
      contentType: "image/png",
    });

    const withoutVariant = await GET(
      new Request(
        "https://foundry.example/api/foundry-cms/media?assetId=asset_hero&libraryToken=signed-media-library",
      ),
    );
    // The same capability, on the path it is actually for, still cannot
    // reach the source when no thumbnail exists.
    const withVariant = await GET(
      new Request(
        "https://foundry.example/api/foundry-cms/media?assetId=asset_hero&libraryToken=signed-media-library&variant=thumbnail",
      ),
    );

    expect(withoutVariant.status).toBe(403);
    expect(withVariant.status).toBe(404);
    expect(mocks.getSource).not.toHaveBeenCalled();
  });

  it("rejects a variant name the media route does not serve", async () => {
    const response = await GET(
      new Request(
        "https://foundry.example/api/foundry-cms/media?assetId=asset_hero&libraryToken=signed-media-library&variant=original",
      ),
    );

    expect(response.status).toBe(400);
    expect(mocks.getThumbnailSource).not.toHaveBeenCalled();
    expect(mocks.getSource).not.toHaveBeenCalled();
  });

  it("marks a plain source read as the source variant", async () => {
    mocks.getSource.mockResolvedValue({
      body: new Uint8Array([1, 2, 3]),
      contentType: "image/png",
    });

    const response = await GET(
      new Request(
        "https://foundry.example/api/foundry-cms/media?assetId=asset_hero&accessToken=signed-media-access",
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-foundry-media-variant")).toBe("source");
    expect(mocks.getThumbnailSource).not.toHaveBeenCalled();
  });
});

describe("media capability scope", () => {
  beforeEach(() => {
    vi.resetAllMocks();
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
    mocks.createMediaAccess.mockResolvedValue({
      token: "signed-media-access",
      expiresAt: 1_785_124_800,
    });
    mocks.createMediaLibrary.mockResolvedValue({
      token: "signed-media-library",
      expiresAt: 1_785_124_800,
    });
    mocks.verifyMediaLibrary.mockResolvedValue(undefined);
    mocks.loadContentApplication.mockResolvedValue({
      commands: { saveMediaOccurrence: mocks.saveMediaOccurrence },
      queries: {
        getCurrent: mocks.getCurrentContent,
        getRevision: mocks.getContentRevision,
        isRevisionCurrent: mocks.isRevisionCurrent,
      },
    });
    mocks.getCurrentContent.mockResolvedValue({
      revision: 3,
      definition: { home: { media: [] } },
    });
    mocks.loadApplication.mockResolvedValue({
      commands: { grantAccess: mocks.grantAccess },
      queries: {},
    });
  });

  it("issues a library capability that names no asset, so the gallery can show every photo", async () => {
    // A per-asset capability carries its asset list inside the token, so it
    // is deliberately limited to the photos on the page. The gallery shows
    // the whole library, so it is unlocked by a capability with no list.
    mocks.grantAccess.mockResolvedValue({
      assets: Array.from({ length: 500 }, (_, index) => ({
        assetId: `asset_catalog_${index}`,
      })),
      occurrences: [
        { occurrenceId: "occurrence_home_hero", assetId: "asset_catalog_7" },
      ],
      accessGrantedAt: "2026-07-27T12:00:00.000Z",
    });

    const response = await POST(
      new Request("https://foundry.example/api/foundry-cms/media", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "grant-media-access-scope-0001",
        },
        body: JSON.stringify({
          operation: "access",
          workspaceId: "workspace_editor",
        }),
      }),
    );

    expect(mocks.createMediaAccess).toHaveBeenCalledWith(
      expect.anything(),
      ["asset_catalog_7"],
      "2026-07-27T12:00:00.000Z",
    );
    expect(mocks.createMediaLibrary).toHaveBeenCalledWith(
      expect.anything(),
      "2026-07-27T12:00:00.000Z",
    );
    await expect(response.json()).resolves.toMatchObject({
      libraryToken: "signed-media-library",
    });
  });

  it("still covers a photo the published page uses but the library no longer lists", async () => {
    mocks.grantAccess.mockResolvedValue({
      assets: [],
      occurrences: [],
      accessGrantedAt: "2026-07-27T12:00:00.000Z",
    });
    mocks.getCurrentContent.mockResolvedValue({
      revision: 3,
      definition: {
        home: { media: [{ asset: { assetId: "asset_published" } }] },
      },
    });

    await POST(
      new Request("https://foundry.example/api/foundry-cms/media", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "grant-media-access-scope-0002",
        },
        body: JSON.stringify({
          operation: "access",
          workspaceId: "workspace_editor",
        }),
      }),
    );

    expect(mocks.createMediaAccess).toHaveBeenCalledWith(
      expect.anything(),
      ["asset_published"],
      "2026-07-27T12:00:00.000Z",
    );
  });
});
