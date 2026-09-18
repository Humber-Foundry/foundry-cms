import type { Metadata } from "next";

import {
  findPageBySlug,
  homePageSlug,
  reservedPageSlugs,
  resolvePageSeo,
  type SiteDefinition,
  type SitePage,
} from "@humber-foundry/site-definition";

import { publicMetadata } from "./public-metadata";

const reservedPageSlugSet: ReadonlySet<string> = new Set(reservedPageSlugs);

/**
 * The page this installation serves at `/<slug>`, or `null` when no page
 * answers to it.
 *
 * The home page is served at `/`, through its own route, not this one. Its
 * slug is refused here even though `findPageBySlug` would find it.
 *
 * A reserved slug — `blog`, `dash`, `api`, `__foundry`, `newsletter` — is
 * refused before the page collection is searched. The schema already stops a
 * page from taking one of these slugs, and Next.js always serves a fixed
 * route ahead of this dynamic one, so this check is a second guard: even a
 * definition that reached this function with a reserved slug on a page — a
 * stored value written before the schema forbade it, for example — can never
 * render through this route.
 */
export function findPublicPage(
  definition: SiteDefinition,
  slug: string,
): SitePage | null {
  if (slug === homePageSlug || reservedPageSlugSet.has(slug)) {
    return null;
  }
  return findPageBySlug(definition, slug) ?? null;
}

/** The metadata this route emits for one page. */
export function pageRouteMetadata(
  definition: SiteDefinition,
  page: SitePage,
): Metadata {
  return publicMetadata(resolvePageSeo(definition, page), {
    siteName: definition.site.name,
    kind: "website",
  });
}
