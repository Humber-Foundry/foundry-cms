import type {
  McpConnectionGrant,
  McpConnectionStore,
  McpReadAuditEvent,
} from "@foundry/application";
import type { SiteId } from "@foundry/site-definition";

import type { D1DatabaseBinding } from "./d1-human-access-store";

type ConnectionRow = Readonly<{
  id: string;
  actor_id: string;
  site_id: string;
  oauth_client_id: string;
  scopes_json: string;
  status: "active" | "revoked";
}>;

type AuthorizationCodeRow = Readonly<{
  connection_id: string;
  code_challenge: string;
}>;

export type ConsumedMcpAuthorizationCode = McpConnectionGrant &
  Readonly<{
    codeChallenge: string;
  }>;

function toConnection(row: ConnectionRow): McpConnectionGrant {
  const parsedScopes: unknown = JSON.parse(row.scopes_json);
  if (
    !Array.isArray(parsedScopes) ||
    parsedScopes.some((scope) => typeof scope !== "string")
  ) {
    throw new TypeError("mcp_connection_scope_state_invalid");
  }
  return {
    connectionId: row.id,
    actorId: row.actor_id,
    siteId: row.site_id as SiteId,
    clientId: row.oauth_client_id,
    scopes: parsedScopes,
    status: row.status,
  };
}

export function createD1McpConnectionStore(database: D1DatabaseBinding) {
  const connectionProjection = `
    SELECT id, actor_id, site_id, oauth_client_id, scopes_json, status
    FROM mcp_connections
  `;

  const store: McpConnectionStore & {
    createAuthorizationGrant(input: {
      connectionId: string;
      actorId: string;
      siteId: SiteId;
      clientId: string;
      redirectUri: string;
      ownerMembershipId: string;
      codeHash: string;
      codeChallenge: string;
      expiresAt: string;
      now: string;
    }): Promise<void>;
    consumeAuthorizationCode(input: {
      codeHash: string;
      clientId: string;
      redirectUri: string;
      now: string;
    }): Promise<ConsumedMcpAuthorizationCode | null>;
    revokeConnection(input: {
      siteId: SiteId;
      connectionId: string;
      ownerMembershipId: string;
      now: string;
    }): Promise<boolean>;
  } = {
    async createAuthorizationGrant(input) {
      const results = await database.batch([
        database
          .prepare(
            `INSERT INTO mcp_connections (
               id, actor_id, site_id, oauth_client_id, redirect_uri,
               scopes_json, status, created_by_membership_id, created_at
             )
             SELECT ?1, ?2, ?3, ?4, ?5, '["site.read"]', 'active', ?6, ?7
             WHERE EXISTS (
               SELECT 1 FROM human_memberships
               WHERE id = ?6
                 AND site_id = ?3
                 AND role = 'owner'
                 AND status = 'active'
             )`,
          )
          .bind(
            input.connectionId,
            input.actorId,
            input.siteId,
            input.clientId,
            input.redirectUri,
            input.ownerMembershipId,
            input.now,
          ),
        database
          .prepare(
            `INSERT INTO mcp_authorization_codes (
               code_hash, connection_id, code_challenge, expires_at, created_at
             )
             SELECT ?1, ?2, ?3, ?4, ?5
             WHERE EXISTS (
               SELECT 1 FROM mcp_connections
               WHERE id = ?2 AND site_id = ?6 AND status = 'active'
             )`,
          )
          .bind(
            input.codeHash,
            input.connectionId,
            input.codeChallenge,
            input.expiresAt,
            input.now,
            input.siteId,
          ),
        database
          .prepare(
            `INSERT INTO mcp_audit_events (
               invocation_id, connection_id, actor_id, site_id, operation,
               scopes_json, outcome, reason, occurred_at, contract_version
             )
             SELECT ?1, ?2, ?3, ?4, 'foundry.connection.authorize',
                    '["site.read"]', 'allowed', NULL, ?5, 'foundry.mcp.v1'
             WHERE EXISTS (
               SELECT 1 FROM mcp_authorization_codes
               WHERE code_hash = ?6 AND connection_id = ?2
             )`,
          )
          .bind(
            `authorize:${input.connectionId}`,
            input.connectionId,
            input.actorId,
            input.siteId,
            input.now,
            input.codeHash,
          ),
      ]);
      if (
        (results[0]?.meta.changes ?? 0) !== 1 ||
        (results[1]?.meta.changes ?? 0) !== 1 ||
        (results[2]?.meta.changes ?? 0) !== 1
      ) {
        throw new TypeError("mcp_authorization_grant_not_created");
      }
    },
    async consumeAuthorizationCode(input) {
      const consumed = await database
        .prepare(
          `UPDATE mcp_authorization_codes
           SET consumed_at = ?1
           WHERE code_hash = ?2
             AND consumed_at IS NULL
             AND expires_at > ?1
             AND EXISTS (
               SELECT 1 FROM mcp_connections AS connection
               WHERE connection.id = mcp_authorization_codes.connection_id
                 AND connection.oauth_client_id = ?3
                 AND connection.redirect_uri = ?4
                 AND connection.status = 'active'
             )
           RETURNING connection_id, code_challenge`,
        )
        .bind(
          input.now,
          input.codeHash,
          input.clientId,
          input.redirectUri,
        )
        .first<AuthorizationCodeRow>();
      if (consumed === null) {
        return null;
      }
      const row = await database
        .prepare(`${connectionProjection} WHERE id = ?1`)
        .bind(consumed.connection_id)
        .first<ConnectionRow>();
      return row === null
        ? null
        : {
            ...toConnection(row),
            codeChallenge: consumed.code_challenge,
          };
    },
    async findCurrentConnection(input) {
      const row = await database
        .prepare(
          `${connectionProjection}
           WHERE id = ?1 AND site_id = ?2`,
        )
        .bind(input.connectionId, input.siteId)
        .first<ConnectionRow>();
      return row === null ? null : toConnection(row);
    },
    async revokeConnection(input) {
      const results = await database.batch([
        database
          .prepare(
            `UPDATE mcp_connections
             SET status = 'revoked', revoked_at = ?1
             WHERE id = ?2
               AND site_id = ?3
               AND status = 'active'
               AND EXISTS (
                 SELECT 1 FROM human_memberships
                 WHERE id = ?4
                   AND site_id = ?3
                   AND role = 'owner'
                   AND status = 'active'
               )`,
          )
          .bind(
            input.now,
            input.connectionId,
            input.siteId,
            input.ownerMembershipId,
          ),
        database
          .prepare(
            `INSERT INTO mcp_audit_events (
               invocation_id, connection_id, actor_id, site_id, operation,
               scopes_json, outcome, reason, occurred_at, contract_version
             )
             SELECT ?1, id, actor_id, site_id, 'foundry.connection.revoke',
                    scopes_json, 'allowed', NULL, ?2, 'foundry.mcp.v1'
             FROM mcp_connections
             WHERE id = ?3 AND site_id = ?4 AND status = 'revoked'
               AND revoked_at = ?2`,
          )
          .bind(
            `revoke:${input.connectionId}:${input.now}`,
            input.now,
            input.connectionId,
            input.siteId,
          ),
      ]);
      return (
        (results[0]?.meta.changes ?? 0) === 1 &&
        (results[1]?.meta.changes ?? 0) === 1
      );
    },
    async recordInvocation(event: McpReadAuditEvent) {
      await database
        .prepare(
          `INSERT INTO mcp_audit_events (
             invocation_id, connection_id, actor_id, site_id, operation,
             scopes_json, outcome, reason, occurred_at, contract_version
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
        )
        .bind(
          event.invocationId,
          event.connectionId,
          event.actorId,
          event.siteId,
          event.operation,
          JSON.stringify(event.scopesEvaluated),
          event.outcome,
          event.reason,
          event.occurredAt,
          event.contractVersion,
        )
        .run();
    },
  };

  return store;
}
