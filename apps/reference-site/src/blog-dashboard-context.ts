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
import type { HumanAccessEnvironment } from "./human-access-configuration";
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
    return await readBlogPostSummaries(
      await loadHumanAccessEnvironment(),
      postIds,
    );
  } catch {
    return noBlogPostSummaries;
  }
}

async function readBlogPostSummaries(
  environment: HumanAccessEnvironment,
  postIds: ReadonlyArray<BlogPostId>,
): Promise<BlogPostSummaries> {
  const summaries = await loadBlogPostOperationalSummaries(
    environment,
    installedSiteDefinition.site.id,
    postIds,
  );
  const pendingProposalsByPostId = new Map(
    [...summaries.entries()].flatMap(([postId, summary]) =>
      summary.pendingScheduleProposal === null
        ? []
        : [[postId, summary.pendingScheduleProposal] as const],
    ),
  );
  return {
    summaries,
    pendingScheduleRequestAgentNames: await blogScheduleRequestAgentNames(
      environment,
      pendingProposalsByPostId,
    ),
  };
}

/**
 * The same read, plus every archived post. Only the posts list draws archived
 * posts, so one post's own screen uses `loadBlogPostSummaries` and never asks
 * the store for a list it would throw away.
 *
 * The two reads share one environment, and each fails on its own: a store
 * that cannot list archived posts still gives the summaries, and a store
 * that is not configured at all gives an empty list and empty summaries.
 */
export async function loadBlogPostOperationalContext(
  postIds: ReadonlyArray<BlogPostId>,
): Promise<BlogPostOperationalContext> {
  let environment: HumanAccessEnvironment;
  try {
    environment = await loadHumanAccessEnvironment();
  } catch {
    return { ...noBlogPostSummaries, archivedPosts: [] };
  }
  const [summaries, archivedPosts] = await Promise.all([
    readBlogPostSummaries(environment, postIds).catch(
      () => noBlogPostSummaries,
    ),
    loadBlogPostOperationsApplication(environment)
      .then((application) =>
        application.queries.listArchivedPosts(installedSiteDefinition.site.id),
      )
      .catch((): ReadonlyArray<ArchivedBlogPostSummary> => []),
  ]);
  return { ...summaries, archivedPosts };
}
