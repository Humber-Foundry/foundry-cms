import "server-only";

import { installedSiteDefinition } from "../foundry/site-definition";

import { createD1McpConnectionStore } from "./d1-mcp-connection-store";
import { loadHumanAccessEnvironment } from "./human-access-environment";
import { mcpResourcePath } from "./mcp-resource-path";

export async function loadMcpConnectionsForDashboard() {
  if (process.env.NODE_ENV === "development") return [];
  const environment = await loadHumanAccessEnvironment();
  if (environment.FOUNDRY_DB === undefined) return [];
  return createD1McpConnectionStore(
    environment.FOUNDRY_DB,
  ).listConnections(installedSiteDefinition.site.id);
}

/**
 * The address an agent connects to, and whether that address is public.
 *
 * The address is always built from this installation's real configured
 * origin, never a placeholder. It is not a secret, so this is safe to render
 * on screen; it never carries a token.
 */
export type McpAgentConnectionInfo = Readonly<{
  /** Null only when this installation has not set its site address yet. */
  resourceUri: string | null;
  /**
   * False in local development, a private preview, or any address that is
   * not plain HTTPS. An outside client such as claude.ai or ChatGPT cannot
   * reach an address that fails this check.
   */
  reachableFromOutsideThisMachine: boolean;
}>;

export async function loadMcpAgentConnectionInfo(): Promise<McpAgentConnectionInfo> {
  const environment = await loadHumanAccessEnvironment();
  const origin = environment.FOUNDRY_CANONICAL_ORIGIN;
  if (origin === undefined || origin.trim() === "") {
    return { resourceUri: null, reachableFromOutsideThisMachine: false };
  }
  return {
    resourceUri: `${origin}${mcpResourcePath}`,
    reachableFromOutsideThisMachine:
      process.env.NODE_ENV !== "development" && origin.startsWith("https://"),
  };
}
