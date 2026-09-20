import {
  findPageById,
  findPageHrefReferences,
  homePage,
  homePageSlug,
  suggestPageSlug,
  type SiteDefinition,
} from "@humber-foundry/site-definition";

import {
  editorPageHref,
  listEditorPages,
  type EditorPageSummary,
} from "./editor-page-selection";

/**
 * One link that must change before a page can be deleted.
 *
 * `name` is what the owner reads. `href` opens the screen where that link is
 * edited: the page that holds the button, or the home page for a navigation
 * item, because navigation is edited on every page.
 */
export type PageDeleteBlocker = Readonly<{
  name: string;
  href: string;
}>;

/**
 * One row of the Pages list, with what the owner may do to it.
 *
 * `blockedBy` is empty when nothing points at the page. It is worked out on
 * the server from the draft, so the list can name the blocking links before
 * the owner presses anything. The application refuses the delete as well, so
 * this is a courtesy and never the only guard. See ADR-0033.
 */
export type PageActionSummary = EditorPageSummary &
  Readonly<{
    /** The web address without the leading slash; empty for the home page. */
    slug: string;
    /** `true` when this page is already on the live site. */
    isPublished: boolean;
    canDelete: boolean;
    blockedBy: ReadonlyArray<PageDeleteBlocker>;
    /** The name and address the Duplicate dialog opens with. */
    duplicateTitle: string;
    duplicateSlug: string;
  }>;

/**
 * Every page of the draft as a row the owner can act on.
 *
 * `workspaceUrl` is the Pages address with the workspace it already carries,
 * so each blocking link can be turned into an address that opens the right
 * page in the editor.
 */
export function listPageActions(
  definition: SiteDefinition,
  workspaceUrl: string,
  publishedDefinition?: SiteDefinition,
): PageActionSummary[] {
  const home = homePage(definition);
  return listEditorPages(definition, publishedDefinition).map((summary) => {
    const page = findPageById(definition, summary.id)!;
    const blockedBy = findPageHrefReferences(definition, summary.id).map(
      (reference) => ({
        name:
          reference.location === "navigation"
            ? `Navigation — ${reference.label}`
            : `${
                findPageById(definition, reference.pageId ?? "")?.title ??
                "Another page"
              } — ${reference.label}`,
        href: editorPageHref(workspaceUrl, reference.pageId ?? home.id),
      }),
    );
    const duplicate = suggestDuplicatePage(definition, summary.id);
    return {
      ...summary,
      slug: page.slug,
      isPublished: summary.publishedState !== "not-published",
      canDelete: !summary.isHome && blockedBy.length === 0,
      blockedBy,
      duplicateTitle: duplicate.title,
      duplicateSlug: duplicate.slug,
    };
  });
}

/**
 * The name and web address to offer for a copy of one page.
 *
 * The copy is named after the page it came from so the owner can see which is
 * which in the list, and its address is suggested from that name. A site that
 * already holds the suggested address gets the next free number, so pressing
 * Duplicate twice never opens a dialog the owner has to correct.
 */
export function suggestDuplicatePage(
  definition: SiteDefinition,
  pageId: string,
): Readonly<{ title: string; slug: string }> {
  const page = findPageById(definition, pageId);
  const title = `${page?.title ?? "Page"} copy`;
  const taken = new Set(
    definition.pages.map(({ slug }) => slug).filter((slug) => slug !== homePageSlug),
  );
  const base = suggestPageSlug(title);
  let slug = base;
  let next = 2;
  while (taken.has(slug)) {
    slug = `${base}-${next}`;
    next += 1;
  }
  return { title, slug };
}
