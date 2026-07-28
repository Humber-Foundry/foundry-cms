import { describe, expect, it, vi } from "vitest";

import { canonicalJson } from "@foundry/application";
import { referenceSiteDefinition } from "@foundry/site-definition";

import { mediaManifestRecoveryPath } from "./content-schema-recovery";
import { restorePreservedMedia } from "./content-media-recovery";

describe("content media schema recovery", () => {
  it("rebinds a durable media replacement and crop into the fresh workspace", async () => {
    const baseOccurrence = {
      occurrenceId: "occurrence_home_hero",
      revision: 1,
      asset: {
        assetId: "asset_original",
        width: 1600,
        height: 900,
        contentType: "image/png",
      },
      crop: null,
    } as const;
    const replacement = {
      occurrenceId: "occurrence_home_hero",
      revision: 4,
      asset: {
        assetId: "asset_replacement",
        width: 1200,
        height: 800,
        contentType: "image/jpeg",
      },
      crop: { x: 0.1, y: 0.2, width: 0.7, height: 0.6 },
    } as const;
    const createdDefinition = {
      ...referenceSiteDefinition,
      home: {
        ...referenceSiteDefinition.home,
        media: [baseOccurrence],
      },
    };
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        response: { ok: true },
        body: {
          occurrence: { revision: 1 },
          contentRevision: { revision: 1 },
        },
        mutationToken: "csrf-after-replace",
      })
      .mockResolvedValueOnce({
        response: { ok: true },
        body: {
          occurrence: { revision: 2 },
          contentRevision: { revision: 2 },
        },
        mutationToken: "csrf-after-crop",
      });

    await expect(
      restorePreservedMedia({
        edit: {
          path: mediaManifestRecoveryPath,
          baseValue: canonicalJson([baseOccurrence]),
          value: canonicalJson([replacement]),
        },
        created: {
          workspaceId: "workspace_fresh",
          revision: 0,
          definition: createdDefinition,
        },
        mutationToken: "csrf-start",
        idempotencyKey: "workspace-create-0001",
        send,
      }),
    ).resolves.toBe("csrf-after-crop");
    expect(send).toHaveBeenCalledTimes(2);
    expect(JSON.parse(send.mock.calls[0]![0].body)).toEqual({
      operation: "replace",
      occurrenceId: "occurrence_home_hero",
      assetId: "asset_replacement",
      baseRevision: 0,
      workspaceId: "workspace_fresh",
      contentBaseRevision: 0,
    });
    expect(JSON.parse(send.mock.calls[1]![0].body)).toEqual({
      operation: "crop",
      occurrenceId: "occurrence_home_hero",
      baseRevision: 1,
      workspaceId: "workspace_fresh",
      contentBaseRevision: 1,
      crop: replacement.crop,
    });
  });

  it("does not overwrite a media binding changed since the legacy base", async () => {
    const createdDefinition = {
      ...referenceSiteDefinition,
      home: {
        ...referenceSiteDefinition.home,
        media: [
          {
            occurrenceId: "occurrence_home_hero",
            revision: 5,
            asset: {
              assetId: "asset_newer",
              width: 1400,
              height: 900,
              contentType: "image/webp",
            },
            crop: null,
          },
        ],
      },
    } as const;
    const legacyTarget = {
      occurrenceId: "occurrence_home_hero",
      revision: 3,
      asset: {
        assetId: "asset_legacy",
        width: 1200,
        height: 800,
        contentType: "image/jpeg",
      },
      crop: null,
    } as const;
    const send = vi.fn();

    await expect(
      restorePreservedMedia({
        edit: {
          path: mediaManifestRecoveryPath,
          baseValue: "[]",
          value: canonicalJson([legacyTarget]),
        },
        created: {
          workspaceId: "workspace_fresh",
          revision: 0,
          definition: createdDefinition,
        },
        mutationToken: "csrf-start",
        idempotencyKey: "workspace-create-0001",
        send,
      }),
    ).rejects.toThrow("content_media_recovery_conflict");
    expect(send).not.toHaveBeenCalled();
  });

  it("resumes the crop after a confirmed replacement survives a retry", async () => {
    const replacement = {
      occurrenceId: "occurrence_home_hero",
      revision: 4,
      asset: {
        assetId: "asset_replacement",
        width: 1200,
        height: 800,
        contentType: "image/jpeg",
      },
      crop: { x: 0.1, y: 0.2, width: 0.7, height: 0.6 },
    } as const;
    const confirmedReplacement = {
      ...replacement,
      revision: 1,
      crop: null,
    };
    const createdDefinition = {
      ...referenceSiteDefinition,
      home: {
        ...referenceSiteDefinition.home,
        media: [confirmedReplacement],
      },
    };
    const send = vi.fn().mockResolvedValue({
      response: { ok: true },
      body: {
        occurrence: { revision: 2 },
        contentRevision: { revision: 2 },
      },
      mutationToken: "csrf-after-crop",
    });

    await expect(
      restorePreservedMedia({
        edit: {
          path: mediaManifestRecoveryPath,
          baseValue: "[]",
          value: canonicalJson([replacement]),
        },
        created: {
          workspaceId: "workspace_fresh",
          revision: 1,
          definition: createdDefinition,
        },
        mutationToken: "csrf-retry",
        idempotencyKey: "workspace-create-0001",
        send,
      }),
    ).resolves.toBe("csrf-after-crop");
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(send.mock.calls[0]![0].body)).toEqual({
      operation: "crop",
      occurrenceId: "occurrence_home_hero",
      baseRevision: 1,
      workspaceId: "workspace_fresh",
      contentBaseRevision: 1,
      crop: replacement.crop,
    });
  });
});
