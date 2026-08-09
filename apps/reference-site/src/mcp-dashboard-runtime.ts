import "server-only";

import { installedSiteDefinition } from "../foundry/site-definition";

import { createD1McpConnectionStore } from "./d1-mcp-connection-store";
import { loadHumanAccessEnvironment } from "./human-access-environment";

export async function loadMcpConnectionsForDashboard() {
  if (process.env.NODE_ENV === "development") return [];
  const environment = await loadHumanAccessEnvironment();
  if (environment.FOUNDRY_DB === undefined) return [];
  return createD1McpConnectionStore(
    environment.FOUNDRY_DB,
  ).listConnections(installedSiteDefinition.site.id);
}
