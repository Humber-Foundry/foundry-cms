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

/** The page the editor opens, and whether the address actually found it. */
export type ResolvedEditorPage = Readonly<{
  page: SitePage;
  /**
   * `true` when the address named a page this draft does not hold. The caller
   * must then say so; showing `page` without a word would let an owner edit
   * one page believing they were editing another.
   */
  wasNotFound: boolean;
}>;

/**
 * The page the editor opens.
 *
 * An address with no page, or one naming a page this draft does not hold,
 * falls back to the home page. A draft always has a home page, so the editor
 * always has something to show and never fails on a stale link.
 *
 * The answer carries `wasNotFound` with it, so a caller cannot take the page
 * and forget that the address asked for a different one.
 */
export function resolveEditorPage(
  definition: SiteDefinition,
  requestedPageId: string | undefined,
): ResolvedEditorPage {
  if (requestedPageId === undefined) {
    return { page: homePage(definition), wasNotFound: false };
  }
  const found = findPageById(definition, requestedPageId);
  return found === undefined
    ? { page: homePage(definition), wasNotFound: true }
    : { page: found, wasNotFound: false };
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

/**
 * The words the owner reads for each published state.
 *
 * One or two words, so the state reads as a column down the Pages list
 * instead of a sentence on each row. "Draft changes" says the page is on the
 * site and the draft holds newer words for it.
 */
export const editorPagePublishedStateLabels: Readonly<
  Record<EditorPageSummary["publishedState"], string>
> = {
  "on-your-site": "Published",
  "changed-since-publish": "Draft changes",
  "not-published": "Not published",
};

/**
 * The colour each published state takes in a `DashboardStateLabel`.
 *
 * A published page is live, so it reads in the live colour. A page with
 * unpublished words and a page that was never published are both draft work,
 * so both read in the draft colour.
 */
export const editorPagePublishedStateTones: Readonly<
  Record<EditorPageSummary["publishedState"], "live" | "draft">
> = {
  "on-your-site": "live",
  "changed-since-publish": "draft",
  "not-published": "draft",
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
          : samePage(published, page)
            ? "on-your-site"
            : "changed-since-publish",
    };
  });
}

/**
 * Whether two versions of a page hold the same content.
 *
 * The comparison sorts object keys, because one version is read from stored
 * JSON and the other is built in memory. Two objects with the same fields in a
 * different order are the same page, and a plain text comparison would call
 * them different and tell the owner a page had changed when it had not.
 */
function samePage(left: SitePage, right: SitePage): boolean {
  return stableText(left) === stableText(right);
}

function stableText(value: unknown): string {
  return JSON.stringify(value, (_key, held: unknown) =>
    held !== null && typeof held === "object" && !Array.isArray(held)
      ? Object.fromEntries(
          Object.entries(held as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : held,
  );
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
