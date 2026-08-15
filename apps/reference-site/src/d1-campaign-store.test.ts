import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  campaignAudienceDefinition,
  CampaignConflictError,
  CampaignIdempotencyError,
  createCampaignApplication,
  createCampaignId,
  createCampaignRevisionId,
  createHumanMembershipId,
  createHumanUserId,
  type ExternalHumanIdentity,
} from "@humber-foundry/application";
import {
  createRichTextDocumentFromPlainText,
  createSiteId,
} from "@humber-foundry/site-definition";

import { createD1CampaignStore } from "./d1-campaign-store";
import type { D1DatabaseBinding } from "./d1-human-access-store";
import { useMigratedTestDatabase } from "./test-support/migrated-test-database";

const siteId = createSiteId("site_reference");
const { database } = useMigratedTestDatabase([
  "0001_human_access.sql",
  "0016_campaign_authoring.sql",
  "0021_campaign_test_delivery.sql",
]);
const actor: ExternalHumanIdentity = {
  binding: { issuer: "https://access.example", subject: "editor" },
  email: "editor@example.com",
  nonce: "nonce",
};

beforeEach(async () => {
  await database
    .prepare(
      `INSERT INTO human_users (id, email, created_at)
       VALUES ('user-editor', ?1, '2026-07-29T19:00:00.000Z')`,
    )
    .bind(actor.email)
    .run();
  await database
    .prepare(
      `INSERT INTO human_memberships (
         id, site_id, user_id, email, identity_issuer, identity_subject,
         role, status, created_at, updated_at
       ) VALUES (
         'membership-editor', ?1, 'user-editor', ?2, ?3, ?4,
         'owner', 'active', ?5, ?5
       )`,
    )
    .bind(
      siteId,
      actor.email,
      actor.binding.issuer,
      actor.binding.subject,
      "2026-07-29T19:00:00.000Z",
    )
    .run();
});

describe("D1 campaign store", () => {
  it("atomically persists immutable revisions with linked audit evidence", async () => {
    let id = 0;
    const store = createD1CampaignStore(
      database as unknown as D1DatabaseBinding,
    );
    const application = createCampaignApplication({
      siteId,
      store,
      authorize: async () => ({
        id: createHumanMembershipId("membership-editor"),
        siteId,
        userId: createHumanUserId("user-editor"),
        email: actor.email,
        identityBinding: actor.binding,
        role: "editor",
        status: "active",
      }),
      identifyActor: () => createHumanMembershipId("membership-editor"),
      findPostRevision: async () => null,
      resolveAudience: async () => ({ eligibleSubscriberCount: 7 }),
      channelConfiguration: {
        senderIdentityId: "sender_primary",
        complianceFooter: {
          version: "footer-v1",
          content: "Durable compliance material.",
          unsubscribePlaceholder:
            "https://example.test/newsletter/unsubscribe" +
            "?token={{foundry.unsubscribe.token}}",
        },
        audienceDefinition: campaignAudienceDefinition,
      },
      rendererVersion: "1111111111111111111111111111111111111111",
      schemaVersion: "1.4.0",
      createId: (kind) =>
        kind === "campaign"
          ? "20000000-0000-4000-8000-000000000001"
          : `30000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
    });
    const created = await application.commands.createStandalone({
      actor,
      requestId: "campaign-create-durable-1",
      input: {
        subject: "Durable campaign",
        previewText: "Durable preview text.",
        shareImage: null,
        callToAction: {
          label: "Read more",
          href: "https://example.com",
        },
        emailContent: createRichTextDocumentFromPlainText("Durable body."),
      },
    });
    const replayed = await application.commands.createStandalone({
      actor,
      requestId: "campaign-create-durable-1",
      input: {
        subject: "Durable campaign",
        previewText: "Durable preview text.",
        shareImage: null,
        callToAction: {
          label: "Read more",
          href: "https://example.com",
        },
        emailContent: createRichTextDocumentFromPlainText("Durable body."),
      },
    });
    expect(replayed).toEqual({ ...created, replayed: true });
    await expect(
      application.commands.createStandalone({
        actor,
        requestId: "campaign-create-durable-1",
        input: {
          subject: "Different command input",
          previewText: "Durable preview text.",
          shareImage: null,
          callToAction: {
            label: "Read more",
            href: "https://example.com",
          },
          emailContent: createRichTextDocumentFromPlainText("Durable body."),
        },
      }),
    ).rejects.toBeInstanceOf(CampaignIdempotencyError);
    await application.queries.render({
      actor,
      campaignId: created.campaign.id,
    });
    await database
      .prepare(
        `INSERT INTO campaign_test_deliveries (
           execution_id, site_id, actor_id, request_id, campaign_id,
           campaign_revision_id, binding_json, recipient_ids_json, state,
           attempt_number, attempt_lease_until, provider_campaign_id,
           provider_message_id,
           failure_code, evidence_json, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, '{}', '[]', 'attempting',
           1, '9999-12-31T23:59:59.999Z', '17', NULL, NULL, NULL, ?7, ?7)`,
      )
      .bind(
        "40000000-0000-4000-8000-000000000051",
        siteId,
        "membership-editor",
        "campaign-test-before-edit-1",
        created.campaign.id,
        created.revision.id,
        "2026-07-29T19:05:00.000Z",
      )
      .run();
    await expect(
      application.commands.edit({
        actor,
        requestId: "campaign-edit-during-test-send-1",
        campaignId: created.campaign.id,
        expectedVersion: 1,
        input: {
          ...created.revision,
          subject: "Must wait for provider write",
        },
      }),
    ).rejects.toBeInstanceOf(CampaignConflictError);
    await expect(
      database
        .prepare(
          `SELECT
             (SELECT version FROM campaigns WHERE id = ?1) AS version,
             (SELECT state FROM campaign_test_deliveries
              WHERE execution_id = ?2) AS delivery_state`,
        )
        .bind(
          created.campaign.id,
          "40000000-0000-4000-8000-000000000051",
        )
        .first(),
    ).resolves.toEqual({ version: 1, delivery_state: "attempting" });
    await database
      .prepare(
        `UPDATE campaign_test_deliveries
         SET attempt_lease_until = '2000-01-01T00:00:00.000Z'
         WHERE execution_id = ?1`,
      )
      .bind("40000000-0000-4000-8000-000000000051")
      .run();
    const edited = await application.commands.edit({
      actor,
      requestId: "campaign-edit-durable-1",
      campaignId: created.campaign.id,
      expectedVersion: 1,
      input: {
        ...created.revision,
        subject: "Independently edited",
      },
    });
    await expect(
      database
        .prepare(
          `SELECT state, failure_code FROM campaign_test_deliveries
           WHERE execution_id = ?1`,
        )
        .bind("40000000-0000-4000-8000-000000000051")
        .first(),
    ).resolves.toMatchObject({
      state: "cancelled",
      failure_code: "campaign_revision_changed",
    });
    const stale = () =>
      application.commands.edit({
        actor,
        requestId: "campaign-edit-stale-durable-1",
        campaignId: created.campaign.id,
        expectedVersion: 1,
        input: {
          ...created.revision,
          subject: "Stale edit",
        },
      });
    await expect(stale()).rejects.toBeInstanceOf(CampaignConflictError);
    await expect(stale()).rejects.toBeInstanceOf(CampaignConflictError);
    await application.commands.recordRejectedCommand({
      actor,
      requestId: "campaign-malformed-durable-1",
      reason: "campaign_command_invalid",
      command: { action: "unknown" },
    });
    await application.commands.recordRejectedCommand({
      actor,
      requestId: "campaign-malformed-durable-1",
      reason: "campaign_command_invalid",
      command: { action: "unknown" },
    });
    const acceptedTest = {
      actor,
      requestId: "campaign-test-audit-durable-1",
      command: {
        action: "request_test",
        campaignId: created.campaign.id,
        testRecipientIds: ["owner-primary"],
      },
      campaign: edited.campaign,
      revision: edited.revision,
      beforeState: JSON.stringify({
        current: { testDelivery: "not_started" },
        required: { testDelivery: "eligible" },
      }),
      afterState: JSON.stringify({
        testDelivery: "pending",
        executionId: "40000000-0000-4000-8000-000000000001",
      }),
    };
    await application.commands.recordAcceptedTestCommand(acceptedTest);
    await application.commands.recordAcceptedTestCommand(acceptedTest);
    await application.commands.replayTestCommand({
      actor,
      requestId: acceptedTest.requestId,
      command: acceptedTest.command,
      targetId: created.campaign.id,
    });
    await database
      .prepare(
        `INSERT INTO campaign_test_deliveries (
           execution_id, site_id, actor_id, request_id, campaign_id,
           campaign_revision_id, binding_json, recipient_ids_json, state,
           attempt_number, attempt_lease_until, provider_campaign_id,
           provider_message_id, foundry_send_proof, failure_code, evidence_json,
           created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, '{}',
           '["membership-editor"]', 'accepted',
           1, NULL, '18', '<message-18@brevo.test>',
           '${"a".repeat(64)}', NULL, '{}', ?7, ?7)`,
      )
      .bind(
        "40000000-0000-4000-8000-000000000001",
        siteId,
        "membership-editor",
        "campaign-test-confirm-source-1",
        acceptedTest.campaign.id,
        acceptedTest.revision.id,
        "2026-07-29T19:06:00.000Z",
      )
      .run();
    const acceptedConfirmation = {
      ...acceptedTest,
      requestId: "campaign-test-confirm-audit-durable-1",
      command: {
        action: "confirm_test_receipt",
        executionId: "40000000-0000-4000-8000-000000000001",
      },
      targetId: "40000000-0000-4000-8000-000000000001",
      confirmation: {
        executionId: "40000000-0000-4000-8000-000000000001",
        siteId,
        ownerActorId: "membership-editor",
        requestId: "campaign-test-confirm-audit-durable-1",
        confirmedAt: "2026-07-29T19:07:00.000Z",
      },
    };
    await application.commands.recordAcceptedTestReceiptConfirmation(
      acceptedConfirmation,
    );
    await application.commands.recordAcceptedTestReceiptConfirmation(
      acceptedConfirmation,
    );
    await application.commands.replayTestCommand({
      actor,
      requestId: acceptedConfirmation.requestId,
      command: acceptedConfirmation.command,
      targetId: acceptedConfirmation.targetId,
      commandName: "campaign.confirm_test_receipt",
    });
    await expect(
      database
        .prepare(
          `SELECT owner_actor_id, request_id
           FROM campaign_test_receipt_confirmations
           WHERE execution_id = ?1`,
        )
        .bind(acceptedConfirmation.confirmation.executionId)
        .first(),
    ).resolves.toMatchObject({
      owner_actor_id: "membership-editor",
      request_id: acceptedConfirmation.requestId,
    });
    await expect(
      database
        .prepare(
          `UPDATE campaign_test_receipt_confirmations
           SET owner_actor_id = 'other' WHERE execution_id = ?1`,
        )
        .bind(acceptedConfirmation.confirmation.executionId)
        .run(),
    ).rejects.toThrow(/campaign_test_receipt_confirmation_is_immutable/u);
    const secondOwnerCommand = {
      siteId,
      actorId: "membership-owner-secondary",
      commandName: "campaign.confirm_test_receipt" as const,
      requestId: "campaign-test-confirm-owner-secondary-1",
      inputHash: "7".repeat(64),
    };
    const secondOwnerResult =
      await store.acceptTestReceiptConfirmation({
        command: secondOwnerCommand,
        campaign: acceptedTest.campaign,
        revision: acceptedTest.revision,
        confirmation: {
          executionId: acceptedConfirmation.confirmation.executionId,
          siteId,
          ownerActorId: secondOwnerCommand.actorId,
          requestId: secondOwnerCommand.requestId,
          confirmedAt: "2026-07-29T19:07:01.000Z",
        },
        audit: {
          id: "50000000-0000-4000-8000-000000000071" as never,
          siteId,
          actorId: secondOwnerCommand.actorId,
          targetId: acceptedConfirmation.confirmation.executionId,
          revisionId: acceptedTest.revision.id,
          requestId: secondOwnerCommand.requestId,
          inputHash: secondOwnerCommand.inputHash,
          action: "campaign.test",
          outcome: "accepted",
          reason: null,
          beforeState: "{}",
          afterState: "{}",
          occurredAt: "2026-07-29T19:07:01.000Z",
        },
        conflictAudit: {
          id: "50000000-0000-4000-8000-000000000072" as never,
          siteId,
          actorId: secondOwnerCommand.actorId,
          targetId: acceptedConfirmation.confirmation.executionId,
          revisionId: acceptedTest.revision.id,
          requestId: secondOwnerCommand.requestId,
          inputHash: secondOwnerCommand.inputHash,
          action: "campaign.test",
          outcome: "rejected",
          reason: "test_receipt_already_confirmed",
          beforeState: "{}",
          afterState: null,
          occurredAt: "2026-07-29T19:07:01.000Z",
        },
        staleAudit: {
          id: "50000000-0000-4000-8000-000000000073" as never,
          siteId,
          actorId: secondOwnerCommand.actorId,
          targetId: acceptedConfirmation.confirmation.executionId,
          revisionId: acceptedTest.revision.id,
          requestId: secondOwnerCommand.requestId,
          inputHash: secondOwnerCommand.inputHash,
          action: "campaign.test",
          outcome: "rejected",
          reason: "test_delivery_not_current",
          beforeState: "{}",
          afterState: null,
          occurredAt: "2026-07-29T19:07:01.000Z",
        },
        authorityAudit: {
          id: "50000000-0000-4000-8000-000000000074" as never,
          siteId,
          actorId: secondOwnerCommand.actorId,
          targetId: acceptedConfirmation.confirmation.executionId,
          revisionId: acceptedTest.revision.id,
          requestId: secondOwnerCommand.requestId,
          inputHash: secondOwnerCommand.inputHash,
          action: "campaign.test",
          outcome: "rejected",
          reason: "test_confirmation_owner_not_recipient",
          beforeState: "{}",
          afterState: null,
          occurredAt: "2026-07-29T19:07:01.000Z",
        },
      });
    expect(secondOwnerResult.receipt).toMatchObject({
      outcome: "rejected",
      reason: "test_receipt_already_confirmed",
    });
    await expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM campaign_command_receipts
           WHERE command_name = 'campaign.confirm_test_receipt'
             AND outcome = 'pending'`,
        )
        .first(),
    ).resolves.toEqual({ count: 0 });
    await database
      .prepare(
        `INSERT INTO campaign_test_deliveries (
           execution_id, site_id, actor_id, request_id, campaign_id,
           campaign_revision_id, binding_json, recipient_ids_json, state,
           attempt_number, attempt_lease_until, provider_campaign_id,
           provider_message_id, foundry_send_proof, failure_code, evidence_json,
           created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, '{}',
           '["membership-editor"]', 'accepted',
           1, NULL, '19', '<message-19@brevo.test>',
           '${"b".repeat(64)}', NULL, '{}', ?7, ?7)`,
      )
      .bind(
        "40000000-0000-4000-8000-000000000002",
        siteId,
        "membership-editor",
        "campaign-test-confirm-fault-source-1",
        acceptedTest.campaign.id,
        acceptedTest.revision.id,
        "2026-07-29T19:08:00.000Z",
      )
      .run();
    await database
      .prepare(
        `CREATE TRIGGER campaign_test_confirmation_fault
         BEFORE INSERT ON campaign_audit_events
         WHEN NEW.request_id = 'campaign-test-confirm-fault-durable-1'
         BEGIN
           SELECT RAISE(ABORT, 'simulated_confirmation_audit_failure');
         END`,
      )
      .run();
    await expect(
      application.commands.recordAcceptedTestReceiptConfirmation({
        ...acceptedConfirmation,
        requestId: "campaign-test-confirm-fault-durable-1",
        command: {
          action: "confirm_test_receipt",
          executionId: "40000000-0000-4000-8000-000000000002",
        },
        targetId: "40000000-0000-4000-8000-000000000002",
        confirmation: {
          ...acceptedConfirmation.confirmation,
          executionId: "40000000-0000-4000-8000-000000000002",
          requestId: "campaign-test-confirm-fault-durable-1",
        },
      }),
    ).rejects.toThrow(/simulated_confirmation_audit_failure/u);
    await expect(
      database
        .prepare(
          `SELECT execution_id FROM campaign_test_receipt_confirmations
           WHERE execution_id = ?1`,
        )
        .bind("40000000-0000-4000-8000-000000000002")
        .first(),
    ).resolves.toBeNull();
    await expect(
      database
        .prepare(
          `SELECT request_id FROM campaign_command_receipts
           WHERE request_id = 'campaign-test-confirm-fault-durable-1'`,
        )
        .first(),
    ).resolves.toBeNull();

    await expect(
      application.queries.getRevision({
        actor,
        campaignId: created.campaign.id,
        revisionNumber: 1,
      }),
    ).resolves.toMatchObject({ subject: "Durable campaign" });
    await expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM campaign_audit_events")
        .first<{ count: number }>(),
    ).resolves.toEqual({ count: 9 });
    await expect(
      database
        .prepare(
          `SELECT outcome, COUNT(*) AS count
           FROM campaign_audit_events
           GROUP BY outcome ORDER BY outcome`,
        )
        .all<{ outcome: string; count: number }>(),
    ).resolves.toMatchObject({
      results: [
        { outcome: "accepted", count: 4 },
        { outcome: "rejected", count: 5 },
      ],
    });
    await expect(
      database
        .prepare(
          `SELECT outcome, COUNT(*) AS count
           FROM campaign_command_receipts
           GROUP BY outcome ORDER BY outcome`,
        )
        .all<{ outcome: string; count: number }>(),
    ).resolves.toMatchObject({
      results: [
        { outcome: "accepted", count: 4 },
        { outcome: "rejected", count: 4 },
      ],
    });
    await expect(
      database
        .prepare(
          `SELECT campaign_revision_id
           FROM campaign_audit_events
           WHERE outcome = 'accepted'
           ORDER BY occurred_at, id`,
        )
        .all<{ campaign_revision_id: string }>(),
    ).resolves.toMatchObject({
      results: [
        { campaign_revision_id: acceptedTest.revision.id },
        { campaign_revision_id: expect.any(String) },
        { campaign_revision_id: expect.any(String) },
        { campaign_revision_id: expect.any(String) },
      ],
    });
    await database
      .prepare(
        `INSERT INTO campaign_test_deliveries (
           execution_id, site_id, actor_id, request_id, campaign_id,
           campaign_revision_id, binding_json, recipient_ids_json, state,
           attempt_number, attempt_lease_until, provider_campaign_id,
           provider_message_id, foundry_send_proof, failure_code, evidence_json,
           created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, '{}',
           '["membership-editor"]', 'accepted',
           1, NULL, '21', '<message-21@brevo.test>',
           '${"d".repeat(64)}', NULL, '{}', ?7, ?7)`,
      )
      .bind(
        "40000000-0000-4000-8000-000000000004",
        siteId,
        "membership-editor",
        "campaign-test-confirm-authority-source-1",
        acceptedTest.campaign.id,
        acceptedTest.revision.id,
        "2026-07-29T19:08:30.000Z",
      )
      .run();
    await database
      .prepare(
        `INSERT INTO human_users (id, email, created_at)
         VALUES ('user-backup-owner', 'backup-owner@example.com', ?1)`,
      )
      .bind("2026-07-29T19:08:31.000Z")
      .run();
    await database
      .prepare(
        `INSERT INTO human_memberships (
           id, site_id, user_id, email, identity_issuer, identity_subject,
           role, status, created_at, updated_at
         ) VALUES (
           'membership-backup-owner', ?1, 'user-backup-owner',
           'backup-owner@example.com', 'https://access.example', 'backup-owner',
           'owner', 'active', ?2, ?2
         )`,
      )
      .bind(siteId, "2026-07-29T19:08:31.000Z")
      .run();
    await database
      .prepare(
        `UPDATE human_memberships
         SET status = 'suspended', updated_at = ?2
         WHERE id = 'membership-editor' AND site_id = ?1`,
      )
      .bind(siteId, "2026-07-29T19:08:32.000Z")
      .run();
    await expect(
      application.commands.recordAcceptedTestReceiptConfirmation({
        ...acceptedConfirmation,
        requestId: "campaign-test-confirm-authority-race-1",
        command: {
          action: "confirm_test_receipt",
          executionId: "40000000-0000-4000-8000-000000000004",
        },
        targetId: "40000000-0000-4000-8000-000000000004",
        confirmation: {
          ...acceptedConfirmation.confirmation,
          executionId: "40000000-0000-4000-8000-000000000004",
          requestId: "campaign-test-confirm-authority-race-1",
        },
      }),
    ).rejects.toMatchObject({
      message: "test_confirmation_owner_not_recipient",
    });
    await expect(
      database
        .prepare(
          `SELECT outcome, reason FROM campaign_command_receipts
           WHERE request_id = 'campaign-test-confirm-authority-race-1'`,
        )
        .first(),
    ).resolves.toEqual({
      outcome: "rejected",
      reason: "test_confirmation_owner_not_recipient",
    });
    await expect(
      database
        .prepare(
          `SELECT execution_id FROM campaign_test_receipt_confirmations
           WHERE execution_id = '40000000-0000-4000-8000-000000000004'`,
        )
        .first(),
    ).resolves.toBeNull();
    await expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM campaign_command_receipts
           WHERE outcome = 'pending'`,
        )
        .first(),
    ).resolves.toEqual({ count: 0 });
    await database
      .prepare(
        `UPDATE human_memberships
         SET status = 'active', updated_at = ?2
         WHERE id = 'membership-editor' AND site_id = ?1`,
      )
      .bind(siteId, "2026-07-29T19:08:33.000Z")
      .run();
    await database
      .prepare(
        `INSERT INTO campaign_test_deliveries (
           execution_id, site_id, actor_id, request_id, campaign_id,
           campaign_revision_id, binding_json, recipient_ids_json, state,
           attempt_number, attempt_lease_until, provider_campaign_id,
           provider_message_id, foundry_send_proof, failure_code, evidence_json,
           created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, '{}',
           '["membership-editor"]', 'accepted',
           1, NULL, '20', '<message-20@brevo.test>',
           '${"c".repeat(64)}', NULL, '{}', ?7, ?7)`,
      )
      .bind(
        "40000000-0000-4000-8000-000000000003",
        siteId,
        "membership-editor",
        "campaign-test-confirm-stale-source-1",
        created.campaign.id,
        created.revision.id,
        "2026-07-29T19:09:00.000Z",
      )
      .run();
    await expect(
      application.commands.recordAcceptedTestReceiptConfirmation({
        ...acceptedConfirmation,
        campaign: created.campaign,
        revision: created.revision,
        requestId: "campaign-test-confirm-stale-durable-1",
        command: {
          action: "confirm_test_receipt",
          executionId: "40000000-0000-4000-8000-000000000003",
        },
        targetId: "40000000-0000-4000-8000-000000000003",
        confirmation: {
          ...acceptedConfirmation.confirmation,
          executionId: "40000000-0000-4000-8000-000000000003",
          requestId: "campaign-test-confirm-stale-durable-1",
        },
      }),
    ).rejects.toMatchObject({ message: "test_delivery_not_current" });
    await expect(
      database
        .prepare(
          `SELECT outcome, reason FROM campaign_command_receipts
           WHERE request_id = 'campaign-test-confirm-stale-durable-1'`,
        )
        .first(),
    ).resolves.toEqual({
      outcome: "rejected",
      reason: "test_delivery_not_current",
    });
    await expect(
      database
        .prepare(
          `SELECT execution_id FROM campaign_test_receipt_confirmations
           WHERE execution_id = '40000000-0000-4000-8000-000000000003'`,
        )
        .first(),
    ).resolves.toBeNull();
    await expect(
      database
        .prepare(
          "UPDATE campaign_revisions SET revision_json = '{}' WHERE id = ?1",
        )
        .bind(created.revision.id)
        .run(),
    ).rejects.toThrow(/campaign_revision_is_immutable/u);
    await expect(
      database
        .prepare(
          "UPDATE campaign_audit_events SET outcome = 'rejected' WHERE outcome = 'accepted'",
        )
        .run(),
    ).rejects.toThrow(/campaign_audit_is_immutable/u);

    const failedCampaign = {
      ...created.campaign,
      id: createCampaignId("20000000-0000-4000-8000-000000000002"),
      currentRevisionId: createCampaignRevisionId(
        "30000000-0000-4000-8000-000000000099",
      ),
    };
    const failedRevision = {
      ...created.revision,
      id: failedCampaign.currentRevisionId,
      campaignId: failedCampaign.id,
    };
    const failedCommand = {
      siteId,
      actorId: "membership-editor",
      commandName: "campaign.create_standalone" as const,
      requestId: "campaign-create-rollback-1",
      inputHash: "f".repeat(64),
    };
    await expect(
      store.create({
        command: failedCommand,
        campaign: failedCampaign,
        revision: failedRevision,
        acceptedAudit: {
          id: "30000000-0000-4000-8000-000000000002",
          siteId,
          actorId: failedCommand.actorId,
          targetId: failedCampaign.id,
          revisionId: failedRevision.id,
          requestId: failedCommand.requestId,
          inputHash: failedCommand.inputHash,
          action: "campaign.create",
          outcome: "accepted",
          reason: null,
          beforeState: null,
          afterState: JSON.stringify(failedCampaign),
          occurredAt: failedRevision.createdAt,
        },
        rejectedAudit: {
          id: "30000000-0000-4000-8000-000000000098",
          siteId,
          actorId: failedCommand.actorId,
          targetId: failedCampaign.id,
          revisionId: null,
          requestId: failedCommand.requestId,
          inputHash: failedCommand.inputHash,
          action: "campaign.create",
          outcome: "rejected",
          reason: "campaign_revision_conflict",
          beforeState: null,
          afterState: null,
          occurredAt: failedRevision.createdAt,
        },
      }),
    ).rejects.toThrow();
    await expect(
      store.findCommandReceipt(failedCommand),
    ).resolves.toBeNull();
    await expect(
      store.findCampaign({
        siteId,
        campaignId: failedCampaign.id,
      }),
    ).resolves.toBeNull();
  });
});
