import { ContentWorkspaceStarter } from "./content-workspace-starter";
import { WorkspaceEditorSurface } from "./workspace-editor-surface";
import {
  loadDashboardWorkspace,
  loadMutationToken,
  loadPublishedDefinition,
  readWorkspaceSearchParams,
} from "@/src/dashboard-page-context";
import { siteStaticImageTiles } from "@/src/site-used-photos";

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
  // The draft workspace always exists, so the only reason to interrupt editing
  // is a draft that was written for an older version of the site.
  const showStarter = schemaRecovery !== undefined;
  // Every photo the site already shows, so the canvas photo picker lists
  // existing photos, not only uploaded ones.
  const publishedDefinition = showStarter
    ? undefined
    : await loadPublishedDefinition();
  const siteImages = showStarter
    ? []
    : siteStaticImageTiles(publishedDefinition, contentRevision.definition);

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
          preservedRevision={{
            workspaceId: contentRevision.workspaceId,
            revision: contentRevision.revision,
            schemaVersion: contentRevision.inputs.schemaVersion,
          }}
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
          siteImages={siteImages}
        />
      )}
    </main>
  );
}
