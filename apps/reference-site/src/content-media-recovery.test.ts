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

  it("preflights all occurrences before issuing any mutation", async () => {
    const occurrence = (
      occurrenceId:
        | "occurrence_home_hero"
        | "occurrence_home_detail",
      assetId: string,
      revision = 1,
    ) =>
      ({
        occurrenceId,
        revision,
        asset: {
          assetId,
          width: 1200,
          height: 800,
          contentType: "image/jpeg",
        },
        crop: null,
      }) as const;
    const baseFirst = occurrence("occurrence_home_hero", "asset_base");
    const targetFirst = occurrence(
      "occurrence_home_hero",
      "asset_preserved",
      2,
    );
    const conflictingBase = occurrence(
      "occurrence_home_detail",
      "asset_proof_base",
    );
    const conflictingTarget = occurrence(
      "occurrence_home_detail",
      "asset_proof_preserved",
      2,
    );
    const conflictingDestination = occurrence(
      "occurrence_home_detail",
      "asset_proof_newer",
      5,
    );
    const send = vi.fn();

    await expect(
      restorePreservedMedia({
        edit: {
          path: mediaManifestRecoveryPath,
          baseValue: canonicalJson([
            baseFirst,
            conflictingBase,
          ]),
          value: canonicalJson([
            targetFirst,
            conflictingTarget,
          ]),
        },
        created: {
          workspaceId: "workspace_fresh",
          revision: 0,
          definition: {
            ...referenceSiteDefinition,
            home: {
              ...referenceSiteDefinition.home,
              media: [
                baseFirst,
                conflictingDestination,
              ],
            },
          },
        },
        mutationToken: "csrf-start",
        idempotencyKey: "workspace-create-0001",
        send,
      }),
    ).rejects.toThrow("content_media_recovery_conflict");
    expect(send).not.toHaveBeenCalled();
  });

  it("retains a newer destination binding when the preserved target was unchanged", async () => {
    const base = {
      occurrenceId: "occurrence_home_hero",
      revision: 1,
      asset: {
        assetId: "asset_base",
        width: 1200,
        height: 800,
        contentType: "image/jpeg",
      },
      crop: null,
    } as const;
    const destination = {
      ...base,
      revision: 4,
      asset: { ...base.asset, assetId: "asset_destination" },
    };
    const send = vi.fn();

    await expect(
      restorePreservedMedia({
        edit: {
          path: mediaManifestRecoveryPath,
          baseValue: canonicalJson([base]),
          value: canonicalJson([base]),
        },
        created: {
          workspaceId: "workspace_fresh",
          revision: 0,
          definition: {
            ...referenceSiteDefinition,
            home: {
              ...referenceSiteDefinition.home,
              media: [destination],
            },
          },
        },
        mutationToken: "csrf-start",
        idempotencyKey: "workspace-create-0001",
        send,
      }),
    ).resolves.toBe("csrf-start");
    expect(send).not.toHaveBeenCalled();
  });

  it("preserves an unrelated occurrence added only by the destination", async () => {
    const base = {
      occurrenceId: "occurrence_home_hero",
      revision: 1,
      asset: {
        assetId: "asset_base",
        width: 1200,
        height: 800,
        contentType: "image/jpeg",
      },
      crop: null,
    } as const;
    const target = {
      ...base,
      revision: 2,
      asset: { ...base.asset, assetId: "asset_preserved" },
    };
    const destinationOnly = {
      occurrenceId: "occurrence_home_detail",
      revision: 3,
      asset: {
        assetId: "asset_destination_detail",
        width: 800,
        height: 800,
        contentType: "image/webp",
      },
      crop: null,
    } as const;
    const send = vi.fn().mockResolvedValue({
      response: { ok: true },
      body: {
        occurrence: { revision: 1 },
        contentRevision: { revision: 1 },
      },
      mutationToken: "csrf-after-replace",
    });

    await expect(
      restorePreservedMedia({
        edit: {
          path: mediaManifestRecoveryPath,
          baseValue: canonicalJson([base]),
          value: canonicalJson([target]),
        },
        created: {
          workspaceId: "workspace_fresh",
          revision: 0,
          definition: {
            ...referenceSiteDefinition,
            home: {
              ...referenceSiteDefinition.home,
              media: [base, destinationOnly],
            },
          },
        },
        mutationToken: "csrf-start",
        idempotencyKey: "workspace-create-0001",
        send,
      }),
    ).resolves.toBe("csrf-after-replace");
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(send.mock.calls[0]![0].body)).toEqual(
      expect.objectContaining({
        operation: "replace",
        occurrenceId: "occurrence_home_hero",
        assetId: "asset_preserved",
      }),
    );
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
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        response: { ok: true },
        body: {
          occurrence: { revision: 1 },
          contentRevision: { revision: 1 },
          mutationReplay: true,
        },
        mutationToken: "csrf-after-proof",
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
    expect(send).toHaveBeenCalledTimes(2);
    expect(JSON.parse(send.mock.calls[0]![0].body)).toEqual({
      operation: "replace",
      requireReplay: true,
      occurrenceId: "occurrence_home_hero",
      assetId: "asset_replacement",
      baseRevision: 0,
      workspaceId: "workspace_fresh",
      contentBaseRevision: 1,
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

  it("does not crop a same-asset destination without a replacement receipt", async () => {
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
    const destination = { ...replacement, revision: 1, crop: null };
    const send = vi.fn().mockResolvedValue({
      response: { ok: false },
      body: { error: "content_revision_conflict" },
      mutationToken: "csrf-after-proof",
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
          definition: {
            ...referenceSiteDefinition,
            home: {
              ...referenceSiteDefinition.home,
              media: [destination],
            },
          },
        },
        mutationToken: "csrf-retry",
        idempotencyKey: "workspace-create-0001",
        send,
      }),
    ).rejects.toThrow("content_media_recovery_conflict");
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0].idempotencyKey).toBe(
      "workspace-create-0001:media:occurrence_home_hero:replace",
    );
  });
});
