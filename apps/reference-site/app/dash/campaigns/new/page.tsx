import { campaignListHref } from "@/components/campaign-links";
import { DashboardBackLink } from "@/components/dashboard-back-link";
import { DashboardPageHeader } from "@/components/dashboard-page-header";
import { NewCampaignScreen } from "@/components/new-campaign-screen";
import { campaignEditorMedia } from "@/src/campaign-editor-media";
import {
  loadDashboardWorkspace,
  loadMutationToken,
  loadPublishedDefinition,
  readWorkspaceSearchParams,
  requireAuthorizedDashboardAccess,
} from "@/src/dashboard-page-context";

export const dynamic = "force-dynamic";

/**
 * The writing box for one new email, on its own screen (#237). The back link
 * returns to the campaign list, so this screen is never a dead end.
 */
export default async function NewCampaignPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAuthorizedDashboardAccess();
  const { workspace, staleRecovery } =
    await readWorkspaceSearchParams(searchParams);
  const dashboardWorkspace = await loadDashboardWorkspace(
    workspace,
    "/dash/campaigns/new",
    staleRecovery,
  );
  const definition = await loadPublishedDefinition();
  const mutationToken = await loadMutationToken();

  return (
    <main className="dashboard-main" id="main">
      <DashboardBackLink
        href={campaignListHref(dashboardWorkspace.workspaceId)}
        label="Back to Newsletter"
      />
      <DashboardPageHeader
        title="New email"
        description="Write it here. It stays a private draft until you send a test and approve it."
      />
      <NewCampaignScreen
        csrfToken={mutationToken}
        workspace={dashboardWorkspace.workspaceId}
        media={campaignEditorMedia({
          mutationToken,
          workspaceId: dashboardWorkspace.workspaceId,
          publishedDefinition: definition,
          draftDefinition: dashboardWorkspace.contentRevision.definition,
        })}
      />
    </main>
  );
}
