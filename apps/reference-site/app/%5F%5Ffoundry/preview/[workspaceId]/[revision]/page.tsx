import type { Metadata } from "next";

import { homePage } from "@humber-foundry/site-definition";

import { PreviewProvenance } from "@/components/preview-provenance";
import { SiteRenderer } from "@/components/site-renderer";
import { pageRouteMetadata } from "@/src/public-page";
import {
  buildRevisionPreviewLinks,
  loadRevisionPreview,
  type RevisionPreviewPageProps,
} from "@/src/revision-preview-page";

import "../../../../public.css";
import "./preview.css";

export const dynamic = "force-dynamic";

export async function generateMetadata(
  props: RevisionPreviewPageProps,
): Promise<Metadata> {
  const revision = await loadRevisionPreview(props);
  return {
    robots: { index: false, follow: false },
    ...pageRouteMetadata(revision.definition, homePage(revision.definition)),
  };
}

export default async function RevisionPreviewPage(
  props: RevisionPreviewPageProps,
) {
  const revision = await loadRevisionPreview(props);
  const links = buildRevisionPreviewLinks(revision, await props.searchParams);
  return (
    <>
      <PreviewProvenance revision={revision} />
      <SiteRenderer
        definition={revision.definition}
        page={homePage(revision.definition)}
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
