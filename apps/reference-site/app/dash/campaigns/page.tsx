import { headers } from "next/headers";

import { createBlogPostArtifactFingerprints } from "@humber-foundry/application";

import { CampaignControls } from "@/components/campaign-controls";
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
 * Newsletter is where campaigns are written, tested and scheduled. A campaign
 * can stand alone or start from a blog post; either way Foundry renders and
 * fingerprints the exact email that gets sent.
 */
export default async function DashboardCampaignsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await requireAuthorizedDashboardAccess();
  const { workspace } = await readWorkspaceSearchParams(searchParams);
  const dashboardWorkspace = await loadDashboardWorkspace(
    workspace,
    "/dash/campaigns",
  );
  const definition = await loadPublishedDefinition();
  const mutationToken = await loadMutationToken();

  const campaigns = await (
    await loadCampaignRequestContext(await headers())
  ).application.queries.listCampaigns({ actor: access.identity });

  const { contentRevision } = dashboardWorkspace;
  const postArtifacts =
    contentRevision === undefined
      ? []
      : await createBlogPostArtifactFingerprints({
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
        siteImages={siteStaticImageTiles(
          definition,
          contentRevision?.definition,
        )}
        initialCampaigns={campaigns}
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
