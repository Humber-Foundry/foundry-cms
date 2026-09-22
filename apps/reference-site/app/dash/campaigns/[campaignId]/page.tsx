import { headers } from "next/headers";
import { notFound } from "next/navigation";

import {
  AccessDeniedError,
  CampaignNotFoundError,
  createCampaignId,
  type Campaign,
  type CampaignRevision,
} from "@humber-foundry/application";

import { CampaignBackLink } from "@/components/campaign-back-link";
import { CampaignScreen } from "@/components/campaign-screen";
import { loadCampaignRequestContext } from "@/src/campaign-runtime";
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
 * One saved email, on its own screen (#237): how it looks, the four sending
 * steps, and the writing box to change it. The back link returns to the
 * campaign list, so this screen is never a dead end.
 */
export default async function DashboardCampaignPage({
  params,
  searchParams,
}: {
  params: Promise<{ campaignId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await requireAuthorizedDashboardAccess();
  const { campaignId: requestedCampaignId } = await params;
  const { workspace, staleRecovery } =
    await readWorkspaceSearchParams(searchParams);
  const dashboardWorkspace = await loadDashboardWorkspace(
    workspace,
    `/dash/campaigns/${encodeURIComponent(requestedCampaignId)}`,
    staleRecovery,
  );
  const definition = await loadPublishedDefinition();
  const mutationToken = await loadMutationToken();
  const campaignContext = await loadCampaignRequestContext(await headers());

  // An id that is not a campaign id is a dead link, not a fault. It is checked
  // on its own so that a real fault inside the reads below stays visible
  // instead of being answered as a missing page.
  let campaignId: ReturnType<typeof createCampaignId>;
  try {
    campaignId = createCampaignId(requestedCampaignId);
  } catch {
    notFound();
  }

  let campaign: Campaign;
  let revision: CampaignRevision;
  try {
    campaign = await campaignContext.application.queries.getCampaign({
      actor: access.identity,
      campaignId,
    });
    revision = await campaignContext.application.queries.getRevision({
      actor: access.identity,
      campaignId,
      revisionNumber: campaign.version,
    });
  } catch (error) {
    // An email that is gone, and one this person may not read, are the same
    // answer: there is no such page. Naming it would say it exists.
    if (
      error instanceof CampaignNotFoundError ||
      error instanceof AccessDeniedError
    ) {
      notFound();
    }
    throw error;
  }

  return (
    <main className="dashboard-main" id="main">
      <CampaignBackLink workspace={dashboardWorkspace.workspaceId} />
      <div className="page-heading">
        <div>
          <h1>{revision.subject}</h1>
          <p>
            Read it through, send yourself a test, then send it to your
            subscribers.
          </p>
        </div>
      </div>
      <CampaignScreen
        csrfToken={mutationToken}
        // The steps say whose step each one is. The server still decides every
        // command; this only lets the screen explain an Owner-only step to an
        // Editor instead of refusing it after the fact.
        role={access.membership.role}
        initialRevision={revision}
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
