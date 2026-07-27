import { readFile } from "node:fs/promises";

import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  createPublicFormAuditEventId,
  createPublicFormClassificationId,
  createPublicFormDeliveryId,
  createPublicFormId,
  createPublicFormOutboxEventId,
  createPublicFormReceiptId,
  createPublicFormRequestHash,
  createPublicFormSubmissionId,
  type PublicFormAcceptance,
} from "@foundry/application";
import { createSiteId } from "@foundry/site-definition";

import { createD1PublicFormAcceptanceStore } from "./d1-public-form-store";

let runtime: Miniflare;
let database: Awaited<ReturnType<Miniflare["getD1Database"]>>;

function migrationStatements(migration: string): string[] {
  const statements: string[] = [];
  let current = "";
  let inTrigger = false;
  for (const line of migration.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") {
      continue;
    }
    current += ` ${trimmed}`;
    if (trimmed.startsWith("CREATE TRIGGER")) {
      inTrigger = true;
    }
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

const acceptance: PublicFormAcceptance = {
  identity: {
    siteId: createSiteId("site_reference"),
    formId: createPublicFormId("contact"),
    submissionId: createPublicFormSubmissionId(
      "00000000-0000-4000-8000-000000000046",
    ),
  },
  schemaVersion: "1.0.0",
  receiptId: createPublicFormReceiptId(
    "receipt_01J00000000000000000000000",
  ),
  requestHash: createPublicFormRequestHash("payload-sha256"),
  fields: { name: "Ada", message: "Please tell me more." },
  classification: "accepted",
  deliveryStatus: "pending",
  classificationId: createPublicFormClassificationId(
    "classification_01J00000000000000000000000",
  ),
  auditEventId: createPublicFormAuditEventId(
    "audit_01J00000000000000000000000",
  ),
  deliveryId: createPublicFormDeliveryId(
    "delivery_01J00000000000000000000000",
  ),
  outboxEventId: createPublicFormOutboxEventId(
    "outbox_01J00000000000000000000000",
  ),
  acceptedAt: "2026-07-27T20:00:00.000Z",
};

beforeEach(async () => {
  runtime = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    d1Databases: ["FOUNDRY_DB"],
  });
  database = await runtime.getD1Database("FOUNDRY_DB");
  const migration = await readFile(
    new URL("../migrations/0003_public_forms.sql", import.meta.url),
    "utf8",
  );
  for (const statement of migrationStatements(migration)) {
    await database.exec(statement);
  }
});

afterEach(async () => {
  await runtime.dispose();
});

describe("D1 public form acceptance store", () => {
  it("atomically persists the complete acceptance and replays without duplicates", async () => {
    const store = createD1PublicFormAcceptanceStore(database);

    await expect(store.accept(acceptance)).resolves.toEqual({
      outcome: "accepted",
      receiptId: acceptance.receiptId,
    });
    await expect(
      store.findReceipt({
        identity: acceptance.identity,
        requestHash: acceptance.requestHash,
      }),
    ).resolves.toEqual({
      outcome: "replayed",
      receiptId: acceptance.receiptId,
    });
    await expect(store.accept(acceptance)).resolves.toEqual({
      outcome: "replayed",
      receiptId: acceptance.receiptId,
    });

    for (const table of [
      "public_form_submissions",
      "public_form_classifications",
      "public_form_audit_events",
      "public_form_delivery_intents",
      "public_form_outbox_events",
    ]) {
      const row = await database
        .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
        .first<{ count: number }>();
      expect(row?.count, table).toBe(1);
    }
  });

  it("rejects a changed retry and prevents mutation of an accepted submission", async () => {
    const store = createD1PublicFormAcceptanceStore(database);
    await store.accept(acceptance);

    await expect(
      store.findReceipt({
        identity: acceptance.identity,
        requestHash: createPublicFormRequestHash(
          "different-payload-sha256",
        ),
      }),
    ).resolves.toEqual({ outcome: "conflict" });
    await expect(
      database
        .prepare(
          `UPDATE public_form_submissions
           SET fields_json = ?1
           WHERE site_id = ?2 AND form_id = ?3 AND submission_id = ?4`,
        )
        .bind(
          "{}",
          acceptance.identity.siteId,
          acceptance.identity.formId,
          acceptance.identity.submissionId,
        )
        .run(),
    ).rejects.toThrow();
  });

  it("rolls back every acceptance fact when any statement cannot persist", async () => {
    await database
      .prepare(
        `INSERT INTO public_form_audit_events (
           id, site_id, event_type, subject_id, occurred_at
         ) VALUES (?1, ?2, 'submission_accepted', ?3, ?4)`,
      )
      .bind(
        acceptance.auditEventId,
        acceptance.identity.siteId,
        "different:submission",
        acceptance.acceptedAt,
      )
      .run();
    const store = createD1PublicFormAcceptanceStore(database);

    await expect(store.accept(acceptance)).rejects.toThrow();

    for (const table of [
      "public_form_submissions",
      "public_form_classifications",
      "public_form_delivery_intents",
      "public_form_outbox_events",
    ]) {
      const row = await database
        .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
        .first<{ count: number }>();
      expect(row?.count, table).toBe(0);
    }
  });
});
