import { ContentWorkspaceStarter } from "./content-workspace-starter";
import { PagesList } from "./pages-list";
import { WorkspaceEditorSurface } from "./workspace-editor-surface";
import {
  loadDashboardWorkspace,
  loadMutationToken,
  loadPublishedDefinition,
  readWorkspaceSearchParams,
} from "@/src/dashboard-page-context";
import { formatDashboardMoment } from "@/src/dashboard-time";
import {
  editorPageWasNotFound,
  listEditorPages,
  readEditorPageId,
  resolveEditorPage,
} from "@/src/editor-page-selection";
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
  const requestedPageId = readEditorPageId(await searchParams);
  const dashboardWorkspace = await loadDashboardWorkspace(
    workspace,
    config.route,
  );
  const mutationToken = await loadMutationToken();
  const { contentRevision, previewUrl, schemaRecovery } = dashboardWorkspace;
  const needsFreshWorkspace =
    schemaRecovery !== undefined || contentRevision === undefined;
  const showStarter = needsFreshWorkspace || previewUrl === undefined;
  // Every photo the site already shows, so the canvas photo picker lists
  // existing photos, not only uploaded ones.
  const publishedDefinition = showStarter
    ? undefined
    : await loadPublishedDefinition();
  const siteImages = showStarter
    ? []
    : siteStaticImageTiles(publishedDefinition, contentRevision?.definition);
  // Pages opens on the list of pages. Naming a page in the address opens that
  // page in the editor, so the address can be shared and reloaded. An address
  // naming a page the draft no longer holds comes back to the list and says
  // so, rather than opening a different page without a word.
  const pageWasNotFound =
    !showStarter &&
    editorPageWasNotFound(contentRevision.definition, requestedPageId);
  const showPagesList =
    destination === "pages" &&
    !showStarter &&
    (requestedPageId === undefined || pageWasNotFound);

  return (
    <main className="dashboard-main" id="main">
      {!config.headingOnlyWhenStarting || showStarter || showPagesList ? (
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
      ) : showPagesList ? (
        <PagesList
          pages={listEditorPages(contentRevision.definition, publishedDefinition)}
          workspaceUrl={dashboardWorkspace.activeWorkspaceUrl}
          lastSaved={formatDashboardMoment(contentRevision.createdAt)}
          notFoundPageAsked={pageWasNotFound}
        />
      ) : (
        <WorkspaceEditorSurface
          variant={destination}
          csrfToken={mutationToken}
          contentRevision={contentRevision}
          selectedPageId={resolveEditorPage(
            contentRevision.definition,
            requestedPageId,
          ).id}
          pages={listEditorPages(contentRevision.definition)}
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
