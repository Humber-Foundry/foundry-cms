import { ContentWorkspaceStarter } from "@/components/content-workspace-starter";
import { DashboardControls } from "@/components/dashboard-controls";
import { OverviewDestinations } from "@/components/overview-destinations";
import { loadPublicFormOperationsDashboard } from "@/src/public-form-delivery-health-runtime";
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
  const formOperations = await loadPublicFormOperationsDashboard(access);

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
        {formOperations.failedDeliveries.length === 0 &&
        formOperations.suspectedSpam.length === 0 ? (
          <p className="empty-state">
            Nothing is waiting for you. Messages that fail to send, and
            submissions held for review, appear here.
          </p>
        ) : (
          <ul className="attention-list">
            {formOperations.failedDeliveries.length > 0 ? (
              <li>
                <a href="/dash/forms">
                  {formOperations.failedDeliveries.length} message
                  {formOperations.failedDeliveries.length === 1 ? "" : "s"} did
                  not reach your inbox
                </a>
              </li>
            ) : null}
            {formOperations.suspectedSpam.length > 0 ? (
              <li>
                <a href="/dash/forms">
                  {formOperations.suspectedSpam.length} submission
                  {formOperations.suspectedSpam.length === 1 ? "" : "s"} held
                  for your review
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
