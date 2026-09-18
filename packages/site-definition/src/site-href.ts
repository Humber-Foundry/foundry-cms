import type { SiteDefinition, SiteHref, SiteLink, SitePage } from "./index";
import { findPageById, homePageSlug } from "./pages";

/**
 * Builds the public path of one page: `/` for the home page, `/<slug>` for
 * any other. `pagePath` in `seo.ts` is the production implementation. A
 * revision preview (#156) passes its own builder, so the same resolution
 * runs there too.
 */
export type PageHrefBuilder = (page: SitePage) => string;

const pageHrefPattern = /^page:([a-z][a-z0-9_]*)(?:#([a-z][a-z0-9_]*))?$/u;

export type ParsedSiteHref =
  | Readonly<{ kind: "anchor"; anchor: string }>
  | Readonly<{ kind: "mailto"; address: string }>
  | Readonly<{ kind: "blog" }>
  | Readonly<{ kind: "page"; pageId: string; anchor: string | null }>
  | Readonly<{ kind: "unrecognized" }>;

/** Reads a stored href into the destination it names. See ADR-0019. */
export function parseSiteHref(href: string): ParsedSiteHref {
  if (href === "blog") {
    return { kind: "blog" };
  }
  if (href.startsWith("#")) {
    return { kind: "anchor", anchor: href.slice(1) };
  }
  if (href.startsWith("mailto:")) {
    return { kind: "mailto", address: href.slice("mailto:".length) };
  }
  const match = pageHrefPattern.exec(href);
  if (match) {
    return { kind: "page", pageId: match[1]!, anchor: match[2] ?? null };
  }
  return { kind: "unrecognized" };
}

/** The page id a `page:` href names, or `null` for any other kind of href. */
export function siteHrefPageId(href: string): string | null {
  const parsed = parseSiteHref(href);
  return parsed.kind === "page" ? parsed.pageId : null;
}

function resolvePageAnchor(
  currentPage: SitePage | null,
  pageHref: PageHrefBuilder,
  targetPage: SitePage,
  anchor: string,
): string {
  return currentPage !== null && currentPage.id === targetPage.id
    ? `#${anchor}`
    : `${pageHref(targetPage)}#${anchor}`;
}

/**
 * The address a stored href resolves to on the page named by `currentPage`.
 *
 * `currentPage` is the page being rendered, or `null` on a route that shows
 * no page, such as the Blog. `pageHref` builds one page's public path;
 * `pagePath` from `seo.ts` is the production builder, and a revision preview
 * passes its own so the same resolution runs there (#156).
 *
 * An anchor written with no `page:` prefix (`#contact`) is the shorthand
 * every definition wrote before a site could have more than one page. It
 * always names the home page: on the home page it stays `#contact`; from any
 * other page it becomes the home page's path plus the anchor, `/#contact`.
 * `page:<pageId>#<anchor>` gives the same result for any page, home or not,
 * and is what the page picker now writes.
 *
 * A `page:` href that names no page in `definition` cannot occur in a valid
 * definition — `isBaseSiteDefinition` refuses one before it is stored — but a
 * defensively-read one resolves to the anchor alone (or the empty string for
 * a whole-page link) rather than throw.
 */
export function resolveSiteHref(
  definition: SiteDefinition,
  href: SiteHref,
  context: Readonly<{
    currentPage: SitePage | null;
    pageHref: PageHrefBuilder;
    blogHref: string;
  }>,
): string {
  const parsed = parseSiteHref(href);
  switch (parsed.kind) {
    case "mailto":
      return href;
    case "blog":
      return context.blogHref;
    case "anchor": {
      const home = definition.pages.find(
        (page) => page.slug === homePageSlug,
      );
      return home === undefined
        ? href
        : resolvePageAnchor(
            context.currentPage,
            context.pageHref,
            home,
            parsed.anchor,
          );
    }
    case "page": {
      const target = findPageById(definition, parsed.pageId);
      if (target === undefined) {
        return parsed.anchor === null ? "" : `#${parsed.anchor}`;
      }
      return parsed.anchor === null
        ? context.pageHref(target)
        : resolvePageAnchor(
            context.currentPage,
            context.pageHref,
            target,
            parsed.anchor,
          );
    }
    case "unrecognized":
      return href;
  }
}

/** One link that targets a page, and where it lives in the definition. */
export type SiteHrefPageReference = Readonly<{
  /** Where the referencing link is edited: the Navigation group, or a page's own content. */
  location: "navigation" | "page";
  /** The label the owner gave this link. */
  label: string;
  /** The page the link is edited on. Absent for a navigation link, which is site-wide. */
  pageId?: string;
}>;

function siteLinkReferences(
  link: SiteLink,
  pageId: string,
  location: SiteHrefPageReference["location"],
  hostPageId: string | undefined,
): SiteHrefPageReference | null {
  return siteHrefPageId(link.href) === pageId
    ? { location, label: link.label, ...(hostPageId === undefined ? {} : { pageId: hostPageId }) }
    : null;
}

/**
 * Every navigation item, and every hero or call-to-action button, whose link
 * targets the given page id.
 *
 * Ticket #159 calls this before it lets an owner delete a page, so it can
 * refuse the delete and name what still points at it instead of leaving a
 * broken link behind.
 */
export function findPageHrefReferences(
  definition: SiteDefinition,
  pageId: string,
): ReadonlyArray<SiteHrefPageReference> {
  const references: SiteHrefPageReference[] = [];
  for (const link of definition.site.navigation) {
    const reference = siteLinkReferences(link, pageId, "navigation", undefined);
    if (reference !== null) references.push(reference);
  }
  for (const page of definition.pages) {
    for (const section of page.sections) {
      if (section.type === "hero") {
        for (const link of [section.primaryAction, section.secondaryAction]) {
          const reference = siteLinkReferences(link, pageId, "page", page.id);
          if (reference !== null) references.push(reference);
        }
      } else if (section.type === "callToAction") {
        const reference = siteLinkReferences(
          section.action,
          pageId,
          "page",
          page.id,
        );
        if (reference !== null) references.push(reference);
      }
    }
  }
  return references;
}
