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
 * visitor can find it, and how many messages it has received. A form that is
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
 * The one line under a form's name: where a visitor finds it, and how many
 * messages it has received. A form on no page says so plainly, because that is
 * the reason an inbox stays empty.
 */
export function formPlacementAndCountSentence(row: SiteFormOverviewRow): string {
  const count = formMessageCountSentence(row);
  if (row.placements.length === 0) {
    return `On no page, so nobody can send a message. ${count}`;
  }
  const pages = row.placements
    .map((placement) => `${placement.pageTitle} (${placement.pagePath})`)
    .join(", ");
  return `Appears on ${pages}. ${count}`;
}

/**
 * Where a form's row goes when it is pressed: the page it appears on, or the
 * Pages screen when it is on none, so the owner can go and place it.
 */
export function formRowDestination(row: SiteFormOverviewRow): string {
  return row.placements[0]?.pagePath ?? "/dash/pages";
}

/** The sentence that says how many messages one form has received. */
export function formMessageCountSentence(row: SiteFormOverviewRow): string {
  if (row.messageCount === 0) {
    return "No messages yet.";
  }
  return row.messageCount === 1
    ? "1 message received."
    : `${row.messageCount} messages received.`;
}
