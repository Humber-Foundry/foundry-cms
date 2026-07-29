import { readFile } from "node:fs/promises";

import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  campaignAudienceDefinition,
  createCampaignApplication,
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
  const migration = await readFile(
    new URL("../migrations/0016_campaign_authoring.sql", import.meta.url),
    "utf8",
  );
  for (const statement of migrationStatements(migration)) {
    await database.exec(statement);
  }
});

afterEach(async () => runtime.dispose());

describe("D1 campaign store", () => {
  it("atomically persists immutable revisions with linked audit evidence", async () => {
    let id = 0;
    const application = createCampaignApplication({
      siteId,
      store: createD1CampaignStore(
        database as unknown as D1DatabaseBinding,
      ),
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
    await application.queries.render({
      actor,
      campaignId: created.campaign.id,
    });
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
    ).resolves.toEqual({ count: 2 });
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
  });
});
