import type { MediaCrop } from "@humber-foundry/application";

export type MediaOccurrenceState = Readonly<{
  occurrenceId: string;
  revision: number;
  assetId: string;
  crop: MediaCrop | null;
}>;

export function mediaDeleteFailureMessage(
  body: unknown,
  retryAfter: string | null,
): string {
  const error =
    typeof body === "object" && body !== null && "error" in body
      ? body.error
      : undefined;
  if (error === "media_mutation_in_progress") {
    const seconds =
      retryAfter !== null && /^\d+$/.test(retryAfter) ? retryAfter : "30";
    return `Another media change is still finishing. Retry in ${seconds} seconds.`;
  }
  if (error === "media_asset_referenced") {
    // The screen refuses a photo the site uses before it sends anything, so
    // this is the answer when the screen's own list was out of date.
    return "This photo could not be deleted. Your site still uses it. Open the page that shows it, change the photo there, then try again.";
  }
  return "The photo could not be deleted. Retry the same request.";
}

export function mediaAssetSelection(assetId: string) {
  return { assetId, deleteAttempt: null } as const;
}

export function mediaAssetSelectionForCatalog<DeleteAttempt>(
  selectedAssetId: string,
  assets: ReadonlyArray<Readonly<{ assetId: string }>>,
  deleteAttempt: DeleteAttempt | null = null,
) {
  if (
    selectedAssetId !== "" &&
    deleteAttempt !== null &&
    !assets.some((asset) => asset.assetId === selectedAssetId)
  ) {
    return { assetId: selectedAssetId, deleteAttempt } as const;
  }
  return mediaAssetSelection(
    assets.some((asset) => asset.assetId === selectedAssetId)
      ? selectedAssetId
      : (assets[0]?.assetId ?? ""),
  );
}

export function upsertMediaAsset<Asset extends Readonly<{ assetId: string }>>(
  assets: ReadonlyArray<Asset>,
  asset: Asset,
): ReadonlyArray<Asset> {
  return [
    ...assets.filter((candidate) => candidate.assetId !== asset.assetId),
    asset,
  ];
}
