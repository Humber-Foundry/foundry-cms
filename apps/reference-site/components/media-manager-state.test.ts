import { describe, expect, it } from "vitest";

import {
  cropForOccurrence,
  cropBaseRevisionForEdit,
  cropForCatalogRefresh,
  cropForSelectedRevision,
  mediaAssetSelection,
  mediaAssetSelectionForCatalog,
  mediaDeleteFailureMessage,
  mediaOccurrenceAttemptAfterFailure,
  mediaOccurrenceMutationsEnabled,
  mergeMediaOccurrenceState,
  upsertMediaAsset,
} from "./media-manager-state";

describe("media manager crop state", () => {
  it("keeps edited crop coordinates paired with their original base revision", () => {
    const local = { x: 0.1, y: 0.1, width: 0.8, height: 0.8 };
    const refreshed = [
      {
        occurrenceId: "occurrence_home_hero",
        revision: 3,
        assetId: "asset_hero",
        crop: { x: 0.2, y: 0.2, width: 0.6, height: 0.6 },
      },
    ];

    expect(cropBaseRevisionForEdit(null, 2)).toBe(2);
    expect(cropBaseRevisionForEdit(2, 3)).toBe(2);
    expect(
      cropForCatalogRefresh(
        local,
        2,
        refreshed,
        "occurrence_home_hero",
      ),
    ).toBe(local);
    expect(
      cropForCatalogRefresh(
        local,
        null,
        refreshed,
        "occurrence_home_hero",
      ),
    ).toEqual(refreshed[0]!.crop);
  });

  it("rebuilds a stale occurrence attempt after a confirmed conflict", () => {
    const attempt = {
      idempotencyKey: "replace-stale",
      body: { baseRevision: 1 },
    };

    expect(
      mediaOccurrenceAttemptAfterFailure(attempt, 409, {
        error: "media_revision_conflict",
      }),
    ).toBeNull();
    expect(
      mediaOccurrenceAttemptAfterFailure(attempt, 409, {
        error: "media_mutation_in_progress",
      }),
    ).toBe(attempt);
    expect(mediaOccurrenceAttemptAfterFailure(attempt, 503, null)).toBe(
      attempt,
    );
    expect(
      mediaOccurrenceAttemptAfterFailure(attempt, undefined, undefined),
    ).toBe(attempt);
  });

  it("loads the persisted crop for the selected occurrence", () => {
    expect(
      cropForOccurrence(
        [
          {
            occurrenceId: "occurrence_home_hero",
            crop: { x: 0.1, y: 0.2, width: 0.6, height: 0.5 },
          },
        ],
        "occurrence_home_hero",
      ),
    ).toEqual({ x: 0.1, y: 0.2, width: 0.6, height: 0.5 });
  });

  it("uses a full-frame crop for an unbound occurrence", () => {
    expect(cropForOccurrence([], "occurrence_home_detail")).toEqual({
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    });
  });

  it("ignores a delayed revision for an occurrence that is no longer selected", () => {
    expect(
      cropForSelectedRevision("occurrence_home_detail", {
        occurrenceId: "occurrence_home_hero",
        crop: null,
      }),
    ).toBeUndefined();
  });

  it("disables occurrence mutations when the content workspace is stale", () => {
    expect(mediaOccurrenceMutationsEnabled(true, { revision: 3 })).toBe(false);
    expect(mediaOccurrenceMutationsEnabled(false, { revision: 3 })).toBe(true);
    expect(mediaOccurrenceMutationsEnabled(false, undefined)).toBe(false);
  });

  it("distinguishes an active deletion lease from a referenced asset", () => {
    expect(
      mediaDeleteFailureMessage(
        { error: "media_mutation_in_progress" },
        "30",
      ),
    ).toBe("Another media change is still finishing. Retry in 30 seconds.");
    expect(
      mediaDeleteFailureMessage({ error: "media_asset_referenced" }, null),
    ).toBe(
      "This asset is still referenced by revision history and cannot be deleted.",
    );
  });

  it("clears asset-scoped retry state when the selected asset changes", () => {
    expect(mediaAssetSelection("asset_replacement")).toEqual({
      assetId: "asset_replacement",
      replaceAttempt: null,
      deleteAttempt: null,
    });
  });

  it("keeps an interrupted delete retry when catalog refresh hides its asset", () => {
    const deleteAttempt = {
      idempotencyKey: "finish-delete",
      body: { operation: "delete", assetId: "asset_deleted" },
    };
    expect(
      mediaAssetSelectionForCatalog("asset_deleted", [
        { assetId: "asset_remaining" },
      ], deleteAttempt),
    ).toEqual({
      assetId: "asset_deleted",
      replaceAttempt: null,
      deleteAttempt,
    });
  });

  it("upserts an ambiguously replayed upload instead of duplicating it", () => {
    const replayed = { assetId: "asset_uploaded", fileName: "uploaded.png" };

    expect(
      upsertMediaAsset(
        [
          { assetId: "asset_existing", fileName: "existing.png" },
          { assetId: "asset_uploaded", fileName: "stale-name.png" },
        ],
        replayed,
      ),
    ).toEqual([
      { assetId: "asset_existing", fileName: "existing.png" },
      replayed,
    ]);
  });

  it("hydrates inherited content bindings as workspace revision zero", () => {
    expect(
      mergeMediaOccurrenceState([], [
        {
          occurrenceId: "occurrence_home_hero",
          revision: 7,
          asset: { assetId: "asset_inherited" },
          crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
        },
      ]),
    ).toEqual([
      {
        occurrenceId: "occurrence_home_hero",
        revision: 0,
        assetId: "asset_inherited",
        crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
      },
    ]);
  });
});
