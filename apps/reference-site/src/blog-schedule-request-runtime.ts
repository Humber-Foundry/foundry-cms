import "server-only";

import type { BlogPostScheduleProposal } from "@humber-foundry/application";
import type { BlogPostId } from "@humber-foundry/site-definition";

import { mcpConnectionDisplayName } from "./mcp-connection-display";
import { unnamedConnectedApp } from "./mcp-preview-review-runtime";
import type { HumanAccessEnvironment } from "./human-access-configuration";

export { unnamedConnectedApp } from "./mcp-preview-review-runtime";

const mcpCreatedByPrefix = "mcp-";

/**
 * Whether an app asked for this schedule, rather than a person. The blog
 * commands accept a person's own `proposeSchedule` call too (see
 * `commands.proposeSchedule` in `@humber-foundry/application`), but nothing
 * in this product calls it that way today, and issue #219 shows only the
 * requests an app made.
 */
export function isMcpScheduleRequest(createdBy: string): boolean {
  return createdBy.startsWith(mcpCreatedByPrefix);
}

/**
 * The plain name of the app that asked for a schedule, read from the
 * connection's own registered address the same way draft review names it
 * (see CONTEXT.md "App / Connected app"). Returns `null` for a proposal a
 * person made directly.
 */
export async function blogScheduleRequestAgentName(
  environment: HumanAccessEnvironment,
  createdBy: string,
): Promise<string | null> {
  if (!isMcpScheduleRequest(createdBy)) {
    return null;
  }
  if (environment.FOUNDRY_DB === undefined) {
    return unnamedConnectedApp;
  }
  const actorId = createdBy.slice(mcpCreatedByPrefix.length);
  const row = await environment.FOUNDRY_DB
    .prepare(
      `SELECT oauth_client_id FROM mcp_connections WHERE actor_id = ?1`,
    )
    .bind(actorId)
    .first<{ oauth_client_id: string | null }>();
  if (
    row === null ||
    row.oauth_client_id === null ||
    row.oauth_client_id === ""
  ) {
    return unnamedConnectedApp;
  }
  return mcpConnectionDisplayName(row.oauth_client_id);
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
