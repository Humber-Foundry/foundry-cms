import { readFile } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";

import {
  mcpContractVersion,
  type McpReadAuditEvent,
} from "@foundry/application";
import { referenceSiteDefinition } from "@foundry/site-definition";

import { createD1McpConnectionStore } from "./d1-mcp-connection-store";

describe("D1 MCP connection store", () => {
  let miniflare: Miniflare;
  let database: Awaited<ReturnType<Miniflare["getD1Database"]>>;

  beforeEach(async () => {
    miniflare = new Miniflare({
      compatibilityDate: "2026-07-26",
      modules: true,
      script: "export default { fetch() { return new Response('ok') } }",
      d1Databases: ["FOUNDRY_DB"],
    });
    database = await miniflare.getD1Database("FOUNDRY_DB");
    for (const migrationName of [
      "0001_human_access.sql",
      "0016_mcp_readonly_connections.sql",
    ]) {
      const migration = await readFile(
        new URL(`../migrations/${migrationName}`, import.meta.url),
        "utf8",
      );
      for (const statement of migration.trim().split(/\n\n+/)) {
        await database.prepare(statement).run();
      }
    }
    await database
      .prepare(
        `INSERT INTO human_users (id, email, created_at)
         VALUES ('user-owner', 'owner@example.test', ?1)`,
      )
      .bind("2026-07-29T18:00:00.000Z")
      .run();
    await database
      .prepare(
        `INSERT INTO human_memberships (
           id, site_id, user_id, email, identity_issuer, identity_subject,
           role, status, created_at, updated_at
         ) VALUES (
           'membership-owner', ?1, 'user-owner', 'owner@example.test',
           'https://access.example', 'owner-subject', 'owner', 'active', ?2, ?2
         )`,
      )
      .bind(
        referenceSiteDefinition.site.id,
        "2026-07-29T18:00:00.000Z",
      )
      .run();
  });

  afterEach(async () => {
    await miniflare.dispose();
  });

  it("atomically creates an immutable site.read connection and one-time PKCE code", async () => {
    const store = createD1McpConnectionStore(database);
    await store.createAuthorizationGrant({
      connectionId: "connection-1",
      actorId: "mcp-actor-1",
      siteId: referenceSiteDefinition.site.id,
      clientId: "https://client.example/metadata.json",
      redirectUri: "https://client.example/callback",
      ownerMembershipId: "membership-owner",
      codeHash: "code-hash-1",
      codeChallenge: "challenge-1",
      expiresAt: "2026-07-29T18:05:00.000Z",
      now: "2026-07-29T18:00:00.000Z",
      inputHash: "a".repeat(64),
    });

    await expect(
      store.consumeAuthorizationCode({
        codeHash: "code-hash-1",
        codeChallenge: "wrong-challenge",
        clientId: "https://client.example/metadata.json",
        redirectUri: "https://client.example/callback",
        now: "2026-07-29T18:00:59.000Z",
      }),
    ).resolves.toBeNull();
    await expect(
      store.consumeAuthorizationCode({
        codeHash: "code-hash-1",
        codeChallenge: "challenge-1",
        clientId: "https://client.example/metadata.json",
        redirectUri: "https://client.example/callback",
        now: "2026-07-29T18:01:00.000Z",
      }),
    ).resolves.toEqual({
      connectionId: "connection-1",
      actorId: "mcp-actor-1",
      siteId: referenceSiteDefinition.site.id,
      clientId: "https://client.example/metadata.json",
      scopes: ["site.read"],
      status: "active",
      codeChallenge: "challenge-1",
    });
    await expect(
      store.consumeAuthorizationCode({
        codeHash: "code-hash-1",
        codeChallenge: "challenge-1",
        clientId: "https://client.example/metadata.json",
        redirectUri: "https://client.example/callback",
        now: "2026-07-29T18:01:01.000Z",
      }),
    ).resolves.toBeNull();
    await expect(
      database
        .prepare(
          `UPDATE mcp_connections SET actor_id = 'membership-owner'
           WHERE id = 'connection-1'`,
        )
        .run(),
    ).rejects.toThrow(/mcp_connection_identity_is_immutable/u);
  });

  it("revokes in D1 before the next application command and preserves attribution", async () => {
    const store = createD1McpConnectionStore(database);
    await store.createAuthorizationGrant({
      connectionId: "connection-2",
      actorId: "mcp-actor-2",
      siteId: referenceSiteDefinition.site.id,
      clientId: "https://client.example/metadata.json",
      redirectUri: "https://client.example/callback",
      ownerMembershipId: "membership-owner",
      codeHash: "code-hash-2",
      codeChallenge: "challenge-2",
      expiresAt: "2026-07-29T18:05:00.000Z",
      now: "2026-07-29T18:00:00.000Z",
      inputHash: "b".repeat(64),
    });

    await expect(
      store.revokeConnection({
        siteId: referenceSiteDefinition.site.id,
        connectionId: "connection-2",
        ownerMembershipId: "membership-owner",
        now: "2026-07-29T18:02:00.000Z",
        reason: "Owner ended the test connection.",
        inputHash: "c".repeat(64),
      }),
    ).resolves.toBe(true);
    await expect(
      store.findCurrentConnection({
        siteId: referenceSiteDefinition.site.id,
        connectionId: "connection-2",
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        actorId: "mcp-actor-2",
        status: "revoked",
      }),
    );
    await expect(
      store.listConnections(referenceSiteDefinition.site.id),
    ).resolves.toEqual([
      expect.objectContaining({
        connectionId: "connection-2",
        clientId: "https://client.example/metadata.json",
        scopes: ["site.read"],
        status: "revoked",
        revokedAt: "2026-07-29T18:02:00.000Z",
      }),
    ]);
    await expect(
      database
        .prepare(
          `SELECT human_actor_id, revocation_reason, input_hash,
                  protocol_version
           FROM mcp_audit_events
           WHERE operation = 'foundry.connection.revoke'`,
        )
        .first(),
    ).resolves.toEqual({
      human_actor_id: "membership-owner",
      revocation_reason: "Owner ended the test connection.",
      input_hash: "c".repeat(64),
      protocol_version: "2025-11-25",
    });
  });

  it("writes attributable, redacted invocation history", async () => {
    const store = createD1McpConnectionStore(database);
    await store.createAuthorizationGrant({
      connectionId: "connection-3",
      actorId: "mcp-actor-3",
      siteId: referenceSiteDefinition.site.id,
      clientId: "https://client.example/metadata.json",
      redirectUri: "https://client.example/callback",
      ownerMembershipId: "membership-owner",
      codeHash: "code-hash-3",
      codeChallenge: "challenge-3",
      expiresAt: "2026-07-29T18:05:00.000Z",
      now: "2026-07-29T18:00:00.000Z",
      inputHash: "d".repeat(64),
    });
    const event: McpReadAuditEvent = {
      invocationId: "invocation-3",
      connectionId: "connection-3",
      actorId: "mcp-actor-3",
      siteId: referenceSiteDefinition.site.id,
      operation: "foundry.content.list",
      inputHash: "e".repeat(64),
      protocolVersion: "2025-11-25",
      scopesEvaluated: ["site.read"],
      outcome: "allowed",
      reason: null,
      occurredAt: "2026-07-29T18:02:00.000Z",
      contractVersion: mcpContractVersion,
    };
    await store.recordInvocation(event);

    await expect(
      database
        .prepare(
          `SELECT invocation_id, actor_id, operation, input_hash,
                  protocol_version, scopes_json, outcome, reason,
                  contract_version
           FROM mcp_audit_events WHERE invocation_id = ?1`,
        )
        .bind(event.invocationId)
        .first(),
    ).resolves.toEqual({
      invocation_id: "invocation-3",
      actor_id: "mcp-actor-3",
      operation: "foundry.content.list",
      input_hash: "e".repeat(64),
      protocol_version: "2025-11-25",
      scopes_json: '["site.read"]',
      outcome: "allowed",
      reason: null,
      contract_version: "foundry.mcp.v1",
    });
  });

  it("rotates refresh tokens once and revokes the whole grant on reuse", async () => {
    const store = createD1McpConnectionStore(database);
    await store.createAuthorizationGrant({
      connectionId: "connection-refresh",
      actorId: "mcp-actor-refresh",
      siteId: referenceSiteDefinition.site.id,
      clientId: "https://client.example/metadata.json",
      redirectUri: "https://client.example/callback",
      ownerMembershipId: "membership-owner",
      codeHash: "code-hash-refresh",
      codeChallenge: "challenge-refresh",
      expiresAt: "2026-07-29T18:05:00.000Z",
      now: "2026-07-29T18:00:00.000Z",
      inputHash: "f".repeat(64),
    });
    await store.saveRefreshToken({
      tokenHash: "refresh-hash-1",
      familyId: "refresh-family-1",
      connectionId: "connection-refresh",
      clientId: "https://client.example/metadata.json",
      expiresAt: "2026-08-28T18:00:00.000Z",
      now: "2026-07-29T18:00:00.000Z",
    });

    await expect(
      store.rotateRefreshToken({
        tokenHash: "refresh-hash-1",
        nextTokenHash: "refresh-hash-2",
        clientId: "https://client.example/metadata.json",
        nextExpiresAt: "2026-08-28T18:01:00.000Z",
        now: "2026-07-29T18:01:00.000Z",
      }),
    ).resolves.toEqual({
      state: "rotated",
      connection: expect.objectContaining({
        connectionId: "connection-refresh",
        status: "active",
      }),
    });
    await expect(
      store.rotateRefreshToken({
        tokenHash: "refresh-hash-1",
        nextTokenHash: "refresh-hash-3",
        clientId: "https://client.example/metadata.json",
        nextExpiresAt: "2026-08-28T18:02:00.000Z",
        now: "2026-07-29T18:02:00.000Z",
      }),
    ).resolves.toEqual({ state: "reuse_detected" });
    await expect(
      store.findCurrentConnection({
        siteId: referenceSiteDefinition.site.id,
        connectionId: "connection-refresh",
      }),
    ).resolves.toEqual(expect.objectContaining({ status: "revoked" }));
  });

  it("atomically enforces bounded rate buckets", async () => {
    const store = createD1McpConnectionStore(database);
    const input = {
      siteId: referenceSiteDefinition.site.id,
      bucketKey: "connection:tool",
      windowStartedAt: "2026-07-29T18:00:00.000Z",
      limit: 2,
    };
    await expect(store.consumeRateLimit(input)).resolves.toBe(true);
    await expect(store.consumeRateLimit(input)).resolves.toBe(true);
    await expect(store.consumeRateLimit(input)).resolves.toBe(false);
  });
});
