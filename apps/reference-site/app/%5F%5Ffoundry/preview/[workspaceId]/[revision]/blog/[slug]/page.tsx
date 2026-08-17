import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { BlogPostRenderer } from "@/components/blog-post-renderer";
import {
  blogPostMetadata,
  findBlogPost,
} from "@/src/blog-post-page";
import { loadRevisionPreview } from "@/src/revision-preview-page";

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
  const { accessToken, capability, bookmark, previewId } =
    await props.searchParams;
  const previewQuery = new URLSearchParams({
    capability: typeof capability === "string" ? capability : "",
    bookmark: typeof bookmark === "string" ? bookmark : "",
    ...(typeof accessToken === "string" ? { accessToken } : {}),
    ...(typeof previewId === "string" ? { previewId } : {}),
  });
  const previewPath =
    `/__foundry/preview/${revision.workspaceId}/${revision.revision}`;
  const previewHomeHref = `${previewPath}?${previewQuery.toString()}`;
  return (
    <>
      <aside className="preview-provenance" aria-label="Preview provenance">
        <div>
          <strong>
            Exact saved post preview · revision {revision.revision}
          </strong>
          <span>Created {revision.createdAt}</span>
        </div>
        <dl>
          <div>
            <dt>Content</dt>
            <dd>{revision.inputs.contentHash}</dd>
          </div>
          <div>
            <dt>Schema</dt>
            <dd>{revision.inputs.schemaVersion}</dd>
          </div>
          <div>
            <dt>Renderer</dt>
            <dd>{revision.inputs.rendererVersion}</dd>
          </div>
          <div>
            <dt>Production base</dt>
            <dd>{revision.inputs.productionBase}</dd>
          </div>
        </dl>
        <a
          href={`/dash/pages?workspace=${encodeURIComponent(revision.workspaceId)}`}
        >
          Return to editor
        </a>
      </aside>
      <BlogPostRenderer
        definition={revision.definition}
        post={post}
        preview
        homeHref={previewHomeHref}
        blogHref={`${previewHomeHref}#blog_index_title`}
        mediaDelivery="authenticated"
        mediaAccessToken={
          typeof accessToken === "string" ? accessToken : undefined
        }
      />
    </>
  );
}
