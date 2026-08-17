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
  shareImage: SeoShareImage | null;
}>;

function firstFilled(...candidates: ReadonlyArray<string>): string {
  return candidates.find((candidate) => candidate.trim() !== "")?.trim() ?? "";
}

/** The most keywords one piece of content may carry. Matches the schema. */
export const seoKeywordLimit = 12;

/** The longest share image address any surface accepts. Matches the schema. */
export const seoShareImageUrlMaxLength = 2_000;

/**
 * The only share image address a campaign accepts, as a JSON Schema pattern.
 *
 * An email is read outside the site, so a path would resolve against the
 * reader's mail host. This is the one copy: the MCP tool schema advertises it
 * and the campaign renderer enforces it, and a second copy would let the two
 * drift apart.
 */
export const campaignShareImageUrlPattern = "^https://[^\\s/?#]+[^\\s]*$";

/**
 * What the dashboard tells an owner about each SEO field.
 *
 * One copy, read by the field-group editor and by the blog and campaign
 * composers. Two copies of one sentence drift, and then two owners are told
 * two different things about one field.
 *
 * The title and description hints name what the blank field falls back to, so
 * they differ per surface. Everything else is the same wherever it appears.
 */
export const seoFieldHints = {
  keywords: `Separate keywords with commas. Up to ${seoKeywordLimit}.`,
  tooManyKeywords: `Use at most ${seoKeywordLimit} keywords, separated by commas.`,
  shareImageUrl:
    "The picture shown when this link is shared. Leave blank to use the " +
    "site's main image.",
  shareImageAlt: "Describe the picture for people who cannot see it.",
  campaignShareImageUrl:
    "Shown at the top of the email. Use a full https address, because a mail " +
    "app cannot resolve a path on your site.",
  siteAddress:
    "The address this site serves from, such as https://example.com. Leave " +
    "blank and no canonical or share links are published.",
  page: {
    title: "Leave blank to use the site name.",
    description: "Leave blank to use the site description.",
  },
  post: {
    title: "Leave blank to use the post title and the site name.",
    description: "Leave blank to use the post summary.",
  },
} as const;

/**
 * Assemble one share image from the two boxes an owner fills.
 *
 * An address with nothing in it is no picture, whatever the description says,
 * so the pair collapses to `null`. Both composers build the value this way.
 */
export function toSeoShareImage(
  url: string,
  alt: string,
): SeoShareImage | null {
  const address = url.trim();
  return address === "" ? null : { url: address, alt: alt.trim() };
}

/**
 * The canonical origin as it must be stored: no surrounding space, no trailing
 * slash. A trailing slash here would build "https://example.com//blog".
 *
 * This is the one place that rule lives. Every writer and reader of
 * `site.canonicalOrigin` goes through it.
 */
export function normalizeCanonicalOrigin(value: string): string {
  return value.trim().replace(/\/+$/u, "");
}

/**
 * Turn a path on this site into one absolute address.
 *
 * Returns `null` when the installation has not set a canonical origin, because
 * an address pointing at the wrong host is worse than none at all. Also the one
 * place a path is joined to the origin, so canonical URLs and share images
 * cannot drift apart.
 */
export function absoluteSiteUrl(
  canonicalOrigin: string,
  path: `/${string}`,
): string | null {
  const origin = normalizeCanonicalOrigin(canonicalOrigin);
  return origin === "" ? null : `${origin}${path}`;
}

function canonicalUrlFor(
  definition: SiteDefinition,
  path: `/${string}`,
): string | null {
  return absoluteSiteUrl(definition.site.canonicalOrigin, path);
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
 * Resolve one share image candidate to an absolute address, or `null` when it
 * cannot be one. A path needs the site's canonical origin, so a path resolves
 * to nothing when no origin is set. An already-absolute address is kept as
 * written.
 */
function absoluteShareImage(
  definition: SiteDefinition,
  candidate: SeoShareImage | null,
): SeoShareImage | null {
  const url = candidate?.url.trim() ?? "";
  if (url === "") {
    return null;
  }
  if (!url.startsWith("/")) {
    return { url, alt: candidate!.alt };
  }
  const absolute = canonicalUrlFor(definition, url as `/${string}`);
  return absolute === null ? null : { url: absolute, alt: candidate!.alt };
}

/**
 * The first share image that resolves to an absolute address.
 *
 * A candidate that cannot be made absolute is passed over rather than ending
 * the search, so a site with no address set still shows an absolute fallback
 * image behind a post whose own image is a path.
 */
function resolveShareImage(
  definition: SiteDefinition,
  ...candidates: ReadonlyArray<SeoShareImage | null>
): SeoShareImage | null {
  for (const candidate of candidates) {
    const resolved = absoluteShareImage(definition, candidate);
    if (resolved !== null) {
      return resolved;
    }
  }
  return null;
}

/**
 * The title a page below the home page shows when its owner wrote no SEO
 * title: the page's own heading, then the site name. This is what an owner
 * expects from Yoast or Rank Math. A filled SEO title is used exactly as
 * written, with no suffix added, so this is never consulted then.
 */
function headingWithSiteName(
  definition: SiteDefinition,
  heading: string,
): string {
  const siteName = definition.site.name.trim();
  const written = firstFilled(heading, siteName);
  return siteName === "" || written === siteName
    ? written
    : `${written} — ${siteName}`;
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
 * The blog index has no editable metadata of its own, because it is a listing
 * rather than a piece of content an owner writes. It borrows the site's name,
 * description and share image so its link previews still look right.
 */
export function resolveBlogIndexSeo(definition: SiteDefinition): ResolvedSeo {
  return {
    title: headingWithSiteName(definition, "Blog"),
    description: definition.site.description.trim(),
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
    title: firstFilled(
      post.seo.title,
      headingWithSiteName(definition, post.title),
    ),
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
      post.mainImage,
      definition.home.seo.shareImage,
      homeHeroShareImage(definition),
    ),
  };
}

/**
 * The picture a post shows on its own card in a post list — its thumbnail.
 *
 * It is the post's own share image, or its main image when no share image is
 * set, and nothing else: a post with neither shows a text-only card rather
 * than borrowing the site's picture for every post. The address is kept as the
 * owner set it — a media path stays a path — because a card renders on the
 * site, where a path resolves. See ADR-0013.
 */
export function blogPostThumbnail(post: BlogPost): SeoShareImage | null {
  const filled = (image: SeoShareImage | null): SeoShareImage | null =>
    image !== null && image.url.trim() !== "" ? image : null;
  return filled(post.seo.shareImage) ?? filled(post.mainImage);
}
