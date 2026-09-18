import type { SiteDefinition, SiteMediaOccurrence } from "./index";
import { homePage, replacePage } from "./pages";

export function bindSiteMediaOccurrence(
  definition: SiteDefinition,
  occurrence: SiteMediaOccurrence,
): SiteDefinition {
  const media = [
    ...(homePage(definition).media ?? []).filter(
      (existing) => existing.occurrenceId !== occurrence.occurrenceId,
    ),
    structuredClone(occurrence),
  ].sort((left, right) =>
    left.occurrenceId.localeCompare(right.occurrenceId),
  );
  return structuredClone(
    replacePage(definition, { ...homePage(definition), media }),
  );
}
