import type {
  ContentChangeSummary,
  ContentRevisionInputs,
  ContentWorkspaceId,
} from "@humber-foundry/application";

/**
 * Everything `PreviewProvenance` reads off a revision — no more. A page
 * preview, a blog post preview and the home preview each load a fuller
 * revision object; this is the narrow slice this panel actually needs, so
 * it can be tested and reused without building a full revision fixture.
 */
export type PreviewProvenanceRevision = Readonly<{
  workspaceId: ContentWorkspaceId;
  revision: number;
  createdAt: string;
  inputs: ContentRevisionInputs;
  mcpReview?: ContentChangeSummary &
    Readonly<{ previewId: string; actorId: string }>;
}>;

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
  showMcpReview = true,
}: {
  revision: PreviewProvenanceRevision;
  heading?: string;
  /**
   * Whether to show the MCP review summary when the revision came from an
   * agent draft. The blog post preview route sets this to `false`: it never
   * showed this block before #156, and #156's job is a page preview route,
   * not a change to what the blog post preview already showed.
   */
  showMcpReview?: boolean;
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
      {!showMcpReview || revision.mcpReview === undefined ? null : (
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
