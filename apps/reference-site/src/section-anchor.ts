import type { PageSection } from "@humber-foundry/site-definition";

export function sectionAnchor(section: PageSection): string {
  return section.id;
}
