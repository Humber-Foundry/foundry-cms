/** Where a photo can appear on a page, in the owner's words. */
export type MediaPlace = Readonly<{ name: string; detail: string }>;

/**
 * The two photo slots every page has. The slot is the last part of the
 * occurrence id, so any page's ids read here, not only the home page's two.
 * See ADR-0026.
 */
const slots: Readonly<Record<string, MediaPlace>> = {
  hero: {
    name: "Top of the page",
    detail: "The large photo visitors see first.",
  },
  detail: {
    name: "Further down the page",
    detail: "The smaller photo beside the text.",
  },
};

const pageMediaOccurrencePattern = /^occurrence_.+_(hero|detail)$/u;

/**
 * The place with this id, or a stand-in built from the id itself. Occurrence
 * ids arrive from the server, so one that this build does not know about is
 * possible; showing the raw id beats showing nothing.
 */
export function placeFor(occurrenceId: string): MediaPlace {
  const slot = pageMediaOccurrencePattern.exec(occurrenceId)?.[1];
  return (
    (slot === undefined ? undefined : slots[slot]) ?? {
      name: occurrenceId,
      detail: "",
    }
  );
}

/** The name of the place with this id. */
export function placeNameFor(occurrenceId: string): string {
  return placeFor(occurrenceId).name;
}
