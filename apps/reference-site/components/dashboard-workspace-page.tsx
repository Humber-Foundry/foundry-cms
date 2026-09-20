import { ContentDraftRecovery } from "./content-draft-recovery";
import { PagesList } from "./pages-list";
import { WorkspaceEditorSurface } from "./workspace-editor-surface";
import {
  loadDashboardWorkspace,
  loadMutationToken,
  loadPublishedDefinition,
  preservedRevisionOf,
  readWorkspaceSearchParams,
  recoveryReasonOf,
} from "@/src/dashboard-page-context";
import { formatDashboardMoment } from "@/src/dashboard-time";
import {
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
    staleRecovery,
  );
  const mutationToken = await loadMutationToken();
  const { contentRevision, previewUrl, schemaRecovery } = dashboardWorkspace;
  // The draft workspace always exists, so nothing interrupts a first visit.
  // Only an older-schema draft sends the owner to the recovery screen here.
  // A draft that is merely behind the published site stays editable: the
  // editor below reports that state and offers its own way forward, which
  // Overview and Blog do not have.
  const showStarter = schemaRecovery !== undefined;
  // Every photo the site already shows, so the canvas photo picker lists
  // existing photos, not only uploaded ones.
  const publishedDefinition = showStarter
    ? undefined
    : await loadPublishedDefinition();
  const siteImages = showStarter
    ? []
    : siteStaticImageTiles(publishedDefinition, contentRevision.definition);
  // Pages opens on the list of pages. Naming a page in the address opens that
  // page in the editor, so the address can be shared and reloaded. An address
  // naming a page the draft no longer holds comes back to the list and says
  // so, rather than opening a different page without a word.
  const selection = showStarter
    ? undefined
    : resolveEditorPage(contentRevision.definition, requestedPageId);
  const showPagesList =
    destination === "pages" &&
    selection !== undefined &&
    (requestedPageId === undefined || selection.wasNotFound);

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
        <ContentDraftRecovery
          csrfToken={mutationToken}
          staleRecovery={staleRecovery}
          preservedRevision={preservedRevisionOf(contentRevision)}
          durableRecoveryEdits={schemaRecovery}
          reason={recoveryReasonOf(dashboardWorkspace)}
        />
      ) : showPagesList ? (
        <PagesList
          pages={listEditorPages(contentRevision.definition, publishedDefinition)}
          workspaceUrl={dashboardWorkspace.activeWorkspaceUrl}
          lastSaved={formatDashboardMoment(contentRevision.createdAt)}
          askedForMissingPage={selection.wasNotFound}
        />
      ) : (
        <WorkspaceEditorSurface
          variant={destination}
          csrfToken={mutationToken}
          contentRevision={contentRevision}
          // Design edits the whole site, so it names no page and shows no
          // page switcher.
          selectedPageId={
            destination === "pages"
              ? selection?.page.id
              : undefined
          }
          pages={
            destination === "pages"
              ? listEditorPages(contentRevision.definition)
              : []
          }
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
