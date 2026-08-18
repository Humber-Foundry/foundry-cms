import { MediaManager } from "@/components/media-manager";
import { mergeMediaOccurrenceState } from "@/components/media-manager-state";
import {
  loadDashboardWorkspace,
  loadMutationToken,
  loadPublishedDefinition,
  readWorkspaceSearchParams,
} from "@/src/dashboard-page-context";
import {
  siteStaticImageTiles,
  siteUsedAssetIds,
} from "@/src/site-used-photos";

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
  const publishedDefinition = await loadPublishedDefinition();
  const draftDefinition = dashboardWorkspace.contentRevision?.definition;

  const occurrences = mergeMediaOccurrenceState(
    [],
    draftDefinition?.home.media ?? [],
  );
  // Every photo the site actually shows — built-in images and the photos placed
  // through the published site or the current draft — so the gallery is "all
  // your photos", not only the uploaded ones.
  const siteImages = siteStaticImageTiles(publishedDefinition, draftDefinition);
  const usedAssetIds = siteUsedAssetIds(publishedDefinition, draftDefinition);

  return (
    <main className="dashboard-main" id="main">
      <div className="page-heading">
        <div>
          <h1>Photos</h1>
          <p>Every photo your site uses, in one place. Upload, review and tidy up.</p>
        </div>
      </div>
      <MediaManager
        csrfToken={mutationToken}
        workspaceId={dashboardWorkspace.workspaceId}
        initialAssets={[]}
        initialOccurrences={occurrences}
        siteImages={siteImages}
        usedAssetIds={usedAssetIds}
        contentRevision={dashboardWorkspace.contentRevision}
        contentStale={dashboardWorkspace.contentStale}
      />
    </main>
  );
}
