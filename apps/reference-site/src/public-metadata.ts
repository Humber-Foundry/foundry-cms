import type { Metadata } from "next";

import type { ResolvedSeo } from "@humber-foundry/site-definition";

export type PublicMetadataOptions = Readonly<{
  siteName: string;
  /**
   * `article` for one blog post, `website` for everything else. Open Graph
   * uses it to decide how a link preview is laid out.
   */
  kind: "article" | "website";
}>;

/**
 * Turn one route's resolved SEO values into the Next.js metadata that becomes
 * the page's `<title>`, description, canonical link, and Open Graph and
 * Twitter tags.
 *
 * This function adds no fallbacks of its own. Every blank has already been
 * filled by `resolve*Seo` in the site-definition package, so the same values
 * reach the page head, the link preview and any future channel.
 */
export function publicMetadata(
  seo: ResolvedSeo,
  { siteName, kind }: PublicMetadataOptions,
): Metadata {
  const images =
    seo.shareImage === null
      ? undefined
      : [{ url: seo.shareImage.url, alt: seo.shareImage.alt }];

  return {
    title: seo.title,
    description: seo.description,
    ...(seo.keywords.length === 0 ? {} : { keywords: [...seo.keywords] }),
    ...(seo.canonicalUrl === null
      ? {}
      : {
          // Next resolves any relative metadata address against this base.
          // Every address here is already absolute, so the base only keeps
          // Next from warning and guessing a localhost origin.
          metadataBase: new URL(new URL(seo.canonicalUrl).origin),
          alternates: { canonical: seo.canonicalUrl },
        }),
    openGraph: {
      type: kind,
      siteName,
      title: seo.title,
      description: seo.description,
      ...(seo.canonicalUrl === null ? {} : { url: seo.canonicalUrl }),
      ...(images === undefined ? {} : { images }),
    },
    twitter: {
      card: images === undefined ? "summary" : "summary_large_image",
      title: seo.title,
      description: seo.description,
      ...(images === undefined ? {} : { images }),
    },
  };
}
