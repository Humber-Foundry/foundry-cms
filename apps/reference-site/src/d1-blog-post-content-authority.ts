import type { McpBlogOperationAuthority } from "@humber-foundry/application";
import { mcpBlogOperationScopes } from "@humber-foundry/application";

/**
 * The SQL that says who may run a blog command that needs content authority.
 *
 * Two stores write that rule into their own statements — the blog post
 * operations store and the restore store — so it is written once here.
 *
 * It is either an active owner or editor of this site, or an active MCP
 * connection that holds every permission the request evaluated. A connection
 * is its own actor, so it never borrows a person's membership, and the four
 * MCP binds are NULL when a person ran the command. See ADR-0036.
 */
export function contentAuthoritySql(binds: {
  site: string;
  actor: string;
  connection: string;
  mcpActor: string;
  scopes: string;
  pinnedScope: string;
}) {
  return `(
               EXISTS (
                 SELECT 1 FROM human_memberships
                 WHERE site_id = ${binds.site} AND id = ${binds.actor}
                   AND status = 'active'
                   AND role IN ('owner', 'editor')
               )
               OR (
                 ${binds.connection} IS NOT NULL
                 AND json_array_length(COALESCE(${binds.scopes}, '[]')) > 0
                 AND EXISTS (
                   SELECT 1 FROM mcp_connections AS authority
                   JOIN mcp_connection_scopes AS pinned
                     ON pinned.connection_id = authority.id
                    AND pinned.scope = ${binds.pinnedScope}
                   WHERE authority.id = ${binds.connection}
                     AND authority.site_id = ${binds.site}
                     AND authority.actor_id = ${binds.mcpActor}
                     AND authority.status = 'active'
                     AND NOT EXISTS (
                       SELECT 1
                       FROM json_each(COALESCE(${binds.scopes}, '[]'))
                         AS required
                       WHERE NOT EXISTS (
                         SELECT 1 FROM mcp_connection_scopes AS granted
                         WHERE granted.connection_id = authority.id
                           AND granted.scope = required.value
                       )
                     )
                 )
               )
             )`;
}

/**
 * The four MCP authority binds, or nulls when a person ran the command: the
 * connection, its actor, the permissions the request evaluated, and the one
 * permission this command needs. They arrive in the order
 * `contentAuthoritySql` names them.
 */
export function mcpAuthorityBinds(
  authority: McpBlogOperationAuthority | undefined,
): readonly [
  string | null,
  string | null,
  string | null,
  string | null,
] {
  return authority === undefined
    ? [null, null, null, null]
    : [
        authority.connectionId,
        authority.actorId,
        JSON.stringify(authority.requiredScopes),
        mcpBlogOperationScopes[authority.operation],
      ];
}
