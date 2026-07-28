import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { BlogPostRenderer } from "@/components/blog-post-renderer";
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
  }>;
};

async function loadPostPreview(props: BlogPostPreviewProps) {
  const params = await props.params;
  const revision = await loadRevisionPreview({
    params: Promise.resolve(params),
    searchParams: props.searchParams,
  });
  const post = revision.definition.blog.posts.find(
    (candidate) =>
      candidate.slug === params.slug && candidate.visibility === "public",
  );
  if (post === undefined) {
    notFound();
  }
  return { revision, post };
}

export async function generateMetadata(
  props: BlogPostPreviewProps,
): Promise<Metadata> {
  const { post } = await loadPostPreview(props);
  return {
    robots: { index: false, follow: false },
    title: post.seo.title,
    description: post.seo.description,
  };
}

export default async function BlogPostPreviewPage(
  props: BlogPostPreviewProps,
) {
  const { revision, post } = await loadPostPreview(props);
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
          href={`/dash?workspace=${encodeURIComponent(revision.workspaceId)}`}
        >
          Return to editor
        </a>
      </aside>
      <BlogPostRenderer definition={revision.definition} post={post} />
    </>
  );
}
