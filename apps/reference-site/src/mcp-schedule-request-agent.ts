import "server-only";

import { mcpConnectionDisplayName } from "./mcp-connection-display";
import { unnamedConnectedApp } from "./mcp-preview-review-runtime";
import type { HumanAccessEnvironment } from "./human-access-configuration";

export { unnamedConnectedApp } from "./mcp-preview-review-runtime";

const mcpCreatedByPrefix = "mcp-";

/**
 * Whether an app asked for this, rather than a person.
 *
 * Both the blog and the newsletter record a schedule request the same way:
 * the row's `createdBy` is the connection's own actor id with an `mcp-`
 * prefix. A proposal a person made directly carries their membership id
 * instead, and this product never shows that as an app's request.
 */
export function isMcpScheduleRequest(createdBy: string): boolean {
  return createdBy.startsWith(mcpCreatedByPrefix);
}

/**
 * The plain name of the app that asked, read from the connection's own
 * registered address the same way draft review names it (see CONTEXT.md
 * "App / Connected app"). Returns `null` for a request a person made.
 */
export async function mcpScheduleRequestAgentName(
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
    .prepare(`SELECT oauth_client_id FROM mcp_connections WHERE actor_id = ?1`)
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
