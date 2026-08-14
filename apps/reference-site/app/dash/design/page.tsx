import { ContentWorkspaceStarter } from "@/components/content-workspace-starter";
import { WorkspaceEditorSurface } from "@/components/workspace-editor-surface";
import {
  loadDashboardWorkspace,
  loadMutationToken,
  readWorkspaceSearchParams,
} from "@/src/dashboard-page-context";

export const dynamic = "force-dynamic";

/**
 * Design holds the controlled visual primitives — heading typography, accent
 * colour, section spacing and content width. They edit the same revision as
 * Pages, through the same save and publish controls.
 */
export default async function DashboardDesignPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspace, staleRecovery } =
    await readWorkspaceSearchParams(searchParams);
  const dashboardWorkspace = await loadDashboardWorkspace(
    workspace,
    "/dash/design",
  );
  const mutationToken = await loadMutationToken();

  const { contentRevision, previewUrl, schemaRecovery } = dashboardWorkspace;
  const needsFreshWorkspace =
    schemaRecovery !== undefined || contentRevision === undefined;

  return (
    <main className="dashboard-main" id="main">
      <div className="page-heading">
        <div>
          <h1>Design</h1>
          <p>
            Change the fonts, colour and spacing your site uses. These are the
            choices the design allows, so the site stays consistent.
          </p>
        </div>
      </div>
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
          variant="design"
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
