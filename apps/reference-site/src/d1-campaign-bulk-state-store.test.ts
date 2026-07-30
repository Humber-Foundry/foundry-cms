import { readdir, readFile } from "node:fs/promises";

import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  campaignDeliveryAttemptedEventTypes,
  createCampaignId,
  createCampaignRevisionId,
  type CampaignBulkAuthorization,
  type CampaignBulkSendArtifact,
  type CampaignBulkSendOperation,
} from "@foundry/application";
import { createSiteId } from "@foundry/site-definition";

import { createD1CampaignBulkStateStore } from "./d1-campaign-bulk-state-store";
import type { D1DatabaseBinding } from "./d1-human-access-store";

let runtime: Miniflare;
let database: Awaited<ReturnType<Miniflare["getD1Database"]>>;
const siteId = createSiteId("site_reference");
const campaignId = createCampaignId("20000000-0000-4000-8000-000000000052");
const revisionId = createCampaignRevisionId(
  "30000000-0000-4000-8000-000000000052",
);
const testExecutionId = "40000000-0000-4000-8000-000000000052";

function migrationStatements(migration: string) {
  const statements: string[] = [];
  let current = "";
  let inTrigger = false;
  for (const line of migration.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    current += ` ${trimmed}`;
    if (trimmed.startsWith("CREATE TRIGGER")) inTrigger = true;
    if (
      (!inTrigger && trimmed.endsWith(";")) ||
      (inTrigger && trimmed === "END;")
    ) {
      statements.push(current.trim());
      current = "";
      inTrigger = false;
    }
  }
  return statements;
}

beforeEach(async () => {
  runtime = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    d1Databases: ["FOUNDRY_DB"],
  });
  database = await runtime.getD1Database("FOUNDRY_DB");
  for (const name of [
    "0001_human_access.sql",
    "0002_subscriber_ledger.sql",
    "0016_campaign_authoring.sql",
    "0021_campaign_test_delivery.sql",
    "0023_campaign_bulk_delivery.sql",
  ]) {
    const migration = await readFile(
      new URL(`../migrations/${name}`, import.meta.url),
      "utf8",
    );
    for (const statement of migrationStatements(migration)) {
      await database.exec(statement);
    }
  }
  const seed = `
    INSERT INTO human_users (id, email, created_at)
    VALUES
      ('user-owner', 'owner@example.test', '2026-08-01T00:00:00.000Z'),
      ('user-editor', 'editor@example.test', '2026-08-01T00:00:00.000Z');
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
        'membership-editor', 'site_reference', 'user-editor',
        'editor@example.test', 'https://access.example', 'editor',
        'editor', 'active', '2026-08-01T00:00:00.000Z',
        '2026-08-01T00:00:00.000Z'
      );
    INSERT INTO campaigns (
      id, site_id, lifecycle_state, current_revision_id,
      version, created_at, updated_at
    ) VALUES (
      '20000000-0000-4000-8000-000000000052', 'site_reference',
      'draft', '30000000-0000-4000-8000-000000000052', 1,
      '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'
    );
    INSERT INTO campaign_revisions (
      id, site_id, campaign_id, revision_number, revision_json, created_at
    ) VALUES (
      '30000000-0000-4000-8000-000000000052', 'site_reference',
      '20000000-0000-4000-8000-000000000052', 1, '{}',
      '2026-08-01T00:00:00.000Z'
    );
    INSERT INTO campaign_test_deliveries (
      execution_id, site_id, actor_id, request_id, campaign_id,
      campaign_revision_id, binding_json, recipient_ids_json, state,
      attempt_number, attempt_lease_until, provider_campaign_id,
      provider_message_id, foundry_send_proof, failure_code, evidence_json,
      created_at, updated_at
    ) VALUES (
      '40000000-0000-4000-8000-000000000052', 'site_reference',
      'membership-editor', 'test-request-52',
      '20000000-0000-4000-8000-000000000052',
      '30000000-0000-4000-8000-000000000052',
      '{"campaignFingerprint":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","htmlFingerprint":"1111111111111111111111111111111111111111111111111111111111111111","textFingerprint":"2222222222222222222222222222222222222222222222222222222222222222","senderFingerprint":"3333333333333333333333333333333333333333333333333333333333333333","providerConfigurationFingerprint":"4444444444444444444444444444444444444444444444444444444444444444"}',
      '["membership-owner"]', 'accepted', 1, NULL, 'test-provider-52',
      'test-message-52',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      NULL,
      '{"providerCampaignId":"test-provider-52","providerMessageId":"test-message-52","providerReceiptHash":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}',
      '2026-08-01T00:01:00.000Z', '2026-08-01T00:01:00.000Z'
    );
    INSERT INTO campaign_test_receipt_confirmations (
      execution_id, site_id, owner_actor_id, request_id, confirmed_at
    ) VALUES (
      '40000000-0000-4000-8000-000000000052', 'site_reference',
      'membership-owner', 'confirm-request-52',
      '2026-08-01T00:02:00.000Z'
    );
    INSERT INTO subscribers (
      id, site_id, identity_key, email, state, created_at, updated_at
    ) VALUES (
      'subscriber-52', 'site_reference',
      'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      'subscriber@example.test', 'active',
      '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'
    );
  `;
  for (const statement of migrationStatements(seed)) {
    await database.exec(statement);
  }
});

afterEach(async () => runtime.dispose());

function authorization(
  ownerActorId = "membership-owner",
): CampaignBulkAuthorization {
  return {
    id: "50000000-0000-4000-8000-000000000052",
    siteId,
    campaignId,
    campaignRevisionId: revisionId,
    campaignFingerprint: "a".repeat(64),
    testExecutionId,
    testProviderReceiptHash: "c".repeat(64),
    testHtmlFingerprint: "1".repeat(64),
    testTextFingerprint: "2".repeat(64),
    testSenderFingerprint: "3".repeat(64),
    testProviderConfigurationFingerprint: "4".repeat(64),
    authorizationFingerprint: "e".repeat(64),
    ownerActorId,
    state: "active",
    authorizedAt: "2026-08-01T00:03:00.000Z",
    invalidatedAt: null,
  };
}

function sendOperation(): CampaignBulkSendOperation {
  return {
    id: "60000000-0000-4000-8000-000000000052",
    siteId,
    campaignId,
    campaignRevisionId: revisionId,
    authorizationId: authorization().id,
    scheduleId: null,
    scheduledInstant: null,
    stableSendKey: "2".repeat(64),
    state: "preparing",
    attempt: 0,
    leaseToken: null,
    leaseExpiresAt: null,
    audienceSnapshot: null,
    sendArtifact: null,
    sendArtifactHash: null,
    sendArtifactCommitSha: null,
    providerCampaignId: null,
    providerMessageId: null,
    providerSendProof: null,
    providerVerification: null,
    detail: null,
    createdAt: "2026-08-01T00:04:00.000Z",
    updatedAt: "2026-08-01T00:04:00.000Z",
  };
}

function audienceSnapshot() {
  return {
    id: "70000000-0000-4000-8000-000000000052",
    fingerprint: "4".repeat(64),
    subscriberIds: ["subscriber-52"],
    recipients: [
      {
        subscriberId: "subscriber-52",
        identityKey: "d".repeat(64),
        address: "subscriber@example.test",
      },
    ],
    recipientCount: 1,
    resolvedAt: "2026-08-01T00:04:02.000Z",
  };
}

function sendArtifact(
  operationId = "60000000-0000-4000-8000-000000000052",
): CampaignBulkSendArtifact {
  return {
    version: "foundry.campaign-bulk-send-artifact.v2",
    operationId,
    stableSendKey: "2".repeat(64),
    siteId,
    campaignId,
    campaignRevisionId: revisionId,
    authorizationId: authorization().id,
    authorizationFingerprint: "e".repeat(64),
    campaignFingerprint: "a".repeat(64),
    senderIdentityId: "sender_primary",
    sender: {
      email: "sender@example.test",
      name: "Foundry Sender",
    },
    senderFingerprint: "3".repeat(64),
    providerConfigurationFingerprint: "4".repeat(64),
    complianceVersion: "footer-v1",
    audienceDefinition: {
      id: "canonical-consent-and-suppression",
      version: 1,
    },
    scheduledInstant: null,
    recipientCount: 1,
    subject: "Exact subject",
    htmlContent: "<p>Exact body</p>",
    textContent: "Exact body",
    htmlFingerprint: "1".repeat(64),
    textFingerprint: "2".repeat(64),
    audienceFingerprint: "4".repeat(64),
  };
}

describe("D1 campaign bulk state store", () => {
  it("agrees with the application about which events prove a send was attempted", async () => {
    // The rule lives in three places: the application, this store's SQL, and
    // the bulk-delivery migration's durable guard. If they disagree, the
    // application and the database disagree about when a send is sent, so pin
    // them together. The migration is found by content rather than by name so
    // renumbering it cannot quietly drop it from this pin.
    const expected = [...campaignDeliveryAttemptedEventTypes].sort();
    const migrationsDirectory = new URL("../migrations/", import.meta.url);
    const migrations = await Promise.all(
      (await readdir(migrationsDirectory))
        .filter((name) => name.endsWith(".sql"))
        .map(async (name) =>
          readFile(new URL(name, migrationsDirectory), "utf8"),
        ),
    );
    const bulkMigrations = migrations.filter((migration) =>
      migration.includes("CREATE TABLE campaign_bulk_send_operations"),
    );
    expect(bulkMigrations).toHaveLength(1);
    const sources = [
      await readFile(
        new URL("./d1-campaign-bulk-state-store.ts", import.meta.url),
        "utf8",
      ),
      ...bulkMigrations,
    ];

    for (const source of sources) {
      const lists = [
        ...source.matchAll(/\b[a-z_]+\.event_type IN \(([^)]*)\)/gu),
      ].map(([, body]) =>
        [...body.matchAll(/'([a-z_]+)'/gu)].map(([, type]) => type).sort(),
      );
      expect(lists.length).toBeGreaterThan(0);
      for (const list of lists) {
        expect(list).toEqual(expected);
      }
    }
  });


  it("atomically fences authorization to the current confirmed Owner test", async () => {
    const store = createD1CampaignBulkStateStore(
      database as unknown as D1DatabaseBinding,
    );
    await expect(
      store.saveAuthorization({
        requestId: "bulk-editor-authorization-52",
        inputHash: "f".repeat(64),
        authorization: authorization("membership-editor"),
      }),
    ).rejects.toMatchObject({
      name: "CampaignBulkDeliveryError",
      code: "bulk_test_stale",
    });

    const saved = await store.saveAuthorization({
      requestId: "bulk-owner-authorization-52",
      inputHash: "1".repeat(64),
      authorization: authorization(),
    });
    expect(saved).toMatchObject({
      replayed: false,
      value: {
        ownerActorId: "membership-owner",
        campaignRevisionId: revisionId,
      },
    });
    await expect(
      store.saveAuthorization({
        requestId: "bulk-owner-authorization-52",
        inputHash: "2".repeat(64),
        authorization: authorization(),
      }),
    ).rejects.toMatchObject({ code: "bulk_idempotency_key_reused" });
  });

  it("rechecks active suppressions in the same write that opens the provider attempt", async () => {
    const store = createD1CampaignBulkStateStore(
      database as unknown as D1DatabaseBinding,
    );
    await store.saveAuthorization({
      requestId: "bulk-owner-authorization-52",
      inputHash: "1".repeat(64),
      authorization: authorization(),
    });
    const operationValue: CampaignBulkSendOperation = {
      id: "60000000-0000-4000-8000-000000000052",
      siteId,
      campaignId,
      campaignRevisionId: revisionId,
      authorizationId: authorization().id,
      scheduleId: null,
      scheduledInstant: null,
      stableSendKey: "2".repeat(64),
      state: "preparing",
      attempt: 0,
      leaseToken: null,
      leaseExpiresAt: null,
      audienceSnapshot: null,
      sendArtifact: null,
      sendArtifactHash: null,
      sendArtifactCommitSha: null,
      providerCampaignId: null,
      providerMessageId: null,
      providerSendProof: null,
      providerVerification: null,
      detail: null,
      createdAt: "2026-08-01T00:04:00.000Z",
      updatedAt: "2026-08-01T00:04:00.000Z",
    };
    await store.createSendOperation({
      requestId: "bulk-send-operation-0052",
      inputHash: "3".repeat(64),
      operation: operationValue,
    });
    await expect(
      database
        .prepare(
          `UPDATE campaign_bulk_send_operations
         SET stable_send_key = ?1
         WHERE id = ?2`,
        )
        .bind("9".repeat(64), operationValue.id)
        .run(),
    ).rejects.toThrow(/campaign_bulk_send_operation_identity_is_immutable/u);
    const claimed = await store.claimOperation({
      siteId,
      operationId: operationValue.id,
      expectedCampaignRevisionId: revisionId,
      expectedOwnerActorId: "membership-owner",
      heldLeaseToken: null,
      now: "2026-08-01T00:04:01.000Z",
      leaseToken: "lease-52",
      leaseExpiresAt: "2026-08-01T00:09:01.000Z",
    });
    const withSnapshot = await store.saveAudienceSnapshot({
      operation: claimed!,
      snapshot: {
        id: "70000000-0000-4000-8000-000000000052",
        fingerprint: "4".repeat(64),
        subscriberIds: ["subscriber-52"],
        recipients: [
          {
            subscriberId: "subscriber-52",
            identityKey: "d".repeat(64),
            address: "subscriber@example.test",
          },
        ],
        recipientCount: 1,
        resolvedAt: "2026-08-01T00:04:02.000Z",
      },
      sendArtifact: sendArtifact(),
      sendArtifactHash: "6".repeat(64),
      now: "2026-08-01T00:04:02.000Z",
    });
    await database
      .prepare(
        `UPDATE subscribers
       SET state = 'unsubscribed', updated_at = ?1
       WHERE id = 'subscriber-52'`,
      )
      .bind("2026-08-01T00:04:03.000Z")
      .run();

    await expect(
      store.beginProviderAttempt({
        operation: withSnapshot!,
        activeSubscriberIds: ["subscriber-52"],
        providerCampaignId: "provider-campaign-52",
        providerSendProof: "5".repeat(64),
        now: "2026-08-01T00:04:04.000Z",
      }),
    ).resolves.toBeNull();
  });

  it("requires immutable poll verification plus complete authenticated webhook evidence before sent", async () => {
    const store = createD1CampaignBulkStateStore(
      database as unknown as D1DatabaseBinding,
    );
    await store.saveAuthorization({
      requestId: "bulk-owner-authorization-52",
      inputHash: "1".repeat(64),
      authorization: authorization(),
    });
    const operationValue: CampaignBulkSendOperation = {
      id: "60000000-0000-4000-8000-000000000052",
      siteId,
      campaignId,
      campaignRevisionId: revisionId,
      authorizationId: authorization().id,
      scheduleId: null,
      scheduledInstant: null,
      stableSendKey: "2".repeat(64),
      state: "preparing",
      attempt: 0,
      leaseToken: null,
      leaseExpiresAt: null,
      audienceSnapshot: null,
      sendArtifact: null,
      sendArtifactHash: null,
      sendArtifactCommitSha: null,
      providerCampaignId: null,
      providerMessageId: null,
      providerSendProof: null,
      providerVerification: null,
      detail: null,
      createdAt: "2026-08-01T00:04:00.000Z",
      updatedAt: "2026-08-01T00:04:00.000Z",
    };
    await store.createSendOperation({
      requestId: "bulk-send-operation-0052",
      inputHash: "3".repeat(64),
      operation: operationValue,
    });
    const claimed = await store.claimOperation({
      siteId,
      operationId: operationValue.id,
      expectedCampaignRevisionId: revisionId,
      expectedOwnerActorId: "membership-owner",
      heldLeaseToken: null,
      now: "2026-08-01T00:04:01.000Z",
      leaseToken: "lease-52",
      leaseExpiresAt: "2026-08-01T00:09:01.000Z",
    });
    const withSnapshot = await store.saveAudienceSnapshot({
      operation: claimed!,
      snapshot: {
        id: "70000000-0000-4000-8000-000000000052",
        fingerprint: "4".repeat(64),
        subscriberIds: ["subscriber-52"],
        recipients: [
          {
            subscriberId: "subscriber-52",
            identityKey: "d".repeat(64),
            address: "subscriber@example.test",
          },
        ],
        recipientCount: 1,
        resolvedAt: "2026-08-01T00:04:02.000Z",
      },
      sendArtifact: sendArtifact(),
      sendArtifactHash: "6".repeat(64),
      now: "2026-08-01T00:04:02.000Z",
    });
    const published = await store.recordArtifactPublication({
      operation: withSnapshot!,
      outcome: { outcome: "committed", commitSha: "7".repeat(40) },
      now: "2026-08-01T00:04:03.000Z",
    });
    const attempting = await store.beginProviderAttempt({
      operation: published,
      activeSubscriberIds: ["subscriber-52"],
      providerCampaignId: "provider-campaign-52",
      providerSendProof: "5".repeat(64),
      now: "2026-08-01T00:04:04.000Z",
    });
    const queued = await store.recordProviderOutcome({
      operation: attempting!,
      outcome: {
        outcome: "accepted",
        providerCampaignId: "provider-campaign-52",
        providerMessageId: "provider-message-52",
      },
      now: "2026-08-01T00:04:05.000Z",
    });
    await expect(
      database
        .prepare(
          `UPDATE campaign_bulk_send_operations
           SET state = 'sent', provider_verification_json = '{}'
           WHERE id = ?1`,
        )
        .bind(operationValue.id)
        .run(),
    ).rejects.toThrow(/campaign_bulk_provider_evidence_incomplete/u);
    await expect(
      database
        .prepare(
          `UPDATE campaign_bulk_send_operations
           SET state = 'sent',
             provider_verification_json =
               '{"providerMessageIds":[""],"verifiedAt":"2026-08-01T00:04:06.000Z"}'
           WHERE id = ?1`,
        )
        .bind(operationValue.id)
        .run(),
    ).rejects.toThrow(/campaign_bulk_provider_evidence_incomplete/u);
    await expect(
      store.recordProviderOutcome({
        operation: queued,
        outcome: {
          outcome: "verified",
          providerCampaignId: "provider-campaign-52",
          providerMessageIds: [""],
        },
        now: "2026-08-01T00:04:06.000Z",
      }),
    ).rejects.toMatchObject({ code: "bulk_provider_evidence_invalid" });
    const verified = await store.recordProviderOutcome({
      operation: queued,
      outcome: {
        outcome: "verified",
        providerCampaignId: "provider-campaign-52",
        providerMessageIds: ["provider-message-52"],
      },
      now: "2026-08-01T00:04:06.000Z",
    });
    expect(verified.providerVerification).toEqual({
      providerMessageIds: ["provider-message-52"],
      verifiedAt: "2026-08-01T00:04:06.000Z",
    });
    await expect(
      database
        .prepare(
          `UPDATE campaign_bulk_send_operations
           SET state = 'sent' WHERE id = ?1`,
        )
        .bind(operationValue.id)
        .run(),
    ).rejects.toThrow(/campaign_bulk_provider_evidence_incomplete/u);

    await store.recordEvent({
      eventId: "8".repeat(64),
      payloadFingerprint: "9".repeat(64),
      siteId,
      operationId: operationValue.id,
      providerCampaignId: "provider-campaign-52",
      providerMessageId: "provider-message-52",
      providerSendProof: "5".repeat(64),
      recipientIdentityKey: "d".repeat(64),
      type: "accepted",
      occurredAt: "2026-08-01T00:04:05.000Z",
      receivedAt: "2026-08-01T00:04:07.000Z",
      source: "webhook",
    });
    await expect(
      store.confirmProviderAcceptance({
        siteId,
        operationId: operationValue.id,
        providerCampaignId: "provider-campaign-52",
        providerMessageIds: ["provider-message-52"],
        now: "2026-08-01T00:04:08.000Z",
      }),
    ).resolves.toMatchObject({ state: "sent" });
  });

  it("continues bounded claim-next processing after the oldest schedule is missed", async () => {
    const store = createD1CampaignBulkStateStore(
      database as unknown as D1DatabaseBinding,
    );
    await store.saveAuthorization({
      requestId: "bulk-owner-authorization-52",
      inputHash: "1".repeat(64),
      authorization: authorization(),
    });
    const secondCampaignId = createCampaignId(
      "20000000-0000-4000-8000-000000000053",
    );
    const secondRevisionId = createCampaignRevisionId(
      "30000000-0000-4000-8000-000000000053",
    );
    const secondTestExecutionId = "40000000-0000-4000-8000-000000000053";
    const secondSetup = `
      INSERT INTO campaigns (
        id, site_id, lifecycle_state, current_revision_id,
        version, created_at, updated_at
      ) VALUES (
        '${secondCampaignId}', 'site_reference', 'draft',
        '${secondRevisionId}', 1,
        '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'
      );
      INSERT INTO campaign_revisions (
        id, site_id, campaign_id, revision_number, revision_json, created_at
      ) VALUES (
        '${secondRevisionId}', 'site_reference', '${secondCampaignId}',
        1, '{}', '2026-08-01T00:00:00.000Z'
      );
      INSERT INTO campaign_test_deliveries (
        execution_id, site_id, actor_id, request_id, campaign_id,
        campaign_revision_id, binding_json, recipient_ids_json, state,
        attempt_number, attempt_lease_until, provider_campaign_id,
        provider_message_id, foundry_send_proof, failure_code, evidence_json,
        created_at, updated_at
      ) VALUES (
        '${secondTestExecutionId}', 'site_reference', 'membership-editor',
        'test-request-53', '${secondCampaignId}', '${secondRevisionId}',
        '{"campaignFingerprint":"${"a".repeat(64)}","htmlFingerprint":"${"1".repeat(64)}","textFingerprint":"${"2".repeat(64)}","senderFingerprint":"${"3".repeat(64)}","providerConfigurationFingerprint":"${"4".repeat(64)}"}',
        '["membership-owner"]', 'accepted', 1, NULL, 'test-provider-53',
        'test-message-53', '${"b".repeat(64)}', NULL,
        '{"providerCampaignId":"test-provider-53","providerMessageId":"test-message-53","providerReceiptHash":"${"c".repeat(64)}"}',
        '2026-08-01T00:01:00.000Z', '2026-08-01T00:01:00.000Z'
      );
      INSERT INTO campaign_test_receipt_confirmations (
        execution_id, site_id, owner_actor_id, request_id, confirmed_at
      ) VALUES (
        '${secondTestExecutionId}', 'site_reference', 'membership-owner',
        'confirm-request-53', '2026-08-01T00:02:00.000Z'
      );
    `;
    for (const statement of migrationStatements(secondSetup)) {
      await database.exec(statement);
    }
    const secondAuthorization: CampaignBulkAuthorization = {
      ...authorization(),
      id: "50000000-0000-4000-8000-000000000053",
      campaignId: secondCampaignId,
      campaignRevisionId: secondRevisionId,
      testExecutionId: secondTestExecutionId,
      authorizationFingerprint: "f".repeat(64),
    };
    await store.saveAuthorization({
      requestId: "bulk-owner-authorization-53",
      inputHash: "2".repeat(64),
      authorization: secondAuthorization,
    });
    await store.activateSchedule({
      requestId: "bulk-stale-schedule-52",
      inputHash: "3".repeat(64),
      schedule: {
        id: "80000000-0000-4000-8000-000000000052",
        siteId,
        campaignId,
        authorizationId: authorization().id,
        localDateTime: "2026-08-01T00:00:00",
        ianaTimeZone: "UTC",
        utcOffsetChoice: "+00:00",
        executeAtUtc: "2026-08-01T00:00:00.000Z",
        timeZoneDatabaseVersion: "2026a",
        activatedBy: "membership-owner",
        state: "active",
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      },
    });
    await store.activateSchedule({
      requestId: "bulk-due-schedule-53",
      inputHash: "4".repeat(64),
      schedule: {
        id: "80000000-0000-4000-8000-000000000053",
        siteId,
        campaignId: secondCampaignId,
        authorizationId: secondAuthorization.id,
        localDateTime: "2026-08-01T00:10:00",
        ianaTimeZone: "UTC",
        utcOffsetChoice: "+00:00",
        executeAtUtc: "2026-08-01T00:10:00.000Z",
        timeZoneDatabaseVersion: "2026a",
        activatedBy: "membership-owner",
        state: "active",
        createdAt: "2026-08-01T00:03:00.000Z",
        updatedAt: "2026-08-01T00:03:00.000Z",
      },
    });

    await expect(
      store.claimDueSchedule({
        now: "2026-08-01T00:20:00.000Z",
        latenessCutoff: "2026-08-01T00:05:00.000Z",
        leaseToken: "lease-claim-next-53",
        leaseExpiresAt: "2026-08-01T00:25:00.000Z",
        createOperationId: () => "60000000-0000-4000-8000-000000000053",
      }),
    ).resolves.toMatchObject({
      campaignId: secondCampaignId,
      scheduleId: "80000000-0000-4000-8000-000000000053",
    });
    await expect(
      database
        .prepare(`SELECT state FROM campaign_bulk_schedules WHERE id = ?1`)
        .bind("80000000-0000-4000-8000-000000000052")
        .first<{ state: string }>(),
    ).resolves.toEqual({ state: "missed" });
  });

  it("invalidates pending authority, schedules, and operations with the campaign revision update", async () => {
    const store = createD1CampaignBulkStateStore(
      database as unknown as D1DatabaseBinding,
    );
    await store.saveAuthorization({
      requestId: "bulk-owner-authorization-52",
      inputHash: "1".repeat(64),
      authorization: authorization(),
    });
    await store.activateSchedule({
      requestId: "bulk-schedule-request-0052",
      inputHash: "2".repeat(64),
      schedule: {
        id: "80000000-0000-4000-8000-000000000052",
        siteId,
        campaignId,
        authorizationId: authorization().id,
        localDateTime: "2026-08-01T00:10:00",
        ianaTimeZone: "UTC",
        utcOffsetChoice: "+00:00",
        executeAtUtc: "2026-08-01T00:10:00.000Z",
        timeZoneDatabaseVersion: "2026a",
        activatedBy: "membership-owner",
        state: "active",
        createdAt: "2026-08-01T00:03:00.000Z",
        updatedAt: "2026-08-01T00:03:00.000Z",
      },
    });
    const edit = `
      INSERT INTO campaign_revisions (
        id, site_id, campaign_id, revision_number, revision_json, created_at
      ) VALUES (
        '30000000-0000-4000-8000-000000000099', 'site_reference',
        '20000000-0000-4000-8000-000000000052', 2, '{}',
        '2026-08-01T00:05:00.000Z'
      );
      UPDATE campaigns
      SET current_revision_id = '30000000-0000-4000-8000-000000000099',
          version = 2, updated_at = '2026-08-01T00:05:00.000Z'
      WHERE site_id = 'site_reference'
        AND id = '20000000-0000-4000-8000-000000000052';
    `;
    for (const statement of migrationStatements(edit)) {
      await database.exec(statement);
    }

    const rows = await database
      .prepare(
        `SELECT
         (SELECT state FROM campaign_bulk_authorizations LIMIT 1)
           AS authorization_state,
         (SELECT state FROM campaign_bulk_schedules LIMIT 1)
           AS schedule_state`,
      )
      .first<{
        authorization_state: string;
        schedule_state: string;
      }>();
    expect(rows).toEqual({
      authorization_state: "invalidated",
      schedule_state: "blocked",
    });
  });

  it("blocks a preparing send operation when the campaign revision changes", async () => {
    const store = createD1CampaignBulkStateStore(
      database as unknown as D1DatabaseBinding,
    );
    await store.saveAuthorization({
      requestId: "bulk-owner-authorization-52",
      inputHash: "1".repeat(64),
      authorization: authorization(),
    });
    await store.createSendOperation({
      requestId: "bulk-send-operation-0052",
      inputHash: "3".repeat(64),
      operation: sendOperation(),
    });

    const edit = `
      INSERT INTO campaign_revisions (
        id, site_id, campaign_id, revision_number, revision_json, created_at
      ) VALUES (
        '30000000-0000-4000-8000-000000000099', 'site_reference',
        '20000000-0000-4000-8000-000000000052', 2, '{}',
        '2026-08-01T00:05:00.000Z'
      );
      UPDATE campaigns
      SET current_revision_id = '30000000-0000-4000-8000-000000000099',
          version = 2, updated_at = '2026-08-01T00:05:00.000Z'
      WHERE site_id = 'site_reference'
        AND id = '20000000-0000-4000-8000-000000000052';
    `;
    for (const statement of migrationStatements(edit)) {
      await database.exec(statement);
    }

    // An operation left preparing could still be claimed and sent against a
    // revision the Owner never authorized, so the edit must block it too.
    await expect(
      database
        .prepare(
          `SELECT state, detail, lease_token
         FROM campaign_bulk_send_operations WHERE id = ?1`,
        )
        .bind(sendOperation().id)
        .first<{
          state: string;
          detail: string;
          lease_token: string | null;
        }>(),
    ).resolves.toEqual({
      state: "blocked",
      detail: "campaign_revision_changed",
      lease_token: null,
    });
    await expect(
      store.claimOperation({
        siteId,
        operationId: sendOperation().id,
        expectedCampaignRevisionId: revisionId,
        expectedOwnerActorId: "membership-owner",
        heldLeaseToken: null,
        now: "2026-08-01T00:06:00.000Z",
        leaseToken: "lease-after-edit",
        leaseExpiresAt: "2026-08-01T00:11:00.000Z",
      }),
    ).resolves.toBeNull();
  });

  it("invalidates bulk authority when the Owner loses it, in the same instant format", async () => {
    const store = createD1CampaignBulkStateStore(
      database as unknown as D1DatabaseBinding,
    );
    await store.saveAuthorization({
      requestId: "bulk-owner-authorization-52",
      inputHash: "1".repeat(64),
      authorization: authorization(),
    });
    await store.activateSchedule({
      requestId: "bulk-schedule-request-0052",
      inputHash: "2".repeat(64),
      schedule: {
        id: "80000000-0000-4000-8000-000000000052",
        siteId,
        campaignId,
        authorizationId: authorization().id,
        localDateTime: "2026-08-01T00:10:00",
        ianaTimeZone: "UTC",
        utcOffsetChoice: "+00:00",
        executeAtUtc: "2026-08-01T00:10:00.000Z",
        timeZoneDatabaseVersion: "2026a",
        activatedBy: "membership-owner",
        state: "active",
        createdAt: "2026-08-01T00:03:00.000Z",
        updatedAt: "2026-08-01T00:03:00.000Z",
      },
    });

    // A second Owner must exist first: D1 keeps at least one active Owner.
    await database
      .prepare(
        `INSERT INTO human_users (id, email, created_at)
       VALUES ('user-second-owner', 'second@example.test', ?1)`,
      )
      .bind("2026-08-01T00:05:00.000Z")
      .run();
    await database
      .prepare(
        `INSERT INTO human_memberships (
         id, site_id, user_id, email, identity_issuer, identity_subject,
         role, status, created_at, updated_at
       ) VALUES (
         'membership-second-owner', 'site_reference', 'user-second-owner',
         'second@example.test', 'https://access.example', 'second-owner',
         'owner', 'active', ?1, ?1
       )`,
      )
      .bind("2026-08-01T00:05:00.000Z")
      .run();
    await database
      .prepare(
        `UPDATE human_memberships
       SET role = 'editor', updated_at = ?1
       WHERE id = 'membership-owner'`,
      )
      .bind("2026-08-01T00:06:00.000Z")
      .run();

    const rows = await database
      .prepare(
        `SELECT
         (SELECT state FROM campaign_bulk_authorizations LIMIT 1)
           AS authorization_state,
         (SELECT invalidated_at FROM campaign_bulk_authorizations LIMIT 1)
           AS invalidated_at,
         (SELECT state FROM campaign_bulk_schedules LIMIT 1)
           AS schedule_state,
         (SELECT updated_at FROM campaign_bulk_schedules LIMIT 1)
           AS schedule_updated_at`,
      )
      .first<{
        authorization_state: string;
        invalidated_at: string;
        schedule_state: string;
        schedule_updated_at: string;
      }>();

    expect(rows).toMatchObject({
      authorization_state: "invalidated",
      schedule_state: "blocked",
    });
    // Every instant in this schema is compared and ordered as an ISO-8601
    // string, so a durable guard must write the same shape the application does.
    const isoInstant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
    expect(rows!.invalidated_at).toMatch(isoInstant);
    expect(rows!.schedule_updated_at).toMatch(isoInstant);
  });

  it("reports a losing concurrent authorization or send as an existing record", async () => {
    const store = createD1CampaignBulkStateStore(
      database as unknown as D1DatabaseBinding,
    );
    await store.saveAuthorization({
      requestId: "bulk-owner-authorization-52",
      inputHash: "1".repeat(64),
      authorization: authorization(),
    });

    await expect(
      store.saveAuthorization({
        requestId: "bulk-owner-authorization-52-second",
        inputHash: "9".repeat(64),
        authorization: {
          ...authorization(),
          id: "50000000-0000-4000-8000-000000000099",
          authorizationFingerprint: "8".repeat(64),
        },
      }),
    ).rejects.toMatchObject({
      name: "CampaignBulkDeliveryError",
      code: "bulk_authorization_exists",
    });

    await store.createSendOperation({
      requestId: "bulk-send-operation-0052",
      inputHash: "3".repeat(64),
      operation: sendOperation(),
    });
    await expect(
      store.createSendOperation({
        requestId: "bulk-send-operation-0053",
        inputHash: "4".repeat(64),
        operation: {
          ...sendOperation(),
          id: "60000000-0000-4000-8000-000000000099",
          stableSendKey: "7".repeat(64),
        },
      }),
    ).rejects.toMatchObject({
      name: "CampaignBulkDeliveryError",
      code: "bulk_send_already_exists",
    });
  });

  it("cancels a competing active schedule when the Owner sends immediately", async () => {
    const store = createD1CampaignBulkStateStore(
      database as unknown as D1DatabaseBinding,
    );
    await store.saveAuthorization({
      requestId: "bulk-owner-authorization-52",
      inputHash: "1".repeat(64),
      authorization: authorization(),
    });
    await store.activateSchedule({
      requestId: "bulk-schedule-request-0052",
      inputHash: "2".repeat(64),
      schedule: {
        id: "80000000-0000-4000-8000-000000000052",
        siteId,
        campaignId,
        authorizationId: authorization().id,
        localDateTime: "2026-08-01T00:10:00",
        ianaTimeZone: "UTC",
        utcOffsetChoice: "+00:00",
        executeAtUtc: "2026-08-01T00:10:00.000Z",
        timeZoneDatabaseVersion: "2026a",
        activatedBy: "membership-owner",
        state: "active",
        createdAt: "2026-08-01T00:03:00.000Z",
        updatedAt: "2026-08-01T00:03:00.000Z",
      },
    });

    await store.createSendOperation({
      requestId: "bulk-send-operation-0052",
      inputHash: "3".repeat(64),
      operation: sendOperation(),
    });

    await expect(
      database
        .prepare(`SELECT state FROM campaign_bulk_schedules WHERE id = ?1`)
        .bind("80000000-0000-4000-8000-000000000052")
        .first<{ state: string }>(),
    ).resolves.toEqual({ state: "cancelled" });
    await expect(
      store.claimDueSchedule({
        now: "2026-08-01T00:11:00.000Z",
        latenessCutoff: "2026-08-01T00:00:00.000Z",
        leaseToken: "lease-after-send-now",
        leaseExpiresAt: "2026-08-01T00:16:00.000Z",
        createOperationId: () => "60000000-0000-4000-8000-000000000098",
      }),
    ).resolves.toBeNull();
  });

  it("reclaims an attempting operation whose executor died before recording an outcome", async () => {
    const store = createD1CampaignBulkStateStore(
      database as unknown as D1DatabaseBinding,
    );
    await store.saveAuthorization({
      requestId: "bulk-owner-authorization-52",
      inputHash: "1".repeat(64),
      authorization: authorization(),
    });
    await store.createSendOperation({
      requestId: "bulk-send-operation-0052",
      inputHash: "3".repeat(64),
      operation: sendOperation(),
    });
    const claimed = await store.claimOperation({
      siteId,
      operationId: sendOperation().id,
      expectedCampaignRevisionId: revisionId,
      expectedOwnerActorId: "membership-owner",
      heldLeaseToken: null,
      now: "2026-08-01T00:04:01.000Z",
      leaseToken: "lease-orphaned",
      leaseExpiresAt: "2026-08-01T00:09:01.000Z",
    });
    const prepared = await store.saveAudienceSnapshot({
      operation: claimed!,
      snapshot: audienceSnapshot(),
      sendArtifact: sendArtifact(),
      sendArtifactHash: "6".repeat(64),
      now: "2026-08-01T00:04:02.000Z",
    });
    const committed = await store.recordArtifactPublication({
      operation: prepared!,
      outcome: { outcome: "committed", commitSha: "a".repeat(40) },
      now: "2026-08-01T00:04:03.000Z",
    });
    const attempting = await store.beginProviderAttempt({
      operation: committed,
      activeSubscriberIds: ["subscriber-52"],
      providerCampaignId: "provider-campaign-52",
      providerSendProof: "5".repeat(64),
      now: "2026-08-01T00:04:04.000Z",
    });
    expect(attempting).toMatchObject({ state: "attempting" });

    // The executor crashes here: no provider outcome is ever recorded, so the
    // operation stays 'attempting' until its lease expires.
    await expect(
      store.listReconciliationCandidates({
        siteId,
        now: "2026-08-01T00:10:00.000Z",
        sentReportingCutoff: "2026-07-02T00:00:00.000Z",
        limit: 25,
      }),
    ).resolves.toMatchObject([{ id: sendOperation().id, state: "attempting" }]);

    const reclaimed = await store.claimOperation({
      siteId,
      operationId: sendOperation().id,
      expectedCampaignRevisionId: revisionId,
      expectedOwnerActorId: "membership-owner",
      heldLeaseToken: null,
      now: "2026-08-01T00:10:00.000Z",
      leaseToken: "lease-reclaimed",
      leaseExpiresAt: "2026-08-01T00:15:00.000Z",
    });
    expect(reclaimed).toMatchObject({
      state: "attempting",
      attempt: attempting!.attempt + 1,
      leaseToken: "lease-reclaimed",
    });
  });
});
