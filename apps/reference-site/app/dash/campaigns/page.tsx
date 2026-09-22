import { headers } from "next/headers";

import { createBlogPostArtifactFingerprints } from "@humber-foundry/application";

import { CampaignList } from "@/components/campaign-list";
import { loadCampaignRequestContext } from "@/src/campaign-runtime";
import { loadPendingCampaignScheduleRequests } from "@/src/campaign-schedule-request-runtime";
import {
  loadDashboardWorkspace,
  loadMutationToken,
  loadPublishedDefinition,
  readWorkspaceSearchParams,
  requireAuthorizedDashboardAccess,
} from "@/src/dashboard-page-context";

export const dynamic = "force-dynamic";

/**
 * Newsletter opens here, on the list of every email this site has written
 * (#237). An email is written, previewed, tested and sent on its own screen;
 * this one says what exists and offers the way in.
 */
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

  const campaignContext = await loadCampaignRequestContext(await headers());
  const campaigns = await campaignContext.application.queries.listCampaigns({
    actor: access.identity,
  });
  // The send-time requests an app has made that nobody has answered yet, each
  // named by the app that asked. See ADR-0039.
  const scheduleRequests = await loadPendingCampaignScheduleRequests({
    requests: campaignContext.scheduleProposals,
  });

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
      <CampaignList
        csrfToken={mutationToken}
        workspace={dashboardWorkspace.workspaceId}
        initialCampaigns={campaigns}
        initialScheduleRequests={scheduleRequests}
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
