import { newBlogPostHref } from "@/components/blog-links";
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

  // One screen, one description, whichever of the two things it shows.
  const blogScreenDescription =
    "Every post you have written. Open one to change it, preview it " +
    "privately, then publish it.";

  if (needsFreshWorkspace) {
    return (
      <main className="dashboard-main" id="main">
        <DashboardPageHeader title="Blog" description={blogScreenDescription} />
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

  const posts = contentRevision.definition.blog.posts;
  const { summaries, archivedPosts, pendingScheduleRequestAgentNames } =
    await loadBlogPostOperationalContext(posts.map((post) => post.id));

  return (
    <main className="dashboard-main" id="main">
      <DashboardPageHeader
        title="Blog"
        description={blogScreenDescription}
        // The empty state offers the same control, so the screen never shows
        // two "New post" buttons.
        action={
          posts.length === 0 ? undefined : (
            <a
              className="dash-button dash-button-primary"
              href={newBlogPostHref(dashboardWorkspace.workspaceId)}
            >
              New post
            </a>
          )
        }
      />
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
