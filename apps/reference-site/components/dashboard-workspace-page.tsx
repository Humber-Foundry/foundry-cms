import { ContentWorkspaceStarter } from "./content-workspace-starter";
import { WorkspaceEditorSurface } from "./workspace-editor-surface";
import {
  loadDashboardWorkspace,
  loadMutationToken,
  readWorkspaceSearchParams,
} from "@/src/dashboard-page-context";

const workspaceDestinations = {
  pages: {
    route: "/dash/pages",
    title: "Pages",
    description: "Edit the words and sections on your site.",
    headingOnlyWhenStarting: true,
  },
  design: {
    route: "/dash/design",
    title: "Design",
    description:
      "Pick a look for your site, then change its fonts, colours, spacing and width. Every choice shows in the preview beside the controls, and nothing reaches the live site until you publish.",
    headingOnlyWhenStarting: false,
  },
} as const;

export async function DashboardWorkspacePage({
  destination,
  searchParams,
}: {
  destination: keyof typeof workspaceDestinations;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const config = workspaceDestinations[destination];
  const { workspace, staleRecovery } =
    await readWorkspaceSearchParams(searchParams);
  const dashboardWorkspace = await loadDashboardWorkspace(
    workspace,
    config.route,
  );
  const mutationToken = await loadMutationToken();
  const { contentRevision, previewUrl, schemaRecovery } = dashboardWorkspace;
  const needsFreshWorkspace =
    schemaRecovery !== undefined || contentRevision === undefined;
  const showStarter = needsFreshWorkspace || previewUrl === undefined;

  return (
    <main className="dashboard-main" id="main">
      {!config.headingOnlyWhenStarting || showStarter ? (
        <div className="page-heading">
          <div>
            <h1>{config.title}</h1>
            <p>{config.description}</p>
          </div>
        </div>
      ) : null}
      {showStarter ? (
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
          variant={destination}
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
