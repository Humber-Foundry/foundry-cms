import {
  editorPageHref,
  editorPagePublishedStateLabels,
  type EditorPageSummary,
} from "@/src/editor-page-selection";

/**
 * Every page of the draft, as a list the owner can open.
 *
 * This is what Pages shows first. Selecting a row opens that page in the same
 * editor, addressed with `?page=<id>`, so the address can be shared and
 * reloaded.
 */
export function PagesList({
  pages,
  workspaceUrl,
  lastSaved,
  askedForMissingPage,
}: {
  pages: ReadonlyArray<EditorPageSummary>;
  /** The Pages address with the workspace it already carries. */
  workspaceUrl: string;
  /**
   * When the draft was last saved, already written for a reader. This is one
   * time for the whole draft: a save writes every page together, so the CMS
   * holds no separate time for one page.
   */
  lastSaved?: string;
  /** `true` when the address asked for a page this draft no longer holds. */
  askedForMissingPage?: boolean;
}) {
  return (
    <section className="pages-list" aria-label="Your pages">
      {askedForMissingPage ? (
        <p className="dashboard-note" role="status">
          That page is not in this draft any more. Here are the pages it has.
        </p>
      ) : null}
      <ul className="pages-list-rows">
        {pages.map((page) => (
          <li key={page.id}>
            <a
              className="pages-list-row"
              href={editorPageHref(workspaceUrl, page.id)}
            >
              <span className="pages-list-title">
                {page.title}
                {page.isHome ? (
                  <span className="pages-list-home">Home page</span>
                ) : null}
              </span>
              <span className="pages-list-address">{page.path}</span>
              <span className="pages-list-state">
                {editorPagePublishedStateLabels[page.publishedState]}
              </span>
            </a>
          </li>
        ))}
      </ul>
      {lastSaved === undefined ? null : (
        <p className="pages-list-saved">
          You last saved this draft on {lastSaved}.
        </p>
      )}
    </section>
  );
}
