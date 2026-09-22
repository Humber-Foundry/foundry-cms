import type {
  ArchivedBlogPostSummary,
  BlogPostOperationalSummary,
} from "@humber-foundry/application";
import type { BlogPostId } from "@humber-foundry/site-definition";

import { installedSiteDefinition } from "../foundry/site-definition";
import {
  loadBlogPostOperationalSummaries,
  loadBlogPostOperationsApplication,
} from "./blog-post-operations-runtime";
import { blogScheduleRequestAgentNames } from "./blog-schedule-request-runtime";
import { loadHumanAccessEnvironment } from "./human-access-environment";

/**
 * What the Blog screens know about a post beyond the draft itself: its
 * schedule, its archive state, its last failed publication, and any app
 * request nobody has answered.
 *
 * The posts list and one post's own screen both need this (#230), so the read
 * lives here rather than in either route.
 */
export type BlogPostSummaries = Readonly<{
  summaries: ReadonlyMap<BlogPostId, BlogPostOperationalSummary>;
  pendingScheduleRequestAgentNames: ReadonlyMap<BlogPostId, string>;
}>;

export type BlogPostOperationalContext = BlogPostSummaries &
  Readonly<{ archivedPosts: ReadonlyArray<ArchivedBlogPostSummary> }>;

const noBlogPostSummaries: BlogPostSummaries = {
  summaries: new Map(),
  pendingScheduleRequestAgentNames: new Map(),
};

/**
 * Each named post's schedule, archive and retry state, and the name of any
 * app that has asked to publish it. Loaded straight from the blog-operations
 * application — the same one the blog-operations API route uses — so the
 * dashboard needs no second HTTP round trip to know what it already computed
 * on the server.
 *
 * Returns empty results instead of throwing when blog-post operations are
 * not configured (for example, local development without a database), so a
 * missing schedule/archive backend never blocks the ordinary post list.
 */
export async function loadBlogPostSummaries(
  postIds: ReadonlyArray<BlogPostId>,
): Promise<BlogPostSummaries> {
  try {
    const environment = await loadHumanAccessEnvironment();
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
      pendingScheduleRequestAgentNames: await blogScheduleRequestAgentNames(
        environment,
        pendingProposalsByPostId,
      ),
    };
  } catch {
    return noBlogPostSummaries;
  }
}

/**
 * The same read, plus every archived post. Only the posts list draws archived
 * posts, so one post's own screen uses `loadBlogPostSummaries` and never asks
 * the store for a list it would throw away.
 */
export async function loadBlogPostOperationalContext(
  postIds: ReadonlyArray<BlogPostId>,
): Promise<BlogPostOperationalContext> {
  const summaries = await loadBlogPostSummaries(postIds);
  try {
    const environment = await loadHumanAccessEnvironment();
    const application = await loadBlogPostOperationsApplication(environment);
    return {
      ...summaries,
      archivedPosts: await application.queries.listArchivedPosts(
        installedSiteDefinition.site.id,
      ),
    };
  } catch {
    return { ...summaries, archivedPosts: [] };
  }
}
