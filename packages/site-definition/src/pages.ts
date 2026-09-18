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
