import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { BlogPostRenderer } from "@/components/blog-post-renderer";
import { PreviewProvenance } from "@/components/preview-provenance";
import {
  blogPostMetadata,
  findBlogPost,
} from "@/src/blog-post-page";
import {
  buildRevisionPreviewLinks,
  loadRevisionPreview,
} from "@/src/revision-preview-page";

import "../../../../../../public.css";
import "../../preview.css";

export const dynamic = "force-dynamic";

type BlogPostPreviewProps = {
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

async function loadPostPreview(props: BlogPostPreviewProps) {
  const params = await props.params;
  const revision = await loadRevisionPreview({
    params: Promise.resolve(params),
    searchParams: props.searchParams,
  });
  const post = findBlogPost(revision.definition, params.slug);
  if (post === null) {
    notFound();
  }
  return { revision, post };
}

export async function generateMetadata(
  props: BlogPostPreviewProps,
): Promise<Metadata> {
  const { revision, post } = await loadPostPreview(props);
  return {
    robots: { index: false, follow: false },
    ...blogPostMetadata(revision.definition, post),
  };
}

export default async function BlogPostPreviewPage(
  props: BlogPostPreviewProps,
) {
  const { revision, post } = await loadPostPreview(props);
  const links = buildRevisionPreviewLinks(revision, await props.searchParams);
  return (
    <>
      <PreviewProvenance
        revision={revision}
        heading="Exact saved post preview"
        showMcpReview={false}
      />
      <BlogPostRenderer
        definition={revision.definition}
        post={post}
        preview
        homeHref={links.homeHref}
        blogHref={links.blogHref}
        mediaDelivery="authenticated"
        mediaAccessToken={links.accessToken}
      />
    </>
  );
}
