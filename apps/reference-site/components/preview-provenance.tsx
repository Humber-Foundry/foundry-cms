import type { RevisionPreview } from "@/src/revision-preview-page";

/** One line per changed page, so long page names stay readable. */
function ReviewLines({ lines }: { lines: ReadonlyArray<string> }) {
  if (lines.length === 0) return <>Nothing</>;
  return (
    <ul>
      {lines.map((line, index) => (
        <li key={`${index}-${line}`}>{line}</li>
      ))}
    </ul>
  );
}

/**
 * The provenance panel every preview route shows: which exact revision this
 * is, its content, schema and renderer identity, the MCP review summary when
 * the revision came from an agent draft, and the link back to the editor.
 *
 * The home page preview, a page preview and a blog post preview all show
 * this same panel, so moving between pages inside a preview (#156) never
 * changes what a reviewer is told about the revision they are looking at.
 */
export function PreviewProvenance({
  revision,
  heading = "Exact saved preview",
}: {
  revision: RevisionPreview;
  heading?: string;
}) {
  return (
    <aside className="preview-provenance" aria-label="Preview provenance">
      <div>
        <strong>
          {heading} · revision {revision.revision}
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
      {revision.mcpReview === undefined ? null : (
        <dl className="preview-review">
          <div>
            <dt>MCP actor</dt>
            <dd>{revision.mcpReview.actorId}</dd>
          </div>
          <div>
            <dt>Changed content</dt>
            <dd>
              <ReviewLines lines={revision.mcpReview.changedDocuments} />
            </dd>
          </div>
          <div>
            <dt>Design changes</dt>
            <dd>
              <ReviewLines lines={revision.mcpReview.designChanges} />
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
  );
}
