import type { PageSection } from "@foundry/site-definition";

export function sectionAnchor(section: PageSection): string {
  return section.id;
}
