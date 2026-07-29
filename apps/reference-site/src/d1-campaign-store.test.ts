import { readFile } from "node:fs/promises";

import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
} from "@foundry/application";
import {
  createRichTextDocumentFromPlainText,
  createSiteId,
} from "@foundry/site-definition";

import { createD1CampaignStore } from "./d1-campaign-store";
import type { D1DatabaseBinding } from "./d1-human-access-store";

let runtime: Miniflare;
let database: Awaited<ReturnType<Miniflare["getD1Database"]>>;
const siteId = createSiteId("site_reference");
const actor: ExternalHumanIdentity = {
  binding: { issuer: "https://access.example", subject: "editor" },
  email: "editor@example.com",
  nonce: "nonce",
};

function migrationStatements(migration: string): string[] {
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
    "0016_campaign_authoring.sql",
    "0018_campaign_test_delivery.sql",
  ]) {
    const migration = await readFile(
      new URL(`../migrations/${name}`, import.meta.url),
      "utf8",
    );
    for (const statement of migrationStatements(migration)) {
      await database.exec(statement);
    }
  }
});

afterEach(async () => runtime.dispose());

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
      schemaVersion: "1.3.0",
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
           failure_code, evidence_json, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, '{}', '[]', 'ambiguous',
           1, NULL, '17', NULL, NULL, ?7, ?7)`,
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
    await application.commands.edit({
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
      campaign: created.campaign,
      revision: created.revision,
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
    const acceptedConfirmation = {
      ...acceptedTest,
      requestId: "campaign-test-confirm-audit-durable-1",
      command: {
        action: "confirm_test_receipt",
        executionId: "40000000-0000-4000-8000-000000000001",
      },
      targetId: "40000000-0000-4000-8000-000000000001",
      commandName: "campaign.confirm_test_receipt" as const,
    };
    await application.commands.recordAcceptedTestCommand(
      acceptedConfirmation,
    );
    await application.commands.recordAcceptedTestCommand(
      acceptedConfirmation,
    );
    await application.commands.replayTestCommand({
      actor,
      requestId: acceptedConfirmation.requestId,
      command: acceptedConfirmation.command,
      targetId: acceptedConfirmation.targetId,
      commandName: acceptedConfirmation.commandName,
    });

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
    ).resolves.toEqual({ count: 7 });
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
        { outcome: "rejected", count: 3 },
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
        { outcome: "rejected", count: 2 },
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
        { campaign_revision_id: created.revision.id },
        { campaign_revision_id: expect.any(String) },
        { campaign_revision_id: expect.any(String) },
        { campaign_revision_id: expect.any(String) },
      ],
    });
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
