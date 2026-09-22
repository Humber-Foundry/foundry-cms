import { describe, expect, it } from "vitest";

import {
  mediaAssetSelection,
  mediaAssetSelectionForCatalog,
  mediaDeleteFailureMessage,
  upsertMediaAsset,
} from "./media-manager-state";

describe("media library state", () => {
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
      "This photo could not be deleted. Your site still uses it. Open the page that shows it, change the photo there, then try again.",
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
});
