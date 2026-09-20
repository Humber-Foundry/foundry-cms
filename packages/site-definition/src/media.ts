import type { SiteDefinition, SiteMediaOccurrence } from "./index";
import { findPageByMediaOccurrenceId, replacePage } from "./pages";

/**
 * Raised when a media occurrence names no page of this site. Binding the photo
 * to some other page would put it on a page the occurrence id does not name,
 * which `isBaseSiteDefinition` refuses, so the caller is told instead.
 */
export class SiteMediaOccurrencePageError extends Error {
  constructor(readonly occurrenceId: string) {
    super("media_occurrence_page_not_found");
    this.name = "SiteMediaOccurrencePageError";
  }
}

/**
 * The same definition with one photo bound to its own page.
 *
 * The occurrence id names the page it belongs to — `occurrence_home_hero` for
 * the home page, `occurrence_<pageId>_hero` for any other page — so the page
 * is read from the id rather than passed in. See ADR-0026.
 */
export function bindSiteMediaOccurrence(
  definition: SiteDefinition,
  occurrence: SiteMediaOccurrence,
): SiteDefinition {
  const page = findPageByMediaOccurrenceId(
    definition,
    occurrence.occurrenceId,
  );
  if (page === undefined) {
    throw new SiteMediaOccurrencePageError(occurrence.occurrenceId);
  }
  const media = [
    ...(page.media ?? []).filter(
      (existing) => existing.occurrenceId !== occurrence.occurrenceId,
    ),
    structuredClone(occurrence),
  ].sort((left, right) =>
    left.occurrenceId.localeCompare(right.occurrenceId),
  );
  return structuredClone(replacePage(definition, { ...page, media }));
}
