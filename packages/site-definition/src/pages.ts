import type { SiteDefinition, SitePage } from "./index";

/**
 * The slug of the home page: an empty string.
 *
 * A page is served at `/<slug>`, so the home page is the page served at `/`.
 * Storing the root as an empty slug keeps one rule for every page instead of
 * one rule for the home page and another for the rest.
 */
export const homePageSlug = "";

/**
 * The slugs a page may not take, in sorted order.
 *
 * Each one is the first path segment of a route the installation already
 * serves: the dashboard, the blog, the HTTP API, the preview routes and the
 * newsletter. A page with one of these slugs would never be reachable, because
 * the fixed route wins.
 */
export const reservedPageSlugs = Object.freeze([
  "__foundry",
  "api",
  "blog",
  "dash",
  "newsletter",
] as const);

/**
 * The slug rule as a JSON Schema pattern: either the empty root slug, or
 * lowercase words joined by single hyphens. It matches the blog post slug rule,
 * with the empty string added for the home page.
 */
export const pageSlugPattern = "^$|^[a-z0-9]+(?:-[a-z0-9]+)*$";

/** The longest slug a page may have. Matches the blog post slug limit. */
export const pageSlugMaxLength = 120;

/** The page with this id, or `undefined` when the site has no such page. */
export function findPageById(
  definition: SiteDefinition,
  id: string,
): SitePage | undefined {
  return definition.pages.find((page) => page.id === id);
}

/** The page with this slug, or `undefined` when the site has no such page. */
export function findPageBySlug(
  definition: SiteDefinition,
  slug: string,
): SitePage | undefined {
  return definition.pages.find((page) => page.slug === slug);
}

/**
 * Where the home page sits in `pages`.
 *
 * Use this when you must write into a mutable draft, because a write needs the
 * index. Prefer `homePage` for reading. The schema requires exactly one page
 * with the root slug, so a valid definition always has one.
 */
export function homePageIndex(definition: SiteDefinition): number {
  const index = definition.pages.findIndex(
    (page) => page.slug === homePageSlug,
  );
  if (index === -1) {
    throw new TypeError("site_definition_home_page_absent");
  }
  return index;
}

/**
 * The home page.
 *
 * This is the accessor every caller that still works on one page uses, so each
 * area can move to the full page collection on its own.
 */
export function homePage(definition: SiteDefinition): SitePage {
  return definition.pages[homePageIndex(definition)]!;
}

/**
 * The editable field path of one field on one page.
 *
 * `pathInPage` is the path the field has inside its own page, such as
 * `section_hero.title` or `seo.title` for a page's SEO block. Note that a
 * page's SEO paths already start with the page id, so they are passed in
 * whole.
 *
 * The home page adds no prefix. Its paths were written when a site held one
 * page. A published rich-text file is named after its field path, and a stored
 * draft holds the path each edit was made under, so a prefix on the home page
 * would rename every published file and invalidate every stored draft path.
 * See ADR-0017.
 *
 * Every other page prefixes its fields with its page id. A page id never
 * changes, so a slug rename moves no file. Two pages may hold sections with
 * the same id, because the page id in front of the section id keeps the two
 * paths apart.
 */
export function pageFieldPath(page: SitePage, pathInPage: string): string {
  return page.slug === homePageSlug ? pathInPage : `${page.id}.${pathInPage}`;
}

/** The two media places every page may fill: a hero photo and a detail photo. */
export const pageMediaSlots = ["hero", "detail"] as const;
export type PageMediaSlot = (typeof pageMediaSlots)[number];

/**
 * The one shape every media occurrence id matches: the home page's own two
 * ids, or `occurrence_<pageId>_hero`/`occurrence_<pageId>_detail` for any
 * other page. The JSON Schema pattern in `index.ts` and the write-path
 * validator in `@humber-foundry/application`'s `media-assets.ts` both read
 * this pattern, so the two enforcement points cannot drift apart. See
 * ADR-0026.
 */
export const pageMediaOccurrenceIdPattern =
  /^occurrence_[a-z][a-z0-9_]*_(?:hero|detail)$/u;

/**
 * The media occurrence id for one slot on one page.
 *
 * The home page keeps its two existing ids unchanged: `occurrence_home_hero`
 * and `occurrence_home_detail`. They were stored, published and referenced by
 * stored drafts before a site could have more than one page, so they carry no
 * page id, for the same reason `pageFieldPath` gives the home page no prefix.
 * See ADR-0017 and ADR-0026.
 *
 * Every other page's occurrence id is built from its own page id:
 * `occurrence_<pageId>_hero` or `occurrence_<pageId>_detail`. A page id never
 * changes, so a slug rename moves nothing this id names.
 */
export function pageMediaOccurrenceId(
  page: SitePage,
  slot: PageMediaSlot,
): `occurrence_${string}_${PageMediaSlot}` {
  return page.slug === homePageSlug
    ? `occurrence_home_${slot}`
    : `occurrence_${page.id}_${slot}`;
}

/**
 * The identifier of one page's section slot: the place the visual editor adds,
 * moves and removes sections in.
 *
 * The home page keeps `slot_home_sections` unchanged. That identifier is the
 * field path a stored draft writes its unsaved structural change under, so a
 * new name would make every stored home-page recovery record unreadable. This
 * is the same reason `pageFieldPath` gives the home page no prefix and
 * `pageMediaOccurrenceId` keeps the home page's two occurrence ids. See
 * ADR-0017, ADR-0026 and ADR-0032.
 *
 * Every other page's slot id is built from its own page id:
 * `slot_<pageId>_sections`. A page id never changes, so a slug rename leaves
 * the identifier alone. Two pages can never share a slot id, so a structural
 * change stored for one page can never be applied to another.
 */
export function pageCompositionSlotId(page: SitePage): string {
  return page.slug === homePageSlug
    ? "slot_home_sections"
    : `slot_${page.id}_sections`;
}

/** The one shape every page's section slot id matches. */
export const pageCompositionSlotIdPattern = /^slot_[a-z][a-z0-9_]*_sections$/u;

/**
 * Whether a field path names a page's section slot rather than one field.
 *
 * A field path always holds a dot — `section_hero.title`, or a page id in
 * front of it — and a slot id never does, so the two can never be confused.
 */
export function isPageCompositionSlotId(path: string): boolean {
  return pageCompositionSlotIdPattern.test(path);
}

/**
 * The page a section-slot identifier names, or `undefined` when this site has
 * no such page.
 *
 * A stored draft holds a structural change under its slot id alone. This is
 * how the editor reads that identifier back and finds the page the change
 * belongs to, so a recovered change is restored to the page it was made on.
 */
export function findPageByCompositionSlotId(
  definition: SiteDefinition,
  slotId: string,
): SitePage | undefined {
  return definition.pages.find((page) => pageCompositionSlotId(page) === slotId);
}

/**
 * The media manifest's field path on one page. The home page keeps
 * `home.media`, for the same reason its slot id and field paths are unprefixed.
 */
export function pageMediaFieldPath(page: SitePage): string {
  return page.slug === homePageSlug ? "home.media" : `${page.id}.media`;
}

/**
 * The same definition with one page swapped for a new version of itself.
 *
 * The page is matched by id, and the order of `pages` is kept, so a rewrite
 * never moves a page in the Pages list.
 */
export function replacePage(
  definition: SiteDefinition,
  page: SitePage,
): SiteDefinition {
  const index = definition.pages.findIndex(({ id }) => id === page.id);
  if (index === -1) {
    throw new TypeError("site_definition_page_absent");
  }
  const pages = [...definition.pages];
  pages[index] = page;
  return { ...definition, pages };
}
