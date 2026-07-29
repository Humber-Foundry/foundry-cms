import { readFile } from "node:fs/promises";

import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createCampaignId,
  createCampaignRevisionId,
  type CampaignTestDeliveryOperation,
} from "@foundry/application";
import { createSiteId } from "@foundry/site-definition";

import { createD1CampaignTestDeliveryStore } from "./d1-campaign-test-delivery-store";
import type { D1DatabaseBinding } from "./d1-human-access-store";

let runtime: Miniflare;
let database: Awaited<ReturnType<Miniflare["getD1Database"]>>;

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

afterEach(async () => runtime.dispose());

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
      providerCampaignId: null,
      failureCode: null,
      evidence: null,
      createdAt: "2026-07-29T19:05:00.000Z",
      updatedAt: "2026-07-29T19:05:00.000Z",
    };
    await store.claim(pending);
    const accepted: CampaignTestDeliveryOperation = {
      ...pending,
      state: "accepted",
      providerCampaignId: "17",
      evidence: {
        ...pending.binding,
        executionId: pending.executionId,
        providerCampaignId: "17",
        providerReceiptHash: "2".repeat(64),
        acceptedAt: "2026-07-29T19:06:00.000Z",
      },
      updatedAt: "2026-07-29T19:06:00.000Z",
    };

    await expect(store.record(accepted)).resolves.toEqual(accepted);
    const raw = await database
      .prepare(
        `SELECT binding_json, recipient_ids_json, evidence_json
         FROM campaign_test_deliveries WHERE execution_id = ?1`,
      )
      .bind(pending.executionId)
      .first<Record<string, string>>();
    expect(JSON.stringify(raw)).not.toContain("@");
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
