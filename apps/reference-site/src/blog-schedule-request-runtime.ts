import "server-only";

import type { BlogPostScheduleProposal } from "@humber-foundry/application";
import type { BlogPostId } from "@humber-foundry/site-definition";

import { mcpScheduleRequestAgentName } from "./mcp-schedule-request-agent";
import type { HumanAccessEnvironment } from "./human-access-configuration";

export { unnamedConnectedApp } from "./mcp-preview-review-runtime";
export { isMcpScheduleRequest } from "./mcp-schedule-request-agent";

/**
 * The plain name of the app that asked for a post's schedule. The blog
 * commands accept a person's own `proposeSchedule` call too (see
 * `commands.proposeSchedule` in `@humber-foundry/application`), but nothing
 * in this product calls it that way today, and issue #219 shows only the
 * requests an app made. Returns `null` for a proposal a person made directly.
 */
export async function blogScheduleRequestAgentName(
  environment: HumanAccessEnvironment,
  createdBy: string,
): Promise<string | null> {
  return mcpScheduleRequestAgentName(environment, createdBy);
}

/**
 * The app name for every pending schedule request in `createdByPostId`,
 * keyed by post id. A proposal a person made directly is left out of the
 * map entirely, since this product never shows that as an app's request.
 */
export async function blogScheduleRequestAgentNames(
  environment: HumanAccessEnvironment,
  createdByPostId: ReadonlyMap<BlogPostId, BlogPostScheduleProposal>,
): Promise<ReadonlyMap<BlogPostId, string>> {
  const entries = await Promise.all(
    [...createdByPostId.entries()].map(async ([postId, proposal]) => {
      const agentName = await blogScheduleRequestAgentName(
        environment,
        proposal.createdBy,
      );
      return agentName === null ? null : ([postId, agentName] as const);
    }),
  );
  return new Map(
    entries.filter(
      (entry): entry is readonly [BlogPostId, string] => entry !== null,
    ),
  );
}
