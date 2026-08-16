import { ContentWorkspaceStarter } from "@/components/content-workspace-starter";
import { DashboardControls } from "@/components/dashboard-controls";
import { OverviewDestinations } from "@/components/overview-destinations";
import { loadMessagesAttention } from "@/src/public-form-messages-runtime";
import {
  loadDashboardWorkspace,
  loadMutationToken,
  loadPublishedDefinition,
  readWorkspaceSearchParams,
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
  const dashboardWorkspace = await loadDashboardWorkspace(workspace, "/dash");
  const mutationToken = await loadMutationToken();
  const messages = await loadMessagesAttention(access);

  const hasDraft = dashboardWorkspace.contentRevision !== undefined;
  const needsFreshWorkspace =
    dashboardWorkspace.schemaRecovery !== undefined ||
    dashboardWorkspace.contentStale === true;

  return (
    <main className="dashboard-main" id="main">
      <div className="page-heading">
        <div>
          <h1>{definition.site.name}</h1>
          <p>{definition.site.description}</p>
        </div>
        <DashboardControls siteId={definition.site.id} />
      </div>

      {hasDraft && !needsFreshWorkspace ? (
        <section className="panel" aria-labelledby="draft-state">
          <h2 id="draft-state">Your draft</h2>
          <p>
            You have unpublished changes saved as revision{" "}
            {dashboardWorkspace.contentRevision?.revision}. Open Pages to keep
            editing, or publish when you are happy with the preview.
          </p>
          <p className="panel-actions">
            <a
              className="button button-primary"
              href={`/dash/pages?workspace=${encodeURIComponent(
                dashboardWorkspace.workspaceId,
              )}`}
            >
              Continue editing
            </a>
          </p>
        </section>
      ) : (
        <ContentWorkspaceStarter
          csrfToken={mutationToken}
          staleRecovery={staleRecovery}
          preservedRevision={
            needsFreshWorkspace && dashboardWorkspace.contentRevision
              ? {
                  workspaceId: dashboardWorkspace.contentRevision.workspaceId,
                  revision: dashboardWorkspace.contentRevision.revision,
                  schemaVersion:
                    dashboardWorkspace.contentRevision.inputs.schemaVersion,
                }
              : undefined
          }
          durableRecoveryEdits={dashboardWorkspace.schemaRecovery}
        />
      )}

      <section aria-labelledby="attention">
        <h2 id="attention">Needs attention</h2>
        {messages.unreadCount === 0 && messages.heldForReview === 0 ? (
          <p className="empty-state">
            Nothing is waiting for you. New messages, and anything held as
            spam, appear here.
          </p>
        ) : (
          <ul className="attention-list">
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

      <OverviewDestinations
        role={access.membership.role}
        workspaceId={dashboardWorkspace.workspaceId}
      />
    </main>
  );
}
