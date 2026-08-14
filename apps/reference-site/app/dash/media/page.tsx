import { MediaManager } from "@/components/media-manager";
import { mergeMediaOccurrenceState } from "@/components/media-manager-state";
import {
  loadDashboardWorkspace,
  loadMutationToken,
  readWorkspaceSearchParams,
} from "@/src/dashboard-page-context";

export const dynamic = "force-dynamic";

/**
 * Photos is the media library: upload a picture, replace the one used in a
 * particular place, and crop without changing the original file.
 */
export default async function DashboardMediaPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspace } = await readWorkspaceSearchParams(searchParams);
  const dashboardWorkspace = await loadDashboardWorkspace(
    workspace,
    "/dash/media",
  );
  const mutationToken = await loadMutationToken();

  const occurrences = mergeMediaOccurrenceState(
    [],
    dashboardWorkspace.contentRevision?.definition.home.media ?? [],
  );

  return (
    <main className="dashboard-main" id="main">
      <div className="page-heading">
        <div>
          <h1>Photos</h1>
          <p>Upload pictures and choose where they appear.</p>
        </div>
      </div>
      <MediaManager
        csrfToken={mutationToken}
        workspaceId={dashboardWorkspace.workspaceId}
        initialAssets={[]}
        initialOccurrences={occurrences}
        contentRevision={dashboardWorkspace.contentRevision}
        contentStale={dashboardWorkspace.contentStale}
      />
    </main>
  );
}
