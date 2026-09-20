import type {
  ArchivedBlogPostSummary,
  BlogPostOperationalSummary,
} from "@humber-foundry/application";
import type { BlogPostId } from "@humber-foundry/site-definition";

import { BlogPostControls } from "@/components/blog-post-controls";
import { ContentDraftRecovery } from "@/components/content-draft-recovery";
import { verifiedPublicBlogPostIds } from "@/components/published-blog-posts";
import { installedSiteDefinition } from "@/foundry/site-definition";
import {
  loadBlogPostOperationalSummaries,
  loadBlogPostOperationsApplication,
} from "@/src/blog-post-operations-runtime";
import { blogScheduleRequestAgentNames } from "@/src/blog-schedule-request-runtime";
import {
  loadDashboardWorkspace,
  loadMutationToken,
  loadPublishedDefinition,
  preservedRevisionOf,
  readWorkspaceSearchParams,
  recoveryReasonOf,
} from "@/src/dashboard-page-context";
import { loadHumanAccessEnvironment } from "@/src/human-access-environment";
import { siteStaticImageTiles } from "@/src/site-used-photos";

export const dynamic = "force-dynamic";

/**
 * Each active post's schedule, archive and retry state, plus every archived
 * post. Loaded straight from the blog-operations application — the same one
 * the blog-operations API route uses — so the dashboard does not need a
 * second HTTP round trip to know what it already computed on the server.
 *
 * Returns empty results instead of throwing when blog-post operations are
 * not configured (for example, local development without a database), so a
 * missing schedule/archive backend never blocks the ordinary post list.
 */
async function loadBlogPostOperationalContext(
  postIds: ReadonlyArray<BlogPostId>,
): Promise<
  Readonly<{
    summaries: ReadonlyMap<BlogPostId, BlogPostOperationalSummary>;
    archivedPosts: ReadonlyArray<ArchivedBlogPostSummary>;
    pendingScheduleRequestAgentNames: ReadonlyMap<BlogPostId, string>;
  }>
> {
  try {
    const environment = await loadHumanAccessEnvironment();
    const application = await loadBlogPostOperationsApplication(environment);
    const siteId = installedSiteDefinition.site.id;
    const summaries = await loadBlogPostOperationalSummaries(
      environment,
      siteId,
      postIds,
    );
    const pendingProposalsByPostId = new Map(
      [...summaries.entries()]
        .filter(([, summary]) => summary.pendingScheduleProposal !== null)
        .map(([postId, summary]) => [
          postId,
          summary.pendingScheduleProposal!,
        ]),
    );
    return {
      summaries,
      archivedPosts: await application.queries.listArchivedPosts(siteId),
      pendingScheduleRequestAgentNames: await blogScheduleRequestAgentNames(
        environment,
        pendingProposalsByPostId,
      ),
    };
  } catch {
    return {
      summaries: new Map(),
      archivedPosts: [],
      pendingScheduleRequestAgentNames: new Map(),
    };
  }
}

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

  const { summaries, archivedPosts, pendingScheduleRequestAgentNames } =
    needsFreshWorkspace
      ? {
          summaries: new Map(),
          archivedPosts: [],
          pendingScheduleRequestAgentNames: new Map(),
        }
      : await loadBlogPostOperationalContext(
          contentRevision.definition.blog.posts.map((post) => post.id),
        );

  return (
    <main className="dashboard-main" id="main">
      <div className="page-heading">
        <div>
          <h1>Blog</h1>
          <p>Write posts, preview them privately, and publish when ready.</p>
        </div>
      </div>
      {needsFreshWorkspace ? (
        <ContentDraftRecovery
          csrfToken={mutationToken}
          staleRecovery={staleRecovery}
          preservedRevision={preservedRevisionOf(contentRevision)}
          durableRecoveryEdits={schemaRecovery}
          reason={recoveryReasonOf(dashboardWorkspace)}
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
          postSummaries={summaries}
          archivedPosts={archivedPosts}
          pendingScheduleRequestAgentNames={pendingScheduleRequestAgentNames}
        />
      )}
    </main>
  );
}
