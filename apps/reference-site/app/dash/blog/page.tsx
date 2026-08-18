import { BlogPostControls } from "@/components/blog-post-controls";
import { ContentWorkspaceStarter } from "@/components/content-workspace-starter";
import { verifiedPublicBlogPostIds } from "@/components/published-blog-posts";
import {
  loadDashboardWorkspace,
  loadMutationToken,
  loadPublishedDefinition,
  readWorkspaceSearchParams,
} from "@/src/dashboard-page-context";
import { siteStaticImageTiles } from "@/src/site-used-photos";

export const dynamic = "force-dynamic";

/**
 * Blog is the whole post lifecycle in one place: write a draft, edit it,
 * preview the exact draft, and publish or archive it.
 */
export default async function DashboardBlogPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspace, staleRecovery } =
    await readWorkspaceSearchParams(searchParams);
  const dashboardWorkspace = await loadDashboardWorkspace(
    workspace,
    "/dash/blog",
  );
  const definition = await loadPublishedDefinition();
  const mutationToken = await loadMutationToken();

  const { contentRevision, schemaRecovery } = dashboardWorkspace;
  // A stale workspace would reject every post change, so Blog offers the same
  // fresh-start path the editor destinations do instead of dead controls.
  const needsFreshWorkspace =
    schemaRecovery !== undefined ||
    contentRevision === undefined ||
    dashboardWorkspace.contentStale === true;

  return (
    <main className="dashboard-main" id="main">
      <div className="page-heading">
        <div>
          <h1>Blog</h1>
          <p>Write posts, preview them privately, and publish when ready.</p>
        </div>
      </div>
      {needsFreshWorkspace ? (
        <ContentWorkspaceStarter
          csrfToken={mutationToken}
          staleRecovery={staleRecovery}
          preservedRevision={
            contentRevision && schemaRecovery
              ? {
                  workspaceId: contentRevision.workspaceId,
                  revision: contentRevision.revision,
                  schemaVersion: contentRevision.inputs.schemaVersion,
                }
              : undefined
          }
          durableRecoveryEdits={schemaRecovery}
        />
      ) : (
        <BlogPostControls
          revision={contentRevision}
          csrfToken={mutationToken}
          siteImages={siteStaticImageTiles(
            definition,
            contentRevision.definition,
          )}
          verifiedPublicPostIds={verifiedPublicBlogPostIds(definition)}
        />
      )}
    </main>
  );
}
