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
