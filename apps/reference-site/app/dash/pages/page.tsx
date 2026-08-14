import { ContentWorkspaceStarter } from "@/components/content-workspace-starter";
import { WorkspaceEditorSurface } from "@/components/workspace-editor-surface";
import {
  loadDashboardWorkspace,
  loadMutationToken,
  readWorkspaceSearchParams,
} from "@/src/dashboard-page-context";

export const dynamic = "force-dynamic";

/**
 * Pages is the main editing job: change the words on the site, and add, move,
 * duplicate or remove sections on the rendered page.
 */
export default async function DashboardPagesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspace, staleRecovery } =
    await readWorkspaceSearchParams(searchParams);
  const dashboardWorkspace = await loadDashboardWorkspace(
    workspace,
    "/dash/pages",
  );
  const mutationToken = await loadMutationToken();

  const { contentRevision, previewUrl, schemaRecovery } = dashboardWorkspace;
  const needsFreshWorkspace =
    schemaRecovery !== undefined || contentRevision === undefined;

  return (
    <main className="dashboard-main" id="main">
      {/* The editor takes the whole window and carries its own heading; the
        * page heading renders only around the start-a-draft state. */}
      {needsFreshWorkspace || previewUrl === undefined ? (
        <div className="page-heading">
          <div>
            <h1>Pages</h1>
            <p>Edit the words and sections on your site.</p>
          </div>
        </div>
      ) : null}
      {needsFreshWorkspace || previewUrl === undefined ? (
        <ContentWorkspaceStarter
          csrfToken={mutationToken}
          staleRecovery={staleRecovery}
          preservedRevision={
            contentRevision && schemaRecovery
              ? {
                  workspaceId: contentRevision.workspaceId,
                  revision: contentRevision.revision,
                  schemaVersion: contentRevision.inputs.schemaVersion,
                }
              : undefined
          }
          durableRecoveryEdits={schemaRecovery}
        />
      ) : (
        <WorkspaceEditorSurface
          variant="pages"
          csrfToken={mutationToken}
          contentRevision={contentRevision}
          initialPreviewUrl={previewUrl}
          initialContentStale={dashboardWorkspace.contentStale}
          activeWorkspaceUrl={dashboardWorkspace.activeWorkspaceUrl}
          staleRecovery={staleRecovery}
        />
      )}
    </main>
  );
}
