/**
 * The one path an MCP resource address is built from. Not a secret.
 *
 * Kept in its own module with no other imports, so a page that only needs to
 * show or build the address does not pull in the whole MCP runtime.
 */
export const mcpResourcePath = "/api/foundry-mcp";
