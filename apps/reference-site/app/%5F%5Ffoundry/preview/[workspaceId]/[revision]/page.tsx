import type { Metadata } from "next";

import { SiteRenderer } from "@/components/site-renderer";
import {
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
    title: revision.definition.home.seo.title,
    description: revision.definition.home.seo.description,
  };
}

export default async function RevisionPreviewPage(
  props: RevisionPreviewPageProps,
) {
  const revision = await loadRevisionPreview(props);
  const { accessToken, capability, bookmark } = await props.searchParams;
  const previewQuery = new URLSearchParams({
    capability: typeof capability === "string" ? capability : "",
    bookmark: typeof bookmark === "string" ? bookmark : "",
    ...(typeof accessToken === "string" ? { accessToken } : {}),
  });
  return (
    <>
      <aside className="preview-provenance" aria-label="Preview provenance">
        <div>
          <strong>Exact saved preview · revision {revision.revision}</strong>
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
      <SiteRenderer
        definition={revision.definition}
        mediaDelivery="authenticated"
        mediaAccessToken={
          typeof accessToken === "string" ? accessToken : undefined
        }
        blogPostHref={(slug) =>
          `/__foundry/preview/${revision.workspaceId}/${revision.revision}` +
          `/blog/${encodeURIComponent(slug)}?${previewQuery.toString()}`
        }
      />
    </>
  );
}
