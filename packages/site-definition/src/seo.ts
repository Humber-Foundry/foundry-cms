import type { BlogPost, SeoShareImage, SiteDefinition } from "./index";

/** Where the public site serves one media asset. */
export function publishedMediaPath(assetId: string): `/${string}` {
  return `/api/media/${encodeURIComponent(assetId)}`;
}

/**
 * The metadata one public route actually emits, after every blank field has
 * been replaced by its fallback.
 *
 * `canonicalUrl` and `shareImageUrl` are absolute, because a link preview or a
 * search engine cannot resolve a path. Both are `null` when the site has no
 * canonical origin set, so the page emits no address rather than a wrong one.
 */
export type ResolvedSeo = Readonly<{
  title: string;
  description: string;
  canonicalUrl: string | null;
  keywords: ReadonlyArray<string>;
  shareImage: Readonly<{ url: string; alt: string }> | null;
}>;

function firstFilled(...candidates: ReadonlyArray<string>): string {
  return candidates.find((candidate) => candidate.trim() !== "")?.trim() ?? "";
}

/**
 * Turn a path on this site into the one address search engines should index.
 * Returns `null` when the installation has not set a canonical origin, because
 * a canonical pointing at the wrong host is worse than none at all.
 */
function canonicalUrlFor(
  definition: SiteDefinition,
  path: `/${string}`,
): string | null {
  const origin = definition.site.canonicalOrigin.trim().replace(/\/+$/u, "");
  return origin === "" ? null : `${origin}${path}`;
}

/**
 * The site's own main image: the picture the home page leads with. It is the
 * last-resort share image for any page or post that has none of its own.
 */
function homeHeroShareImage(definition: SiteDefinition): SeoShareImage | null {
  const hero = (definition.home.media ?? []).find(
    ({ occurrenceId }) => occurrenceId === "occurrence_home_hero",
  );
  return hero === undefined
    ? null
    : { url: publishedMediaPath(hero.asset.assetId), alt: "" };
}

/**
 * Resolve a share image to one absolute address. A path needs the site's
 * canonical origin to become absolute, so a path is dropped when no origin is
 * set. An already-absolute address is kept as written.
 */
function resolveShareImage(
  definition: SiteDefinition,
  ...candidates: ReadonlyArray<SeoShareImage | null>
): SeoShareImage | null {
  const chosen = candidates.find(
    (candidate) => candidate !== null && candidate.url.trim() !== "",
  );
  if (chosen === undefined || chosen === null) {
    return null;
  }
  const url = chosen.url.trim();
  if (!url.startsWith("/")) {
    return { url, alt: chosen.alt };
  }
  const absolute = canonicalUrlFor(definition, url as `/${string}`);
  return absolute === null ? null : { url: absolute, alt: chosen.alt };
}

/**
 * The browser-tab and search-result title for a page below the home page.
 *
 * A blank SEO title falls back to the content's own heading followed by the
 * site name, which is what an owner expects from Yoast or Rank Math. A filled
 * SEO title is used exactly as written, with no suffix added.
 */
function titleWithSiteName(
  definition: SiteDefinition,
  seoTitle: string,
  contentTitle: string,
): string {
  const written = seoTitle.trim();
  if (written !== "") {
    return written;
  }
  const siteName = definition.site.name.trim();
  const heading = firstFilled(contentTitle, siteName);
  return siteName === "" || heading === siteName
    ? heading
    : `${heading} — ${siteName}`;
}

export function resolveHomeSeo(definition: SiteDefinition): ResolvedSeo {
  return {
    title: firstFilled(definition.home.seo.title, definition.site.name),
    description: firstFilled(
      definition.home.seo.description,
      definition.site.description,
    ),
    canonicalUrl: canonicalUrlFor(definition, "/"),
    keywords: definition.home.seo.keywords,
    shareImage: resolveShareImage(
      definition,
      definition.home.seo.shareImage,
      homeHeroShareImage(definition),
    ),
  };
}

/**
 * The blog index has no editable metadata of its own. It borrows the site's
 * name, description and share image so its link previews still look right.
 */
export function resolveBlogIndexSeo(definition: SiteDefinition): ResolvedSeo {
  return {
    title: titleWithSiteName(definition, "", "Blog"),
    description: firstFilled(definition.site.description),
    canonicalUrl: canonicalUrlFor(definition, "/blog"),
    keywords: [],
    shareImage: resolveShareImage(
      definition,
      definition.home.seo.shareImage,
      homeHeroShareImage(definition),
    ),
  };
}

export function resolveBlogPostSeo(
  definition: SiteDefinition,
  post: BlogPost,
): ResolvedSeo {
  return {
    title: titleWithSiteName(definition, post.seo.title, post.title),
    description: firstFilled(
      post.seo.description,
      post.excerpt,
      definition.site.description,
    ),
    canonicalUrl: canonicalUrlFor(definition, `/blog/${post.slug}`),
    keywords: post.seo.keywords,
    shareImage: resolveShareImage(
      definition,
      post.seo.shareImage,
      definition.home.seo.shareImage,
      homeHeroShareImage(definition),
    ),
  };
}
