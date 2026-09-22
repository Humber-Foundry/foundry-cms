import { MediaManager } from "@/components/media-manager";
import {
  loadDashboardWorkspace,
  loadMutationToken,
  loadPublishedDefinition,
  readWorkspaceSearchParams,
} from "@/src/dashboard-page-context";
import {
  siteStaticImageTiles,
  sitePhotoUsage,
  siteUsedAssetIds,
} from "@/src/site-used-photos";

export const dynamic = "force-dynamic";

/**
 * Photos is the photo library: upload a picture, look at it, see where it is
 * used, and delete one that is used nowhere. Putting a photo on a page happens
 * in the page editor, at the photo itself. See ADR-0043.
 */
export default async function DashboardMediaPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspace, staleRecovery } =
    await readWorkspaceSearchParams(searchParams);
  const dashboardWorkspace = await loadDashboardWorkspace(
    workspace,
    "/dash/media",
    staleRecovery,
  );
  const mutationToken = await loadMutationToken();
  const publishedDefinition = await loadPublishedDefinition();
  const draftDefinition = dashboardWorkspace.contentRevision.definition;

  // Every photo the site actually shows — built-in images and the photos placed
  // through the published site or the current draft — so the gallery is "all
  // your photos", not only the uploaded ones.
  const siteImages = siteStaticImageTiles(publishedDefinition, draftDefinition);
  const usedAssetIds = siteUsedAssetIds(publishedDefinition, draftDefinition);
  // Every page counts, not only the home page, so a photo placed on any page
  // names that page here.
  const usage = sitePhotoUsage(publishedDefinition, draftDefinition);

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
        siteImages={siteImages}
        usage={usage}
        usedAssetIds={usedAssetIds}
      />
    </main>
  );
}
