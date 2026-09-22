import { headers } from "next/headers";
import { notFound } from "next/navigation";

import {
  AccessDeniedError,
  CampaignNotFoundError,
  createCampaignId,
  type Campaign,
  type CampaignRevision,
} from "@humber-foundry/application";

import { campaignListHref } from "@/components/campaign-links";
import { CampaignScreen } from "@/components/campaign-screen";
import { loadCampaignRequestContext } from "@/src/campaign-runtime";
import {
  loadDashboardWorkspace,
  loadMutationToken,
  loadPublishedDefinition,
  readWorkspaceSearchParams,
  requireAuthorizedDashboardAccess,
} from "@/src/dashboard-page-context";
import { siteStaticImageTiles } from "@/src/site-used-photos";

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

  let campaign: Campaign;
  let revision: CampaignRevision;
  try {
    const campaignId = createCampaignId(requestedCampaignId);
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
    // A bad id in the address is a dead link, and an email this person may not
    // read must not be named. Both are the same answer: there is no such page.
    if (
      error instanceof CampaignNotFoundError ||
      error instanceof AccessDeniedError ||
      error instanceof TypeError
    ) {
      notFound();
    }
    throw error;
  }

  return (
    <main className="dashboard-main" id="main">
      <p>
        <a href={campaignListHref(dashboardWorkspace.workspaceId)}>
          ← Back to Newsletter
        </a>
      </p>
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
        media={{
          csrfToken: mutationToken,
          workspaceId: dashboardWorkspace.workspaceId,
          // Only site photos an email can load are offered here. A relative
          // built-in address such as "/logo.svg" cannot be sent in an email
          // (ADR-0014 needs an absolute address), so the picker lists uploads
          // and absolute site photos, never a bare path the owner could not
          // send.
          siteImages: siteStaticImageTiles(
            definition,
            dashboardWorkspace.contentRevision.definition,
          ).filter((image) => image.src.startsWith("https://")),
        }}
      />
    </main>
  );
}
