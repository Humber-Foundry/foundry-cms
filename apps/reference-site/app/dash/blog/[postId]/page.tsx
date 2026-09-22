import { notFound, redirect } from "next/navigation";

import { blogListHref } from "@/components/blog-links";
import { blogPostName } from "@/components/blog-operations";
import { BlogPostScreen } from "@/components/blog-post-screen";
import { DashboardBackLink } from "@/components/dashboard-back-link";
import { DashboardPageHeader } from "@/components/dashboard-page-header";
import { verifiedPublicBlogPostIds } from "@/components/published-blog-posts";
import { loadBlogPostStanding } from "@/src/blog-dashboard-context";
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
 * One saved post, on its own screen (#230): where it stands, the preview of
 * this exact draft, the schedule that preview unlocks, and the writing box.
 * The back link returns to the posts list, so this screen is never a dead end.
 */
export default async function DashboardBlogPostPage({
  params,
  searchParams,
}: {
  params: Promise<{ postId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAuthorizedDashboardAccess();
  const { postId } = await params;
  const { workspace, staleRecovery } =
    await readWorkspaceSearchParams(searchParams);
  const dashboardWorkspace = await loadDashboardWorkspace(
    workspace,
    `/dash/blog/${encodeURIComponent(postId)}`,
    staleRecovery,
  );

  // A stale or older-schema draft rejects every post change. The posts list
  // is where the fresh start is offered, so send the person there rather than
  // draw controls whose every command must fail.
  if (
    dashboardWorkspace.schemaRecovery !== undefined ||
    dashboardWorkspace.contentStale
  ) {
    redirect(blogListHref(dashboardWorkspace.workspaceId));
  }

  const { contentRevision } = dashboardWorkspace;
  // A post this draft does not hold is a dead link, not a fault. An archived
  // post has left the draft, so its own address stops working once it is
  // archived, exactly as a deleted page's does.
  const post = contentRevision.definition.blog.posts.find(
    (candidate) => candidate.id === postId,
  );
  if (post === undefined) notFound();

  const definition = await loadPublishedDefinition();
  const mutationToken = await loadMutationToken();
  const { summaries, pendingScheduleRequestAgentNames } =
    await loadBlogPostStanding([post.id]);

  return (
    <main className="dashboard-main" id="main">
      <DashboardBackLink
        href={blogListHref(dashboardWorkspace.workspaceId)}
        label="Back to Blog"
      />
      <DashboardPageHeader
        title={blogPostName(post.title)}
        description="Change it, preview it privately, then publish or schedule it."
      />
      <BlogPostScreen
        revision={contentRevision}
        post={post}
        csrfToken={mutationToken}
        siteImages={siteStaticImageTiles(
          definition,
          contentRevision.definition,
        )}
        verifiedPublicPostIds={verifiedPublicBlogPostIds(definition)}
        summary={summaries.get(post.id)}
        pendingScheduleRequestAgentName={
          pendingScheduleRequestAgentNames.get(post.id) ?? null
        }
      />
    </main>
  );
}
