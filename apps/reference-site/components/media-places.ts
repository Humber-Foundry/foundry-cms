/**
 * Where a photo can appear on a page, in the owner's words.
 *
 * Every page has the same two photo slots. The slot is the last part of the
 * occurrence id, so any page's ids read here, not only the home page's two.
 * See ADR-0026 and ADR-0043.
 */
const slotNames: Readonly<Record<string, string>> = {
  hero: "Top of the page",
  detail: "Further down the page",
};

const pageMediaOccurrencePattern = /^occurrence_.+_(hero|detail)$/u;

/**
 * The name of the place with this id, or the id itself when this build does
 * not know it. Occurrence ids arrive from the server, so one this build has
 * never seen is possible; showing the raw id beats showing nothing.
 */
export function placeNameFor(occurrenceId: string): string {
  const slot = pageMediaOccurrencePattern.exec(occurrenceId)?.[1];
  return (slot === undefined ? undefined : slotNames[slot]) ?? occurrenceId;
}
