import type { MediaCrop } from "@foundry/application";

export type MediaOccurrenceState = Readonly<{
  occurrenceId: string;
  revision: number;
  assetId: string;
  crop: MediaCrop | null;
}>;

export const fullFrameCrop: MediaCrop = Object.freeze({
  x: 0,
  y: 0,
  width: 1,
  height: 1,
});

export function cropBaseRevisionForEdit(
  baseRevision: number | null,
  currentRevision: number,
): number {
  return baseRevision ?? currentRevision;
}

export function cropForCatalogRefresh(
  localCrop: MediaCrop,
  baseRevision: number | null,
  occurrences: ReadonlyArray<MediaOccurrenceState>,
  occurrenceId: string,
): MediaCrop {
  return baseRevision === null
    ? cropForOccurrence(occurrences, occurrenceId)
    : localCrop;
}

export function mediaOccurrenceAttemptAfterFailure<Attempt>(
  attempt: Attempt,
  responseStatus: number | undefined,
  responseBody: unknown,
): Attempt | null {
  const error =
    typeof responseBody === "object" &&
    responseBody !== null &&
    "error" in responseBody
      ? responseBody.error
      : undefined;
  return responseStatus === 409 &&
    (error === "media_revision_conflict" ||
      error === "content_revision_conflict" ||
      error === "content_revision_stale")
    ? null
    : attempt;
}

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
    return "This asset is still referenced by revision history and cannot be deleted.";
  }
  return "The asset could not be deleted. Retry the same request.";
}

export function mediaAssetSelection(assetId: string) {
  return {
    assetId,
    replaceAttempt: null,
    deleteAttempt: null,
  } as const;
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
    return {
      assetId: selectedAssetId,
      replaceAttempt: null,
      deleteAttempt,
    } as const;
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

export function cropForOccurrence(
  occurrences: ReadonlyArray<
    Readonly<{ occurrenceId: string; crop: MediaCrop | null }>
  >,
  occurrenceId: string,
): MediaCrop {
  return (
    occurrences.find(
      (occurrence) => occurrence.occurrenceId === occurrenceId,
    )?.crop ?? fullFrameCrop
  );
}

export function cropForSelectedRevision(
  selectedOccurrenceId: string,
  revision: Readonly<{ occurrenceId: string; crop: MediaCrop | null }>,
) {
  return selectedOccurrenceId === revision.occurrenceId
    ? revision.crop ?? fullFrameCrop
    : undefined;
}

export function mediaOccurrenceMutationsEnabled(
  contentStale: boolean,
  contentRevision: Readonly<{ revision: number }> | undefined,
) {
  return !contentStale && contentRevision !== undefined;
}

export function mergeMediaOccurrenceState(
  workspaceOccurrences: ReadonlyArray<MediaOccurrenceState>,
  contentOccurrences: ReadonlyArray<
    Readonly<{
      occurrenceId: string;
      revision: number;
      asset: Readonly<{ assetId: string }>;
      crop: MediaCrop | null;
    }>
  >,
): ReadonlyArray<MediaOccurrenceState> {
  const workspaceById = new Map(
    workspaceOccurrences.map((occurrence) => [
      occurrence.occurrenceId,
      occurrence,
    ]),
  );
  const inherited = contentOccurrences.map(
    (occurrence): MediaOccurrenceState =>
      workspaceById.get(occurrence.occurrenceId) ?? {
        occurrenceId: occurrence.occurrenceId,
        revision: 0,
        assetId: occurrence.asset.assetId,
        crop: occurrence.crop,
      },
  );
  const contentIds = new Set(
    contentOccurrences.map((occurrence) => occurrence.occurrenceId),
  );
  return [
    ...inherited,
    ...workspaceOccurrences.filter(
      (occurrence) => !contentIds.has(occurrence.occurrenceId),
    ),
  ];
}
