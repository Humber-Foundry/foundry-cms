import { PageLifecycleList } from "./page-lifecycle-controls";
import type { PageActionSummary } from "@/src/page-lifecycle-view";

/**
 * Every page of the draft, as a list the owner can open and act on.
 *
 * This is what Pages shows first. Selecting a row opens that page in the same
 * editor, addressed with `?page=<id>`, so the address can be shared and
 * reloaded. The rows and the New page, Rename, Duplicate and Delete controls
 * are drawn by `PageLifecycleList`, because they need the browser; everything
 * around them is worked out on the server.
 */
export function PagesList({
  pages,
  workspaceUrl,
  workspaceId,
  schemaVersion,
  baseRevision,
  csrfToken,
  lastSaved,
  askedForMissingPage,
}: {
  pages: ReadonlyArray<PageActionSummary>;
  /** The Pages address with the workspace it already carries. */
  workspaceUrl: string;
  workspaceId: string;
  schemaVersion: string;
  /** The revision every page operation on this screen is measured against. */
  baseRevision: number;
  csrfToken: string;
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
      <PageLifecycleList
        pages={pages}
        workspaceUrl={workspaceUrl}
        workspaceId={workspaceId}
        schemaVersion={schemaVersion}
        baseRevision={baseRevision}
        csrfToken={csrfToken}
      />
      {lastSaved === undefined ? null : (
        <p className="pages-list-saved">
          You last saved this draft on {lastSaved}.
        </p>
      )}
    </section>
  );
}
