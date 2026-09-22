import { redirect } from "next/navigation";

import { blogListHref } from "@/components/blog-links";
import { DashboardBackLink } from "@/components/dashboard-back-link";
import { DashboardPageHeader } from "@/components/dashboard-page-header";
import { NewBlogPostScreen } from "@/components/new-blog-post-screen";
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
 * The writing box for one new post, on its own screen (#230). The back link
 * returns to the posts list, so the person can always get back to it.
 */
export default async function NewBlogPostPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAuthorizedDashboardAccess();
  const { workspace, staleRecovery } =
    await readWorkspaceSearchParams(searchParams);
  const dashboardWorkspace = await loadDashboardWorkspace(
    workspace,
    "/dash/blog/new",
    staleRecovery,
  );

  // A stale or older-schema draft rejects every post change. The posts list
  // is where the fresh start is offered, so send the person there rather than
  // draw a writing box whose save must fail.
  if (
    dashboardWorkspace.schemaRecovery !== undefined ||
    dashboardWorkspace.contentStale
  ) {
    redirect(blogListHref(dashboardWorkspace.workspaceId));
  }

  const definition = await loadPublishedDefinition();
  const mutationToken = await loadMutationToken();

  return (
    <main className="dashboard-main" id="main">
      <DashboardBackLink
        href={blogListHref(dashboardWorkspace.workspaceId)}
        label="Back to Blog"
      />
      <DashboardPageHeader
        title="New post"
        description="Write a private draft to publish when it is ready."
      />
      <NewBlogPostScreen
        revision={dashboardWorkspace.contentRevision}
        csrfToken={mutationToken}
        siteImages={siteStaticImageTiles(
          definition,
          dashboardWorkspace.contentRevision.definition,
        )}
      />
    </main>
  );
}
