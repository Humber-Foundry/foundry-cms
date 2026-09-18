import {
  findPageById,
  homePage,
  homePageSlug,
  pagePath,
  type EditableSiteField,
  type SiteDefinition,
  type SitePage,
} from "@humber-foundry/site-definition";

/**
 * The one place that answers "which page is the owner editing?".
 *
 * The dashboard addresses a page with `?page=<id>`. Every screen that has to
 * know the page being edited reads it through this module, so the rule lives
 * in one file instead of in each destination. Later tickets that move the
 * canvas, the undo history and the draft recovery onto the selected page read
 * the page from here as well.
 */

/** The search-parameter name that carries the page id. */
export const editorPageParameter = "page";

/**
 * The page id asked for in the address, or `undefined` when the address names
 * no page. A repeated parameter names no single page, so it is ignored.
 */
export function readEditorPageId(
  searchParams: Readonly<Record<string, string | string[] | undefined>>,
): string | undefined {
  const requested = searchParams[editorPageParameter];
  if (typeof requested !== "string") return undefined;
  const trimmed = requested.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * The page the editor opens.
 *
 * An address with no page, or one naming a page this draft does not hold,
 * falls back to the home page. A draft always has a home page, so the editor
 * always has something to show and never fails on a stale link.
 */
export function resolveEditorPage(
  definition: SiteDefinition,
  requestedPageId: string | undefined,
): SitePage {
  if (requestedPageId === undefined) return homePage(definition);
  return findPageById(definition, requestedPageId) ?? homePage(definition);
}

/**
 * `true` when the address named a page that this draft does not hold, so a
 * screen can say the page was not found instead of silently showing another
 * one.
 */
export function editorPageWasNotFound(
  definition: SiteDefinition,
  requestedPageId: string | undefined,
): boolean {
  return (
    requestedPageId !== undefined &&
    findPageById(definition, requestedPageId) === undefined
  );
}

/** What the Pages list and the page switcher show for one page. */
export type EditorPageSummary = Readonly<{
  id: string;
  title: string;
  /** Where the page is served: `/` for the home page, `/<slug>` otherwise. */
  path: string;
  isHome: boolean;
  /** Whether this page is already on the live site, and whether it changed. */
  publishedState: "on-your-site" | "changed-since-publish" | "not-published";
}>;

/** The words the owner reads for each published state. */
export const editorPagePublishedStateLabels: Readonly<
  Record<EditorPageSummary["publishedState"], string>
> = {
  "on-your-site": "On your site",
  "changed-since-publish": "Changed since you published",
  "not-published": "Not on your site yet",
};

/**
 * Every page of the draft, in the order the draft holds them, each one saying
 * whether it is already on the live site.
 *
 * `publishedDefinition` is the site as it is published. When it is missing —
 * nothing is published yet — every page reads as not published.
 */
export function listEditorPages(
  definition: SiteDefinition,
  publishedDefinition?: SiteDefinition,
): EditorPageSummary[] {
  return definition.pages.map((page) => {
    const published =
      publishedDefinition === undefined
        ? undefined
        : findPageById(publishedDefinition, page.id);
    return {
      id: page.id,
      title: page.title,
      path: pagePath(page),
      isHome: page.slug === homePageSlug,
      publishedState:
        published === undefined
          ? "not-published"
          : JSON.stringify(published) === JSON.stringify(page)
            ? "on-your-site"
            : "changed-since-publish",
    };
  });
}

/**
 * The dashboard address that opens one page in the editor.
 *
 * `base` is the address of the destination, with the workspace it already
 * carries. The page id replaces any page the address already named, so
 * switching pages never stacks two page parameters.
 */
export function editorPageHref(base: string, pageId: string): string {
  const [path, query = ""] = splitOnce(base, "?");
  const parameters = new URLSearchParams(query);
  parameters.set(editorPageParameter, pageId);
  return `${path}?${parameters.toString()}`;
}

function splitOnce(value: string, separator: string): [string, string?] {
  const at = value.indexOf(separator);
  return at === -1
    ? [value]
    : [value.slice(0, at), value.slice(at + separator.length)];
}

/**
 * The fields the editor shows for one page.
 *
 * A field that names no page belongs to the whole site — the site name, the
 * navigation labels, the footer — so it shows on every page. A field that
 * names a different page is left out, because the owner opened one page and
 * should see that page's words alone.
 *
 * This filters what is shown, never what is saved. The draft still holds every
 * page's fields, so an edit made on one page is not lost by opening another.
 */
export function fieldsForEditorPage<Field extends EditableSiteField>(
  fields: ReadonlyArray<Field>,
  pageId: string,
): Field[] {
  return fields.filter(
    (field) => field.pageId === undefined || field.pageId === pageId,
  );
}

/**
 * The page a link inside the canvas points at, or `undefined` when the link
 * leaves the site or names no page.
 *
 * Today a navigation item may only hold an anchor or a mail address, so no
 * stored link resolves to a page yet. Ticket #155 adds page targets to
 * navigation; this rule is what turns such a target into a page to open.
 */
export function editorPageForLinkPath(
  definition: SiteDefinition,
  href: string,
): SitePage | undefined {
  if (!href.startsWith("/")) return undefined;
  const path = splitOnce(splitOnce(href, "#")[0], "?")[0];
  const wanted = path === "" ? "/" : path.replace(/\/+$/u, "") || "/";
  return definition.pages.find((page) => pagePath(page) === wanted);
}
