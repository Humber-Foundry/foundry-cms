import { ContentDraftRecovery } from "@/components/content-draft-recovery";
import { loadMessagesAttention } from "@/src/public-form-messages-runtime";
import {
  loadPreviewsWaitingForReview,
  unnamedConnectedApp,
} from "@/src/mcp-preview-review-runtime";
import {
  loadDashboardWorkspace,
  loadMutationToken,
  loadPublishedDefinition,
  preservedRevisionOf,
  readWorkspaceSearchParams,
  recoveryReasonOf,
  requireAuthorizedDashboardAccess,
} from "@/src/dashboard-page-context";

export const dynamic = "force-dynamic";

/**
 * Overview answers one question: what should I do next? It shows the state of
 * the draft, anything waiting for attention, and a way into each job. The
 * editing surfaces themselves live on their own destinations.
 */
export default async function DashboardOverviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await requireAuthorizedDashboardAccess();
  const definition = await loadPublishedDefinition();
  const { workspace, staleRecovery } =
    await readWorkspaceSearchParams(searchParams);
  const dashboardWorkspace = await loadDashboardWorkspace(
    workspace,
    "/dash",
    staleRecovery,
  );
  const mutationToken = await loadMutationToken();
  const messages = await loadMessagesAttention(access);
  const previewsToReview = await loadPreviewsWaitingForReview({
    siteId: access.membership.siteId,
  });

  // The draft workspace always exists, so Overview reports the draft. It only
  // offers a fresh start when this draft can no longer accept changes.
  const { contentRevision } = dashboardWorkspace;
  const needsFreshWorkspace =
    dashboardWorkspace.schemaRecovery !== undefined ||
    dashboardWorkspace.contentStale;

  return (
    <main className="dashboard-main" id="main">
      <div className="page-heading">
        <div>
          <h1>{definition.site.name}</h1>
          <p>{definition.site.description}</p>
        </div>
      </div>

      {needsFreshWorkspace ? (
        <ContentDraftRecovery
          csrfToken={mutationToken}
          staleRecovery={staleRecovery}
          preservedRevision={preservedRevisionOf(contentRevision)}
          durableRecoveryEdits={dashboardWorkspace.schemaRecovery}
          reason={recoveryReasonOf(dashboardWorkspace)}
        />
      ) : (
        <section className="panel" aria-labelledby="draft-state">
          <h2 id="draft-state">Your draft</h2>
          {contentRevision.revision === 0 ? (
            <p>
              Your draft is ready and matches your live site. Open Pages to
              start changing it. Nothing you change reaches the live site until
              you publish.
            </p>
          ) : (
            <p>
              You have unpublished changes. Open Pages to keep editing, or
              publish when you are happy with the preview.
            </p>
          )}
          <p className="panel-actions">
            <a
              className="button button-primary"
              href={`/dash/pages?workspace=${encodeURIComponent(
                dashboardWorkspace.workspaceId,
              )}`}
            >
              {contentRevision.revision === 0
                ? "Start editing"
                : "Continue editing"}
            </a>
          </p>
        </section>
      )}

      <section aria-labelledby="attention">
        <h2 id="attention">Needs attention</h2>
        {messages.unreadCount === 0 &&
        messages.heldForReview === 0 &&
        previewsToReview.length === 0 ? (
          <p className="empty-state">
            Nothing is waiting for you. New messages, anything held as spam,
            and drafts an app prepared for you appear here.
          </p>
        ) : (
          <ul className="attention-list">
            {previewsToReview.map((preview) => (
              <li key={preview.previewId}>
                <a
                  href={`/dash/review/${encodeURIComponent(preview.previewId)}`}
                >
                  {preview.agentName === unnamedConnectedApp
                    ? "A draft waiting for your review"
                    : `A draft from ${preview.agentName} waiting for your review`}
                </a>
              </li>
            ))}
            {messages.unreadCount > 0 ? (
              <li>
                <a href="/dash/forms">
                  {messages.unreadCount} message
                  {messages.unreadCount === 1 ? "" : "s"} you have not read
                </a>
              </li>
            ) : null}
            {messages.heldForReview > 0 ? (
              <li>
                <a href="/dash/forms">
                  {messages.heldForReview} message
                  {messages.heldForReview === 1 ? "" : "s"} held as spam
                </a>
              </li>
            ) : null}
          </ul>
        )}
      </section>
    </main>
  );
}
