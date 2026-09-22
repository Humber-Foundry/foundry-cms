import type { InstalledPublicFormDefinition } from "@humber-foundry/application";
import {
  pageDisplayTitle,
  pagePath,
  type SiteDefinition,
} from "@humber-foundry/site-definition";

/**
 * What Messages says about the forms the site has.
 *
 * Three facts answer the owner's question: what the form is called, where a
 * visitor can find it, and how many messages it has brought in. A form that is
 * declared but sits on no page is still listed, because a form nobody can see
 * is the reason an inbox stays empty. See ADR-0044.
 *
 * This reads the draft definition, so a form block the owner has just placed
 * is listed before the site is published.
 */
export type SiteFormPlacement = Readonly<{
  /** What the owner calls the page, never its internal id. */
  pageTitle: string;
  /** Where the page is served, such as `/` or `/about`. */
  pagePath: string;
}>;

export type SiteFormOverviewRow = Readonly<{
  /** The form's own id. It keys the list; no screen has to show it. */
  formId: string;
  name: string;
  placements: ReadonlyArray<SiteFormPlacement>;
  messageCount: number;
}>;

/** The page component that puts a declared form on a page. */
const contactFormComponentType = "contactForm";

function placementsByFormId(
  definition: SiteDefinition,
): ReadonlyMap<string, ReadonlyArray<SiteFormPlacement>> {
  const found = new Map<string, SiteFormPlacement[]>();
  for (const page of definition.pages) {
    for (const section of page.sections) {
      if (
        section.type !== "registered" ||
        section.component !== contactFormComponentType
      ) {
        continue;
      }
      const formId = section.props.formId;
      if (typeof formId !== "string" || formId === "") continue;
      const placement: SiteFormPlacement = {
        pageTitle: pageDisplayTitle(page),
        pagePath: pagePath(page),
      };
      const existing = found.get(formId);
      if (existing === undefined) {
        found.set(formId, [placement]);
        continue;
      }
      // One page can hold the same form twice. The owner needs to know the
      // page, not how many blocks are on it, so each page is named once.
      if (
        !existing.some((known) => known.pagePath === placement.pagePath)
      ) {
        existing.push(placement);
      }
    }
  }
  return found;
}

export function siteFormsOverview(
  definition: SiteDefinition,
  forms: ReadonlyArray<InstalledPublicFormDefinition>,
  messageCounts: Readonly<Record<string, number>> = {},
): ReadonlyArray<SiteFormOverviewRow> {
  const placements = placementsByFormId(definition);
  return forms.map((form) =>
    Object.freeze({
      formId: form.id,
      name: form.name,
      placements: Object.freeze(placements.get(form.id) ?? []),
      messageCount: messageCounts[form.id] ?? 0,
    }),
  );
}

/**
 * The sentence shown when a form is on no page, or `null` when it is placed.
 * A placed form is shown as a link to each page instead, so the owner can go
 * and look at it.
 */
export function formNotPlacedNotice(row: SiteFormOverviewRow): string | null {
  return row.placements.length === 0
    ? "This form is on no page, so nobody can send a message. Add the contact form block to a page."
    : null;
}

/** The sentence that says how many messages one form has brought in. */
export function formMessageCountSentence(row: SiteFormOverviewRow): string {
  if (row.messageCount === 0) {
    return "No messages yet.";
  }
  return row.messageCount === 1
    ? "1 message received."
    : `${row.messageCount} messages received.`;
}
