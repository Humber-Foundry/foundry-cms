/** Where a photo can appear on the page, in the owner's words. */
export type MediaPlace = Readonly<{ name: string; detail: string }>;

const places: Readonly<Record<string, MediaPlace>> = {
  occurrence_home_hero: {
    name: "Top of the page",
    detail: "The large photo visitors see first.",
  },
  occurrence_home_detail: {
    name: "Further down the page",
    detail: "The smaller photo beside the text.",
  },
};

/**
 * The place with this id, or a stand-in built from the id itself. Occurrence
 * ids arrive from the server, so one that this build does not know about is
 * possible; showing the raw id beats showing nothing.
 */
export function placeFor(occurrenceId: string): MediaPlace {
  return places[occurrenceId] ?? { name: occurrenceId, detail: "" };
}

/** The name of the place with this id. */
export function placeNameFor(occurrenceId: string): string {
  return placeFor(occurrenceId).name;
}
