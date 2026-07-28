import type { MediaCrop } from "@foundry/application";

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
