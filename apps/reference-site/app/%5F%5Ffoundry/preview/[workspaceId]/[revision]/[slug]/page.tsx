import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { PreviewProvenance } from "@/components/preview-provenance";
import { SiteRenderer } from "@/components/site-renderer";
import { findPublicPage, pageRouteMetadata } from "@/src/public-page";
import {
  buildRevisionPreviewLinks,
  loadRevisionPreview,
} from "@/src/revision-preview-page";

import "../../../../../public.css";
import "../preview.css";

export const dynamic = "force-dynamic";

type SitePagePreviewProps = {
  params: Promise<{
    workspaceId: string;
    revision: string;
    slug: string;
  }>;
  searchParams: Promise<{
    capability?: string | string[];
    bookmark?: string | string[];
    accessToken?: string | string[];
    previewId?: string | string[];
  }>;
};

/**
 * Loads the revision (capability-checked, scoped to one workspace and
 * revision, exactly as the home page preview is) and then looks for `slug`
 * only inside that revision's own page collection. An unknown slug — one
 * that belongs to another workspace, another revision, or no revision at
 * all — is refused the same way an unknown slug is refused on the public
 * site: this route never falls back to a different revision or the live
 * site to find a match. See ADR-0018 (`findPublicPage`) and the preview
 * capability boundary in `preview-capability.ts`.
 */
async function loadPagePreview(props: SitePagePreviewProps) {
  const params = await props.params;
  const revision = await loadRevisionPreview({
    params: Promise.resolve(params),
    searchParams: props.searchParams,
  });
  const page = findPublicPage(revision.definition, params.slug);
  if (page === null) {
    notFound();
  }
  return { revision, page };
}

export async function generateMetadata(
  props: SitePagePreviewProps,
): Promise<Metadata> {
  const { revision, page } = await loadPagePreview(props);
  return {
    robots: { index: false, follow: false },
    ...pageRouteMetadata(revision.definition, page),
  };
}

export default async function SitePagePreviewPage(
  props: SitePagePreviewProps,
) {
  const { revision, page } = await loadPagePreview(props);
  const links = buildRevisionPreviewLinks(revision, await props.searchParams);
  return (
    <>
      <PreviewProvenance revision={revision} />
      <SiteRenderer
        definition={revision.definition}
        page={page}
        mediaDelivery="authenticated"
        mediaAccessToken={links.accessToken}
        homeHref={links.homeHref}
        blogHref={links.blogHref}
        blogPostHref={links.blogPostHref}
        pageHref={links.pageHref}
      />
    </>
  );
}
