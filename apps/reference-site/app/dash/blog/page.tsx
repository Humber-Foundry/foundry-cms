import type {
  ArchivedBlogPostSummary,
  BlogPostOperationalSummary,
} from "@humber-foundry/application";
import type { BlogPostId } from "@humber-foundry/site-definition";

import { BlogPostControls } from "@/components/blog-post-controls";
import { ContentDraftRecovery } from "@/components/content-draft-recovery";
import { verifiedPublicBlogPostIds } from "@/components/published-blog-posts";
import { installedSiteDefinition } from "@/foundry/site-definition";
import { loadBlogPostOperationsApplication } from "@/src/blog-post-operations-runtime";
import {
  loadDashboardWorkspace,
  loadMutationToken,
  loadPublishedDefinition,
  preservedRevisionOf,
  readWorkspaceSearchParams,
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
  }>
> {
  try {
    const application = await loadBlogPostOperationsApplication(
      await loadHumanAccessEnvironment(),
    );
    const siteId = installedSiteDefinition.site.id;
    const summaryEntries = await Promise.all(
      postIds.map(async (postId) => {
        const summary = await application.queries.getPostSummary(
          siteId,
          postId,
        );
        return summary === null ? null : ([postId, summary] as const);
      }),
    );
    return {
      summaries: new Map(
        summaryEntries.filter(
          (entry): entry is readonly [BlogPostId, BlogPostOperationalSummary] =>
            entry !== null,
        ),
      ),
      archivedPosts: await application.queries.listArchivedPosts(siteId),
    };
  } catch {
    return { summaries: new Map(), archivedPosts: [] };
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
  );
  const definition = await loadPublishedDefinition();
  const mutationToken = await loadMutationToken();

  const { contentRevision, schemaRecovery } = dashboardWorkspace;
  // The draft workspace always exists. A stale or older-schema workspace would
  // reject every post change, so Blog offers a fresh start instead of dead
  // controls.
  const needsFreshWorkspace =
    schemaRecovery !== undefined || dashboardWorkspace.contentStale;

  const { summaries, archivedPosts } = needsFreshWorkspace
    ? { summaries: new Map(), archivedPosts: [] }
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
          reason={
            schemaRecovery === undefined ? "site-updated" : "older-schema"
          }
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
        />
      )}
    </main>
  );
}
