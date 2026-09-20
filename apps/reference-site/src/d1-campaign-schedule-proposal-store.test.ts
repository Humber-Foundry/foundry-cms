import { beforeEach, describe, expect, it } from "vitest";

import {
  createCampaignId,
  createCampaignRevisionId,
  type CampaignScheduleProposal,
  type McpCampaignOperationAuthority,
} from "@humber-foundry/application";
import { createSiteId } from "@humber-foundry/site-definition";

import { createD1CampaignScheduleProposalStore } from "./d1-campaign-schedule-proposal-store";
import {
  migrationStatements,
  useMigratedTestDatabase,
} from "./test-support/migrated-test-database";

/**
 * The D1 statements behind a campaign schedule request.
 *
 * Every rule the application applies is checked here again, so neither the
 * application check nor the SQL check stands alone. See ADR-0039.
 */

const siteId = createSiteId("site_reference");
const campaignId = createCampaignId("20000000-0000-4000-8000-000000000061");
const revisionId = createCampaignRevisionId(
  "30000000-0000-4000-8000-000000000061",
);
const { database } = useMigratedTestDatabase([
  "0001_human_access.sql",
  "0002_subscriber_ledger.sql",
  "0005_content_revisions.sql",
  "0007_content_publication.sql",
  "0008_media_assets.sql",
  "0009_content_publication_history_evidence.sql",
  "0010_content_publication_restore_identity.sql",
  "0011_blog_post_transition_audit.sql",
  "0012_content_approval_revision_hash.sql",
  "0013_blog_post_verified_state.sql",
  "0014_blog_post_artifact_fingerprints.sql",
  "0015_blog_post_render_artifacts.sql",
  "0016_campaign_authoring.sql",
  "0017_mcp_readonly_connections.sql",
  "0018_mcp_draft_scopes.sql",
  "0022_blog_post_scheduling_archive.sql",
  "0024_mcp_publication_scopes.sql",
  "0035_campaign_schedule_proposals.sql",
  "0036_mcp_connection_scopes_complete.sql",
]);

const now = "2026-08-01T00:10:00.000Z";

function proposal(
  overrides: Partial<CampaignScheduleProposal> = {},
): CampaignScheduleProposal {
  return {
    id: "schedule_request_61",
    siteId,
    campaignId,
    campaignRevisionId: revisionId,
    campaignVersion: 1,
    localDateTime: "2026-09-20T10:00:00",
    ianaTimeZone: "America/Vancouver",
    utcOffsetChoice: "-07:00",
    executeAtUtc: "2026-09-20T17:00:00.000Z",
    timeZoneDatabaseVersion: "2026a",
    createdBy: "mcp-agent-61",
    createdAt: now,
    ...overrides,
  };
}

const authority: McpCampaignOperationAuthority = Object.freeze({
  kind: "mcp",
  connectionId: "connection-61",
  actorId: "agent-61",
  operation: "foundry.campaign.schedule_request",
  requiredScopes: ["publication.schedule"],
});

beforeEach(async () => {
  const seed = `
    INSERT INTO human_users (id, email, created_at)
    VALUES
      ('user-owner', 'owner@example.test', '2026-08-01T00:00:00.000Z'),
      ('user-reader', 'reader@example.test', '2026-08-01T00:00:00.000Z');
    INSERT INTO human_memberships (
      id, site_id, user_id, email, identity_issuer, identity_subject,
      role, status, created_at, updated_at
    ) VALUES
      (
        'membership-owner', 'site_reference', 'user-owner',
        'owner@example.test', 'https://access.example', 'owner',
        'owner', 'active', '2026-08-01T00:00:00.000Z',
        '2026-08-01T00:00:00.000Z'
      ),
      (
        'membership-removed', 'site_reference', 'user-reader',
        'reader@example.test', 'https://access.example', 'reader',
        'editor', 'revoked', '2026-08-01T00:00:00.000Z',
        '2026-08-01T00:00:00.000Z'
      );
    INSERT INTO campaigns (
      id, site_id, lifecycle_state, current_revision_id,
      version, created_at, updated_at
    ) VALUES (
      '20000000-0000-4000-8000-000000000061', 'site_reference',
      'draft', '30000000-0000-4000-8000-000000000061', 1,
      '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'
    );
    INSERT INTO campaign_revisions (
      id, site_id, campaign_id, revision_number, revision_json, created_at
    ) VALUES (
      '30000000-0000-4000-8000-000000000061', 'site_reference',
      '20000000-0000-4000-8000-000000000061', 1, '{}',
      '2026-08-01T00:00:00.000Z'
    );
    INSERT INTO mcp_connections (
      id, actor_id, site_id, oauth_client_id, redirect_uri,
      scopes_json, status, created_by_membership_id, created_at
    ) VALUES
      (
        'connection-61', 'agent-61', 'site_reference', 'client-61',
        'https://client.example/callback', '["site.read"]', 'active',
        'membership-owner', '2026-08-01T00:00:00.000Z'
      ),
      (
        'connection-62', 'agent-62', 'site_reference', 'client-62',
        'https://client.example/callback', '["site.read"]', 'active',
        'membership-owner', '2026-08-01T00:00:00.000Z'
      ),
      (
        'connection-63', 'agent-63', 'site_reference', 'client-63',
        'https://client.example/callback', '["site.read"]', 'revoked',
        'membership-owner', '2026-08-01T00:00:00.000Z'
      );
    INSERT INTO mcp_connection_scopes (connection_id, scope)
    VALUES
      ('connection-61', 'site.read'),
      ('connection-61', 'publication.schedule'),
      ('connection-62', 'site.read'),
      ('connection-62', 'campaign.draft'),
      ('connection-63', 'site.read'),
      ('connection-63', 'publication.schedule');
  `;
  for (const statement of migrationStatements(seed)) {
    await database.exec(statement);
  }
});

describe("the campaign schedule request store", () => {
  it("records a request an authorized connection made", async () => {
    const store = createD1CampaignScheduleProposalStore(database);
    const saved = await store.save(proposal(), "request-61", authority);
    expect(saved.id).toBe("schedule_request_61");
    expect(
      await store.findByRequest({
        siteId,
        campaignId,
        idempotencyKey: "request-61",
      }),
    ).toMatchObject({ id: "schedule_request_61", createdBy: "mcp-agent-61" });
    expect(
      await store.findNewestUndeclined({ siteId, campaignId }),
    ).toMatchObject({ id: "schedule_request_61" });
    expect(
      (await store.listNewestUndeclined({ siteId })).map(({ id }) => id),
    ).toStrictEqual(["schedule_request_61"]);
  });

  it("replays the same key instead of writing a second request", async () => {
    const store = createD1CampaignScheduleProposalStore(database);
    const first = await store.save(proposal(), "request-61", authority);
    const second = await store.save(
      proposal({ id: "schedule_request_other" }),
      "request-61",
      authority,
    );
    expect(second.id).toBe(first.id);
  });

  it("refuses a connection that holds a different permission", async () => {
    const store = createD1CampaignScheduleProposalStore(database);
    await expect(
      store.save(proposal(), "request-62", {
        ...authority,
        connectionId: "connection-62",
        actorId: "agent-62",
      }),
    ).rejects.toMatchObject({ code: "mcp_schedule_authority_required" });
  });

  it("refuses a connection the Owner has revoked", async () => {
    const store = createD1CampaignScheduleProposalStore(database);
    await expect(
      store.save(proposal(), "request-63", {
        ...authority,
        connectionId: "connection-63",
        actorId: "agent-63",
      }),
    ).rejects.toMatchObject({ code: "mcp_schedule_authority_required" });
  });

  it("refuses a connection that evaluated a permission it does not hold", async () => {
    const store = createD1CampaignScheduleProposalStore(database);
    await expect(
      store.save(proposal(), "request-64", {
        ...authority,
        requiredScopes: ["publication.schedule", "publication.publish"],
      }),
    ).rejects.toMatchObject({ code: "mcp_schedule_authority_required" });
  });

  it("refuses a person who is not an active Owner or Editor", async () => {
    const store = createD1CampaignScheduleProposalStore(database);
    await expect(
      store.save(
        proposal({ createdBy: "membership-removed" }),
        "request-65",
        undefined,
      ),
    ).rejects.toMatchObject({ code: "human_authority_required" });
  });

  it("lets an active Owner ask directly", async () => {
    const store = createD1CampaignScheduleProposalStore(database);
    const saved = await store.save(
      proposal({ createdBy: "membership-owner" }),
      "request-66",
      undefined,
    );
    expect(saved.createdBy).toBe("membership-owner");
  });

  it("stops reporting a request a person declined, and declining twice is safe", async () => {
    const store = createD1CampaignScheduleProposalStore(database);
    await store.save(proposal(), "request-61", authority);
    const declined = await store.decline({
      siteId,
      proposalId: "schedule_request_61",
      idempotencyKey: "decline-61",
      declinedBy: "membership-owner",
      occurredAt: now,
    });
    expect(declined.id).toBe("schedule_request_61");
    expect(
      await store.findNewestUndeclined({ siteId, campaignId }),
    ).toBeNull();
    expect(await store.listNewestUndeclined({ siteId })).toStrictEqual([]);
    const again = await store.decline({
      siteId,
      proposalId: "schedule_request_61",
      idempotencyKey: "decline-61-again",
      declinedBy: "membership-owner",
      occurredAt: now,
    });
    expect(again.id).toBe("schedule_request_61");
  });

  it("refuses a decline from anyone who is not an active Owner or Editor", async () => {
    const store = createD1CampaignScheduleProposalStore(database);
    await store.save(proposal(), "request-61", authority);
    await expect(
      store.decline({
        siteId,
        proposalId: "schedule_request_61",
        idempotencyKey: "decline-61",
        declinedBy: "membership-removed",
        occurredAt: now,
      }),
    ).rejects.toMatchObject({ code: "human_authority_required" });
    expect(
      await store.findNewestUndeclined({ siteId, campaignId }),
    ).toMatchObject({ id: "schedule_request_61" });
  });

  it("keeps a request and a decline immutable once written", async () => {
    const store = createD1CampaignScheduleProposalStore(database);
    await store.save(proposal(), "request-61", authority);
    await store.decline({
      siteId,
      proposalId: "schedule_request_61",
      idempotencyKey: "decline-61",
      declinedBy: "membership-owner",
      occurredAt: now,
    });
    await expect(
      database
        .prepare(
          `UPDATE campaign_schedule_proposals SET execute_at_utc = ?1
           WHERE id = ?2`,
        )
        .bind("2026-10-01T17:00:00.000Z", "schedule_request_61")
        .run(),
    ).rejects.toThrow(/campaign_schedule_proposal_is_immutable/u);
    await expect(
      database
        .prepare(
          `DELETE FROM campaign_schedule_proposal_declines
           WHERE proposal_id = ?1`,
        )
        .bind("schedule_request_61")
        .run(),
    ).rejects.toThrow(/campaign_schedule_proposal_decline_is_immutable/u);
  });

  it("reports only the newest undeclined request for a campaign", async () => {
    const store = createD1CampaignScheduleProposalStore(database);
    await store.save(proposal(), "request-61", authority);
    await store.save(
      proposal({
        id: "schedule_request_61b",
        createdAt: "2026-08-01T00:20:00.000Z",
        localDateTime: "2026-09-21T10:00:00",
        executeAtUtc: "2026-09-21T17:00:00.000Z",
      }),
      "request-61b",
      authority,
    );
    expect(
      await store.findNewestUndeclined({ siteId, campaignId }),
    ).toMatchObject({ id: "schedule_request_61b" });
    expect(
      (await store.listNewestUndeclined({ siteId })).map(({ id }) => id),
    ).toStrictEqual(["schedule_request_61b"]);
  });

  it("names no address in anything it stores or answers with", async () => {
    const store = createD1CampaignScheduleProposalStore(database);
    const saved = await store.save(proposal(), "request-61", authority);
    expect(JSON.stringify(saved)).not.toContain("@");
    const rows = await database
      .prepare(`SELECT * FROM campaign_schedule_proposals`)
      .all<Record<string, unknown>>();
    expect(JSON.stringify(rows.results)).not.toContain("@");
  });
});
