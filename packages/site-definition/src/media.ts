import type { SiteDefinition, SiteMediaOccurrence } from "./index";

export function bindSiteMediaOccurrence(
  definition: SiteDefinition,
  occurrence: SiteMediaOccurrence,
): SiteDefinition {
  const media = [
    ...(definition.home.media ?? []).filter(
      (existing) => existing.occurrenceId !== occurrence.occurrenceId,
    ),
    structuredClone(occurrence),
  ].sort((left, right) =>
    left.occurrenceId.localeCompare(right.occurrenceId),
  );
  return structuredClone({
    ...definition,
    home: { ...definition.home, media },
  });
}
