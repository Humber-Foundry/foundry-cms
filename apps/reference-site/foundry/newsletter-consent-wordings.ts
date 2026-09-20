import { newsletterSignupComponent } from "./page-components";
import { installedSiteDefinition } from "./site-definition";

/**
 * Every consent sentence this site actually shows.
 *
 * A site owner writes the sentence on each newsletter signup block, so the
 * sentence a person agreed to is whatever that block said at the time. The
 * signup route checks the sentence the form reports against this list before it
 * records any consent, so a caller cannot write words of their own into
 * somebody's consent record, and the version stored against that record always
 * points at words this site really published.
 */
export function newsletterConsentWordings(): ReadonlyArray<string> {
  const wordings = new Set<string>();
  for (const page of installedSiteDefinition.pages) {
    for (const section of page.sections) {
      if (
        section.type !== "registered" ||
        section.component !== newsletterSignupComponent.type
      ) {
        continue;
      }
      const note = (section.props as { consentNote?: unknown }).consentNote;
      if (typeof note === "string" && note.trim() !== "") {
        wordings.add(note.trim());
      }
    }
  }
  return [...wordings];
}
