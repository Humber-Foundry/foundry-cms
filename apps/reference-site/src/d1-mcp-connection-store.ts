import type {
  McpConnectionGrant,
  McpConnectionSummary,
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

export type ExchangedMcpAuthorizationCode = McpConnectionGrant &
  Readonly<{
    codeChallenge: string;
  }>;

export type McpRefreshRotation =
  | Readonly<{
      state: "rotated";
      connection: McpConnectionGrant;
    }>
  | Readonly<{ state: "reuse_detected" }>
  | Readonly<{ state: "invalid" }>;

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
      inputHash: string;
    }): Promise<void>;
    exchangeAuthorizationCode(input: {
      codeHash: string;
      codeChallenge: string;
      clientId: string;
      redirectUri: string;
      refreshTokenHash: string;
      refreshFamilyId: string;
      refreshExpiresAt: string;
      now: string;
    }): Promise<ExchangedMcpAuthorizationCode | null>;
    revokeConnection(input: {
      siteId: SiteId;
      connectionId: string;
      ownerMembershipId: string;
      now: string;
      reason: string;
      inputHash: string;
    }): Promise<boolean>;
    rotateRefreshToken(input: {
      tokenHash: string;
      nextTokenHash: string;
      clientId: string;
      nextExpiresAt: string;
      now: string;
    }): Promise<McpRefreshRotation>;
    consumeRateLimit(input: {
      siteId: SiteId;
      bucketKey: string;
      windowStartedAt: string;
      limit: number;
    }): Promise<boolean>;
    listConnections(siteId: SiteId): Promise<
      ReadonlyArray<McpConnectionSummary>
    >;
    findLiveRelease(siteId: SiteId): Promise<{
      gitSha: string;
      releaseId: string;
      observedAt: string;
    } | null>;
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
               input_hash, protocol_version, scopes_json, outcome, reason,
               human_actor_id, revocation_reason, occurred_at, contract_version
             )
             SELECT ?1, ?2, ?3, ?4, 'foundry.connection.authorize',
                    ?7, '2025-11-25', '["site.read"]', 'allowed', NULL,
                    ?8, NULL, ?5, 'foundry.mcp.v1'
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
            input.inputHash,
            input.ownerMembershipId,
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
    async exchangeAuthorizationCode(input) {
      const results = await database.batch([
        database.prepare(
          `UPDATE mcp_authorization_codes
           SET consumed_at = ?1,
               refresh_token_hash = ?6,
               refresh_family_id = ?7,
               refresh_expires_at = ?8
           WHERE code_hash = ?2
             AND code_challenge = ?3
             AND consumed_at IS NULL
             AND expires_at > ?1
             AND EXISTS (
               SELECT 1 FROM mcp_connections AS connection
               WHERE connection.id = mcp_authorization_codes.connection_id
                 AND connection.oauth_client_id = ?4
                 AND connection.redirect_uri = ?5
                 AND connection.status = 'active'
             )
           RETURNING connection_id, code_challenge`,
        ).bind(
          input.now,
          input.codeHash,
          input.codeChallenge,
          input.clientId,
          input.redirectUri,
          input.refreshTokenHash,
          input.refreshFamilyId,
          input.refreshExpiresAt,
        ),
        database.prepare(
          `INSERT INTO mcp_refresh_tokens (
             token_hash, family_id, connection_id, oauth_client_id,
             expires_at, issued_at
           )
           SELECT
             code.refresh_token_hash,
             code.refresh_family_id,
             code.connection_id,
             connection.oauth_client_id,
             code.refresh_expires_at,
             code.consumed_at
           FROM mcp_authorization_codes AS code
           JOIN mcp_connections AS connection
             ON connection.id = code.connection_id
           WHERE code.code_hash = ?5
             AND code.code_challenge = ?6
             AND code.consumed_at = ?4
             AND code.refresh_token_hash = ?1
             AND code.refresh_family_id = ?2
             AND code.refresh_expires_at = ?3
             AND connection.oauth_client_id = ?7
             AND connection.redirect_uri = ?8
             AND connection.status = 'active'`,
        ).bind(
          input.refreshTokenHash,
          input.refreshFamilyId,
          input.refreshExpiresAt,
          input.now,
          input.codeHash,
          input.codeChallenge,
          input.clientId,
          input.redirectUri,
        ),
      ]);
      const consumed = results[0]?.results?.[0] as
        | AuthorizationCodeRow
        | undefined;
      if (
        consumed === undefined ||
        (results[0]?.meta.changes ?? 0) !== 1 ||
        (results[1]?.meta.changes ?? 0) !== 1
      ) {
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
               input_hash, protocol_version, scopes_json, outcome, reason,
               human_actor_id, revocation_reason, occurred_at, contract_version
             )
             SELECT ?1, id, actor_id, site_id, 'foundry.connection.revoke',
                    ?5, '2025-11-25', scopes_json, 'allowed', NULL,
                    ?6, ?7, ?2, 'foundry.mcp.v1'
             FROM mcp_connections
             WHERE id = ?3 AND site_id = ?4 AND status = 'revoked'
               AND revoked_at = ?2`,
          )
          .bind(
            `revoke:${input.connectionId}:${input.now}`,
            input.now,
            input.connectionId,
            input.siteId,
            input.inputHash,
            input.ownerMembershipId,
            input.reason,
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
             input_hash, protocol_version, scopes_json, outcome, reason,
             human_actor_id, revocation_reason, occurred_at, contract_version
           ) VALUES (
             ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
             NULL, NULL, ?11, ?12
           )`,
        )
        .bind(
          event.invocationId,
          event.connectionId,
          event.actorId,
          event.siteId,
          event.operation,
          event.inputHash,
          event.protocolVersion,
          JSON.stringify(event.scopesEvaluated),
          event.outcome,
          event.reason,
          event.occurredAt,
          event.contractVersion,
        )
        .run();
    },
    async rotateRefreshToken(input) {
      const existing = await database
        .prepare(
          `SELECT
             token.family_id, token.connection_id, token.expires_at,
             token.consumed_at, token.revoked_at,
             connection.actor_id, connection.site_id, connection.scopes_json,
             connection.status AS connection_status
           FROM mcp_refresh_tokens AS token
           JOIN mcp_connections AS connection
             ON connection.id = token.connection_id
           WHERE token.token_hash = ?1 AND token.oauth_client_id = ?2`,
        )
        .bind(input.tokenHash, input.clientId)
        .first<{
          family_id: string;
          connection_id: string;
          expires_at: string;
          consumed_at: string | null;
          revoked_at: string | null;
          actor_id: string;
          site_id: string;
          scopes_json: string;
          connection_status: "active" | "revoked";
        }>();
      if (
        existing === null ||
        existing.connection_status !== "active" ||
        existing.revoked_at !== null ||
        existing.expires_at <= input.now
      ) {
        return { state: "invalid" };
      }
      if (existing.consumed_at !== null) {
        await database.batch([
          database
            .prepare(
              `UPDATE mcp_refresh_tokens
               SET revoked_at = COALESCE(revoked_at, ?1)
               WHERE family_id = ?2`,
            )
            .bind(input.now, existing.family_id),
          database
            .prepare(
              `UPDATE mcp_connections
               SET status = 'revoked', revoked_at = COALESCE(revoked_at, ?1)
               WHERE id = ?2 AND status = 'active'`,
            )
            .bind(input.now, existing.connection_id),
          database
            .prepare(
              `INSERT INTO mcp_audit_events (
                 invocation_id, connection_id, actor_id, site_id, operation,
                 input_hash, protocol_version, scopes_json, outcome, reason,
                 human_actor_id, revocation_reason, occurred_at,
                 contract_version
               ) VALUES (
                 ?1, ?2, ?3, ?4, 'foundry.connection.refresh_reuse',
                 ?5, '2025-11-25', ?6, 'denied',
                 'CONNECTION_REVOKED', NULL, 'refresh_token_reuse', ?7,
                 'foundry.mcp.v1'
               )`,
            )
            .bind(
              `refresh-reuse:${existing.family_id}:${input.now}`,
              existing.connection_id,
              existing.actor_id,
              existing.site_id,
              input.tokenHash,
              existing.scopes_json,
              input.now,
            ),
        ]);
        return { state: "reuse_detected" };
      }
      const results = await database.batch([
        database
          .prepare(
            `UPDATE mcp_refresh_tokens
             SET consumed_at = ?1, replacement_hash = ?2
             WHERE token_hash = ?3
               AND consumed_at IS NULL
               AND revoked_at IS NULL
               AND expires_at > ?1`,
          )
          .bind(input.now, input.nextTokenHash, input.tokenHash),
        database
          .prepare(
            `INSERT INTO mcp_refresh_tokens (
               token_hash, family_id, connection_id, oauth_client_id,
               expires_at, issued_at
             )
             SELECT ?1, family_id, connection_id, oauth_client_id, ?2, ?3
             FROM mcp_refresh_tokens
             WHERE token_hash = ?4
               AND consumed_at = ?3
               AND replacement_hash = ?1
               AND revoked_at IS NULL`,
          )
          .bind(
            input.nextTokenHash,
            input.nextExpiresAt,
            input.now,
            input.tokenHash,
          ),
      ]);
      if (
        (results[0]?.meta.changes ?? 0) !== 1 ||
        (results[1]?.meta.changes ?? 0) !== 1
      ) {
        return store.rotateRefreshToken(input);
      }
      const connection = await store.findCurrentConnection({
        connectionId: existing.connection_id,
        siteId: (
          await database
            .prepare(`SELECT site_id FROM mcp_connections WHERE id = ?1`)
            .bind(existing.connection_id)
            .first<{ site_id: string }>()
        )?.site_id as SiteId,
      });
      return connection === null || connection.status !== "active"
        ? { state: "invalid" }
        : { state: "rotated", connection };
    },
    async consumeRateLimit(input) {
      if (
        input.bucketKey.length < 1 ||
        input.bucketKey.length > 128 ||
        !Number.isInteger(input.limit) ||
        input.limit < 1 ||
        !Number.isFinite(Date.parse(input.windowStartedAt))
      ) {
        throw new TypeError("mcp_rate_limit_key_invalid");
      }
      if (input.bucketKey === "site") {
        const retentionThreshold = new Date(
          Date.parse(input.windowStartedAt) - 2 * 60 * 60 * 1_000,
        ).toISOString();
        await database
          .prepare(
            `DELETE FROM mcp_rate_limit_buckets
             WHERE site_id = ?1 AND window_started_at < ?2`,
          )
          .bind(input.siteId, retentionThreshold)
          .run();
      }
      const row = await database
        .prepare(
          `INSERT INTO mcp_rate_limit_buckets (
             site_id, bucket_key, window_started_at, request_count
           ) VALUES (?1, ?2, ?3, 1)
           ON CONFLICT (site_id, bucket_key, window_started_at)
           DO UPDATE SET request_count = request_count + 1
           WHERE request_count < ?4
           RETURNING request_count`,
        )
        .bind(
          input.siteId,
          input.bucketKey,
          input.windowStartedAt,
          input.limit,
        )
        .first<{ request_count: number }>();
      return row !== null;
    },
    async listConnections(siteId) {
      const rows = await database
        .prepare(
          `SELECT
             connection.id, connection.actor_id, connection.site_id,
             connection.oauth_client_id, connection.scopes_json,
             connection.status, connection.created_at, connection.revoked_at,
             MAX(audit.occurred_at) AS last_used_at
           FROM mcp_connections AS connection
           LEFT JOIN mcp_audit_events AS audit
             ON audit.connection_id = connection.id
            AND audit.operation NOT IN (
              'foundry.connection.authorize',
              'foundry.connection.revoke'
            )
           WHERE connection.site_id = ?1
           GROUP BY connection.id
           ORDER BY connection.created_at DESC, connection.id`,
        )
        .bind(siteId)
        .all<
          ConnectionRow & {
            created_at: string;
            revoked_at: string | null;
            last_used_at: string | null;
          }
        >();
      return rows.results.map((row) => ({
        ...toConnection(row),
        createdAt: row.created_at,
        revokedAt: row.revoked_at,
        lastUsedAt: row.last_used_at,
      }));
    },
    async findLiveRelease(siteId) {
      const row = await database
        .prepare(
          `SELECT
             publication.commit_sha,
             publication.deployment_id,
             publication.updated_at
           FROM content_publications AS publication
           JOIN content_workspaces AS workspace
             ON workspace.workspace_id = publication.workspace_id
           WHERE publication.status = 'verified-live'
             AND publication.commit_sha IS NOT NULL
             AND publication.deployment_id IS NOT NULL
             AND workspace.site_id = ?1
           ORDER BY publication.updated_at DESC, publication.id DESC
           LIMIT 1`,
        )
        .bind(siteId)
        .first<{
          commit_sha: string;
          deployment_id: string;
          updated_at: string;
        }>();
      return row === null
        ? null
        : {
            gitSha: row.commit_sha,
            releaseId: row.deployment_id,
            observedAt: row.updated_at,
          };
    },
  };

  return store;
}
