import type { Metadata } from "next";

import { resolveHomeSeo } from "@humber-foundry/site-definition";

import { SiteRenderer } from "@/components/site-renderer";
import { publicMetadata } from "@/src/public-metadata";
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
    ...publicMetadata(resolveHomeSeo(revision.definition), {
      siteName: revision.definition.site.name,
      kind: "website",
    }),
  };
}

export default async function RevisionPreviewPage(
  props: RevisionPreviewPageProps,
) {
  const revision = await loadRevisionPreview(props);
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
        {revision.mcpReview === undefined ? null : (
          <dl>
            <div>
              <dt>MCP actor</dt>
              <dd>{revision.mcpReview.actorId}</dd>
            </div>
            <div>
              <dt>Changed content</dt>
              <dd>
                {revision.mcpReview.changedDocuments.join(", ") || "None"}
              </dd>
            </div>
            <div>
              <dt>Design changes</dt>
              <dd>
                {revision.mcpReview.designChanges.join(", ") || "None"}
              </dd>
            </div>
            <div>
              <dt>Public effect</dt>
              <dd>{revision.mcpReview.publicEffect}</dd>
            </div>
          </dl>
        )}
        <a
          href={`/dash/pages?workspace=${encodeURIComponent(revision.workspaceId)}`}
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
        homeHref={previewHomeHref}
        blogHref={`${previewHomeHref}#blog_index_title`}
        blogPostHref={(slug) =>
          previewPath +
          `/blog/${encodeURIComponent(slug)}?${previewQuery.toString()}`
        }
      />
    </>
  );
}
