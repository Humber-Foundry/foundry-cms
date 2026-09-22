import { BlogPostList } from "@/components/blog-post-list";
import { ContentDraftRecovery } from "@/components/content-draft-recovery";
import { DashboardPageHeader } from "@/components/dashboard-page-header";
import { verifiedPublicBlogPostIds } from "@/components/published-blog-posts";
import { loadBlogPostOperationalContext } from "@/src/blog-dashboard-context";
import {
  loadDashboardWorkspace,
  loadMutationToken,
  loadPublishedDefinition,
  preservedRevisionOf,
  readWorkspaceSearchParams,
  recoveryReasonOf,
} from "@/src/dashboard-page-context";

export const dynamic = "force-dynamic";

/**
 * Blog opens on the list of posts, on every site, including one with no posts
 * yet (#230). Writing one post is its own screen: `/dash/blog/new` for a new
 * post, `/dash/blog/<postId>` for a saved one.
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
    staleRecovery,
  );
  const definition = await loadPublishedDefinition();
  const mutationToken = await loadMutationToken();

  const { contentRevision, schemaRecovery } = dashboardWorkspace;
  // The draft workspace always exists. A stale or older-schema workspace would
  // reject every post change, so Blog offers a fresh start instead of dead
  // controls.
  const needsFreshWorkspace =
    schemaRecovery !== undefined || dashboardWorkspace.contentStale;

  if (needsFreshWorkspace) {
    return (
      <main className="dashboard-main" id="main">
        <DashboardPageHeader
          title="Blog"
          description="Write posts, preview them privately, and publish when ready."
        />
        <ContentDraftRecovery
          csrfToken={mutationToken}
          staleRecovery={staleRecovery}
          preservedRevision={preservedRevisionOf(contentRevision)}
          durableRecoveryEdits={schemaRecovery}
          reason={recoveryReasonOf(dashboardWorkspace)}
        />
      </main>
    );
  }

  const { summaries, archivedPosts, pendingScheduleRequestAgentNames } =
    await loadBlogPostOperationalContext(
      contentRevision.definition.blog.posts.map((post) => post.id),
    );

  return (
    <main className="dashboard-main" id="main">
      <BlogPostList
        revision={contentRevision}
        csrfToken={mutationToken}
        verifiedPublicPostIds={verifiedPublicBlogPostIds(definition)}
        postSummaries={summaries}
        archivedPosts={archivedPosts}
        pendingScheduleRequestAgentNames={pendingScheduleRequestAgentNames}
      />
    </main>
  );
}
