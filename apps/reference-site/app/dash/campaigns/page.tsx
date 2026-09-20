import { headers } from "next/headers";

import { createBlogPostArtifactFingerprints } from "@humber-foundry/application";

import { CampaignControls } from "@/components/campaign-controls";
import { loadCampaignRequestContext } from "@/src/campaign-runtime";
import { loadPendingCampaignScheduleRequests } from "@/src/campaign-schedule-request-runtime";
import { mcpScheduleRequestAgentName } from "@/src/mcp-schedule-request-agent";
import { loadHumanAccessEnvironment } from "@/src/human-access-environment";
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
 * Newsletter is where campaigns are written, tested and scheduled. A campaign
 * can stand alone or start from a blog post; either way Foundry renders and
 * fingerprints the exact email that gets sent.
 */
/**
 * Every pending send-time request, with the plain name of the app that asked.
 * A request a person made directly is left out, exactly as Overview and the
 * Blog list leave one out. An unreadable request store answers with an empty
 * list rather than stopping the page.
 */
async function loadNamedScheduleRequests() {
  try {
    const environment = await loadHumanAccessEnvironment();
    const requests = await loadPendingCampaignScheduleRequests();
    const named = await Promise.all(
      requests.map(async (request) => {
        const agentName = await mcpScheduleRequestAgentName(
          environment,
          request.createdBy,
        );
        return agentName === null
          ? null
          : {
              proposalId: request.proposalId,
              campaignId: request.campaignId,
              agentName,
              localDateTime: request.localDateTime,
              ianaTimeZone: request.ianaTimeZone,
            };
      }),
    );
    return named.filter((request) => request !== null);
  } catch {
    return [];
  }
}

export default async function DashboardCampaignsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await requireAuthorizedDashboardAccess();
  const { workspace, staleRecovery } =
    await readWorkspaceSearchParams(searchParams);
  const dashboardWorkspace = await loadDashboardWorkspace(
    workspace,
    "/dash/campaigns",
    staleRecovery,
  );
  const definition = await loadPublishedDefinition();
  const mutationToken = await loadMutationToken();

  const campaigns = await (
    await loadCampaignRequestContext(await headers())
  ).application.queries.listCampaigns({ actor: access.identity });
  // The send-time requests an app has made that nobody has answered yet, each
  // named by the app that asked. See ADR-0039.
  const scheduleRequests = await loadNamedScheduleRequests();

  const { contentRevision } = dashboardWorkspace;
  const postArtifacts = await createBlogPostArtifactFingerprints({
    definition: contentRevision.definition,
    inputs: {
      ...contentRevision.inputs,
      schemaVersion: contentRevision.definition.schemaVersion,
    },
  });

  return (
    <main className="dashboard-main" id="main">
      <div className="page-heading">
        <div>
          <h1>Newsletter</h1>
          <p>
            Write a campaign, send yourself a test, then schedule it. Only you
            can authorise a send to the whole list.
          </p>
        </div>
      </div>
      <CampaignControls
        csrfToken={mutationToken}
        workspaceId={dashboardWorkspace.workspaceId}
        // Only site photos an email can load are offered here. A relative
        // built-in address such as "/logo.svg" cannot be sent in an email
        // (ADR-0014 needs an absolute address), so the picker lists uploads and
        // absolute site photos, never a bare path the owner could not send.
        siteImages={siteStaticImageTiles(
          definition,
          contentRevision.definition,
        ).filter((image) => image.src.startsWith("https://"))}
        initialCampaigns={campaigns}
        initialScheduleRequests={scheduleRequests}
        // The steps say whose step each one is. The server still decides every
        // command; this only lets the screen explain an Owner-only step to an
        // Editor instead of refusing it after the fact.
        role={access.membership.role}
        postSources={postArtifacts.flatMap((artifact) => {
          const post = definition.blog.posts.find(
            ({ id }) => id === artifact.postId,
          );
          return post === undefined ? [] : [{ post, artifact }];
        })}
      />
    </main>
  );
}
