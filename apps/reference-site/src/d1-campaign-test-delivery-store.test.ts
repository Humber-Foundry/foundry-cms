import { beforeEach, describe, expect, it } from "vitest";

import {
  createCampaignId,
  createCampaignRevisionId,
  type CampaignTestDeliveryOperation,
} from "@foundry/application";
import { createSiteId } from "@foundry/site-definition";

import { createD1BrevoTestWebhookEvidenceStore } from "./d1-brevo-test-webhook-evidence-store";
import { createD1CampaignTestDeliveryStore } from "./d1-campaign-test-delivery-store";
import type { D1DatabaseBinding } from "./d1-human-access-store";
import { useMigratedTestDatabase } from "./test-support/migrated-test-database";

const { database } = useMigratedTestDatabase([
  "0016_campaign_authoring.sql",
  "0021_campaign_test_delivery.sql",
]);

beforeEach(async () => {
  await database
    .prepare(
      `INSERT INTO campaigns (
         id, site_id, lifecycle_state, current_revision_id,
         version, created_at, updated_at
       ) VALUES (?1, ?2, 'draft', ?3, 1, ?4, ?4)`,
    )
    .bind(
      "20000000-0000-4000-8000-000000000001",
      "site_reference",
      "30000000-0000-4000-8000-000000000001",
      "2026-07-29T19:00:00.000Z",
    )
    .run();
  await database
    .prepare(
      `INSERT INTO campaign_revisions (
         id, site_id, campaign_id, revision_number, revision_json, created_at
       ) VALUES (?1, ?2, ?3, 1, '{}', ?4)`,
    )
    .bind(
      "30000000-0000-4000-8000-000000000001",
      "site_reference",
      "20000000-0000-4000-8000-000000000001",
      "2026-07-29T19:00:00.000Z",
    )
    .run();
});

describe("D1 campaign test delivery store", () => {
  it("persists stable exact evidence without recipient addresses and makes acceptance immutable", async () => {
    const store = createD1CampaignTestDeliveryStore(
      database as unknown as D1DatabaseBinding,
    );
    const pending: CampaignTestDeliveryOperation = {
      executionId: "40000000-0000-4000-8000-000000000001",
      siteId: createSiteId("site_reference"),
      actorId: "membership-editor",
      requestId: "campaign-test-durable-1",
      campaignId: createCampaignId(
        "20000000-0000-4000-8000-000000000001",
      ),
      campaignRevisionId: createCampaignRevisionId(
        "30000000-0000-4000-8000-000000000001",
      ),
      binding: {
        campaignId: createCampaignId(
          "20000000-0000-4000-8000-000000000001",
        ),
        campaignRevisionId: createCampaignRevisionId(
          "30000000-0000-4000-8000-000000000001",
        ),
        campaignFingerprint: "a".repeat(64),
        htmlFingerprint: "b".repeat(64),
        textFingerprint: "c".repeat(64),
        senderFingerprint: "d".repeat(64),
        audienceDefinitionFingerprint: "e".repeat(64),
        complianceFingerprint: "f".repeat(64),
        providerConfigurationFingerprint: "0".repeat(64),
        recipientSetFingerprint: "1".repeat(64),
      },
      recipientIds: ["owner-primary"],
      state: "pending",
      attemptNumber: 0,
      attemptLeaseUntil: null,
      providerCampaignId: null,
      providerMessageId: null,
      foundrySendProof: null,
      failureCode: null,
      evidence: null,
      createdAt: "2026-07-29T19:05:00.000Z",
      updatedAt: "2026-07-29T19:05:00.000Z",
    };
    await store.claim(pending);
    await expect(
      database
        .prepare(
          `UPDATE campaign_test_deliveries
           SET state = 'ambiguous', failure_code = 'arbitrary_provider_code'
           WHERE execution_id = ?1`,
        )
        .bind(pending.executionId)
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/u);
    const attempting = await store.beginAttempt({
      operation: pending,
      now: "2026-07-29T19:05:01.000Z",
      leaseUntil: "2026-07-29T19:06:01.000Z",
    });
    expect(attempting).toMatchObject({
      state: "attempting",
      attemptLeaseUntil: "2026-07-29T19:06:01.000Z",
    });
    const renewed = await store.renewAttemptLease({
      operation: attempting!,
      now: "2026-07-29T19:05:30.000Z",
      leaseUntil: "2026-07-29T19:06:30.000Z",
    });
    expect(renewed).toMatchObject({
      state: "attempting",
      attemptNumber: 1,
      attemptLeaseUntil: "2026-07-29T19:06:30.000Z",
      updatedAt: "2026-07-29T19:05:30.000Z",
    });
    await expect(
      store.claim({
        ...pending,
        executionId: "40000000-0000-4000-8000-000000000002",
        requestId: "campaign-test-durable-2",
      }),
    ).rejects.toThrow(/test_delivery_in_progress/u);
    await expect(
      store.beginAttempt({
        operation: renewed!,
        now: "2026-07-29T19:05:59.000Z",
        leaseUntil: "2026-07-29T19:07:02.000Z",
      }),
    ).resolves.toBeNull();
    const ambiguous = await store.record({
      ...renewed!,
      state: "ambiguous",
      attemptLeaseUntil: null,
      providerCampaignId: "17",
      foundrySendProof: "7".repeat(64),
      updatedAt: "2026-07-29T19:06:31.000Z",
    });
    expect(ambiguous.foundrySendProof).toBe("7".repeat(64));
    const driftAmbiguous = await store.record({
      ...ambiguous,
      failureCode: "provider_campaign_fingerprint_mismatch",
      updatedAt: "2026-07-29T19:06:31.500Z",
    });
    expect(driftAmbiguous).toMatchObject({
      state: "ambiguous",
      failureCode: "provider_campaign_fingerprint_mismatch",
    });
    const webhookStore = createD1BrevoTestWebhookEvidenceStore({
      database: database as unknown as D1DatabaseBinding,
      siteId: pending.siteId,
    });
    const webhookEvidence = {
      eventFingerprint: "3".repeat(64),
      payloadFingerprint: "2".repeat(64),
      siteId: pending.siteId,
      executionId: pending.executionId,
      foundrySendProof: "7".repeat(64),
      providerMessageId: "<message-17@brevo.test>",
      recipientFingerprint: "4".repeat(64),
      eventType: "request",
      occurredAt: "2026-07-29T19:06:31.600Z",
      receivedAt: "2026-07-29T19:06:31.700Z",
    };
    await expect(
      webhookStore.recordVerified(webhookEvidence),
    ).resolves.toBe("recorded");
    await expect(
      webhookStore.recordVerified(webhookEvidence),
    ).resolves.toBe("duplicate");
    await expect(
      webhookStore.recordVerified({
        ...webhookEvidence,
        payloadFingerprint: "9".repeat(64),
      }),
    ).resolves.toBe("conflict");
    await expect(
      webhookStore.recordVerified({
        ...webhookEvidence,
        eventFingerprint: "5".repeat(64),
        foundrySendProof: "6".repeat(64),
      }),
    ).resolves.toBe("conflict");
    await expect(
      webhookStore.listVerified({
        executionId: pending.executionId,
        foundrySendProof: "7".repeat(64),
      }),
    ).resolves.toEqual([webhookEvidence]);
    await expect(
      database
        .prepare(
          `UPDATE campaign_test_brevo_webhook_evidence
           SET event_type = 'opened' WHERE event_fingerprint = ?1`,
        )
        .bind(webhookEvidence.eventFingerprint)
        .run(),
    ).rejects.toThrow(
      /campaign_test_brevo_webhook_evidence_is_immutable/u,
    );
    const takeover = await store.beginAttempt({
      operation: driftAmbiguous,
      now: "2026-07-29T19:06:32.000Z",
      leaseUntil: "2026-07-29T19:07:02.000Z",
    });
    expect(takeover).toMatchObject({
      state: "attempting",
      attemptNumber: 2,
    });
    await expect(
      store.record({
        ...attempting!,
        state: "accepted",
        attemptLeaseUntil: null,
        providerCampaignId: "stale-17",
        providerMessageId: "stale-message-17",
        foundrySendProof: "7".repeat(64),
        evidence: {
          ...pending.binding,
          executionId: pending.executionId,
          providerCampaignId: "stale-17",
          providerMessageId: "stale-message-17",
          providerReceiptHash: "9".repeat(64),
          acceptedAt: "2026-07-29T19:06:03.000Z",
        },
        updatedAt: "2026-07-29T19:06:03.000Z",
      }),
    ).rejects.toThrow(/campaign_test_delivery_state_conflict/u);
    const accepted: CampaignTestDeliveryOperation = {
      ...takeover!,
      state: "accepted",
      attemptLeaseUntil: null,
      providerCampaignId: "17",
      providerMessageId: "message-17",
      failureCode: null,
      evidence: {
        ...pending.binding,
        executionId: pending.executionId,
        providerCampaignId: "17",
        providerMessageId: "message-17",
        providerReceiptHash: "2".repeat(64),
        acceptedAt: "2026-07-29T19:06:00.000Z",
      },
      updatedAt: "2026-07-29T19:06:00.000Z",
    };

    await expect(
      store.record({
        ...accepted,
        foundrySendProof: null,
      }),
    ).rejects.toThrow(/campaign_test_delivery_evidence_invalid/u);
    await expect(
      database
        .prepare(
          `UPDATE campaign_test_deliveries
           SET state = 'accepted', attempt_lease_until = NULL,
             provider_campaign_id = '17', foundry_send_proof = NULL,
             evidence_json = '{}'
           WHERE execution_id = ?1`,
        )
        .bind(pending.executionId)
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/u);
    await expect(store.record(accepted)).resolves.toEqual(accepted);
    await database
      .prepare(
        `INSERT INTO campaigns (
           id, site_id, lifecycle_state, current_revision_id,
           version, created_at, updated_at
         ) VALUES (?1, ?2, 'draft', ?3, 1, ?4, ?4)`,
      )
      .bind(
        "20000000-0000-4000-8000-000000000002",
        pending.siteId,
        pending.campaignRevisionId,
        "2026-07-29T19:06:01.000Z",
      )
      .run();
    await expect(
      store.claim({
        ...pending,
        executionId: "40000000-0000-4000-8000-000000000099",
        requestId: "campaign-test-mismatched-revision-1",
        campaignId: createCampaignId(
          "20000000-0000-4000-8000-000000000002",
        ),
        state: "failed",
        failureCode: "provider_test_rejected",
        createdAt: "2026-07-29T19:06:01.000Z",
        updatedAt: "2026-07-29T19:06:01.000Z",
      }),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/u);
    for (let attemptNumber = 1; attemptNumber <= 10; attemptNumber += 1) {
      await expect(
        store.reserveDailyRecipientBudget({
          accountScopeFingerprint: "8".repeat(64),
          executionId: accepted.executionId,
          attemptNumber,
          recipientCount: 5,
          budgetDay: "2026-07-29",
          reservedAt: `2026-07-29T20:${String(attemptNumber).padStart(2, "0")}:00.000Z`,
        }),
      ).resolves.toBe(true);
    }
    await expect(
      store.reserveDailyRecipientBudget({
        accountScopeFingerprint: "8".repeat(64),
        executionId: accepted.executionId,
        attemptNumber: 11,
        recipientCount: 1,
        budgetDay: "2026-07-29",
        reservedAt: "2026-07-29T21:00:00.000Z",
      }),
    ).resolves.toBe(false);
    const raw = await database
      .prepare(
        `SELECT binding_json, recipient_ids_json, evidence_json
         FROM campaign_test_deliveries WHERE execution_id = ?1`,
      )
      .bind(pending.executionId)
      .first<Record<string, string>>();
    expect(JSON.stringify(raw)).not.toContain("@");
    for (let index = 2; index <= 5; index += 1) {
      await store.claim({
        ...pending,
        executionId:
          `40000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        requestId: `campaign-test-durable-${index}`,
        state: "failed",
        failureCode: "provider_test_rejected",
        createdAt: `2026-07-29T19:0${index}:00.000Z`,
        updatedAt: `2026-07-29T19:0${index}:00.000Z`,
      });
    }
    await expect(
      store.claim({
        ...pending,
        executionId: "40000000-0000-4000-8000-000000000006",
        requestId: "campaign-test-durable-6",
        state: "failed",
        failureCode: "provider_test_rejected",
        createdAt: "2026-07-29T19:06:00.000Z",
        updatedAt: "2026-07-29T19:06:00.000Z",
      }),
    ).rejects.toThrow(/test_delivery_rate_limited/u);
    await expect(
      database
        .prepare(
          `UPDATE campaign_test_deliveries
           SET evidence_json = '{}' WHERE execution_id = ?1`,
        )
        .bind(pending.executionId)
        .run(),
    ).rejects.toThrow(/campaign_test_delivery_is_terminal/u);
    await expect(
      store.findLatestAccepted({
        siteId: pending.siteId,
        campaignId: pending.campaignId,
      }),
    ).resolves.toEqual(accepted);
  });
});
