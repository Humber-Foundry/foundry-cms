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

import { createD1PublicFormNotificationStore } from "./d1-public-form-notification-store";
import { createD1PublicFormAcceptanceStore } from "./d1-public-form-store";

let runtime: Miniflare;
let database: Awaited<ReturnType<Miniflare["getD1Database"]>>;

function statements(migration: string) {
  const result: string[] = [];
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
      result.push(current.trim());
      current = "";
      inTrigger = false;
    }
  }
  return result;
}

const siteId = createSiteId("site_reference");
const accepted: PublicFormAcceptance = {
  identity: {
    siteId,
    formId: createPublicFormId("contact"),
    submissionId: createPublicFormSubmissionId(
      "00000000-0000-4000-8000-000000000047",
    ),
  },
  schemaVersion: "1.0.0",
  receiptId: createPublicFormReceiptId("receipt-47"),
  requestHash: createPublicFormRequestHash("hash-47"),
  fields: { name: "Ada", message: "Private full submission" },
  classification: "accepted",
  deliveryStatus: "pending",
  classificationId: createPublicFormClassificationId("classification-47"),
  auditEventId: createPublicFormAuditEventId("audit-47"),
  deliveryId: createPublicFormDeliveryId("delivery-47"),
  outboxEventId: createPublicFormOutboxEventId("outbox-47"),
  acceptedAt: "2026-07-27T20:00:00.000Z",
};

beforeEach(async () => {
  runtime = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    d1Databases: ["FOUNDRY_DB"],
  });
  database = await runtime.getD1Database("FOUNDRY_DB");
  for (const name of [
    "0003_public_forms.sql",
    "0004_public_form_notifications.sql",
  ]) {
    const migration = await readFile(
      new URL(`../migrations/${name}`, import.meta.url),
      "utf8",
    );
    for (const statement of statements(migration)) {
      await database.exec(statement);
    }
  }
});

afterEach(() => runtime.dispose());

describe("D1 public form notification store", () => {
  it("claims once, exposes only configured preview fields, and records delivery", async () => {
    await createD1PublicFormAcceptanceStore(database).accept(accepted);
    const store = createD1PublicFormNotificationStore(database);

    const claim = await store.claimDue({
      siteId,
      now: "2026-07-27T20:05:00.000Z",
      leaseToken: "lease-1",
      leaseUntil: "2026-07-27T20:09:00.000Z",
      limit: 25,
    });
    expect(claim).toEqual([
      expect.objectContaining({
        deliveryId: accepted.deliveryId,
        previewFields: { name: "Ada" },
        attempt: 1,
      }),
    ]);
    expect(JSON.stringify(claim)).not.toContain("Private full submission");
    await expect(
      store.claimDue({
        siteId,
        now: "2026-07-27T20:05:00.000Z",
        leaseToken: "lease-2",
        leaseUntil: "2026-07-27T20:09:00.000Z",
        limit: 25,
      }),
    ).resolves.toEqual([]);
    await expect(
      store.recordOutcome({
        siteId,
        deliveryId: accepted.deliveryId,
        leaseToken: "lease-1",
        outcome: { outcome: "sent", providerReference: "provider-1" },
        now: "2026-07-27T20:05:01.000Z",
        nextAttemptAt: null,
      }),
    ).resolves.toBe(true);
  });

  it("keeps failures replayable without changing the accepted submission", async () => {
    await createD1PublicFormAcceptanceStore(database).accept(accepted);
    const store = createD1PublicFormNotificationStore(database);
    await store.claimDue({
      siteId,
      now: "2026-07-27T20:05:00.000Z",
      leaseToken: "lease-1",
      leaseUntil: "2026-07-27T20:09:00.000Z",
      limit: 25,
    });
    await store.recordOutcome({
      siteId,
      deliveryId: accepted.deliveryId,
      leaseToken: "lease-1",
      outcome: { outcome: "permanent_failure", code: "rejected" },
      now: "2026-07-27T20:05:01.000Z",
      nextAttemptAt: null,
    });
    await expect(
      store.replayFailed({
        siteId,
        deliveryId: accepted.deliveryId,
        actorMembershipId: "membership-owner",
        now: "2026-07-27T20:06:00.000Z",
      }),
    ).resolves.toBe(true);
    const submission = await database
      .prepare(
        "SELECT fields_json FROM public_form_submissions WHERE receipt_id = ?1",
      )
      .bind(accepted.receiptId)
      .first<{ fields_json: string }>();
    expect(submission?.fields_json).toContain("Private full submission");
  });

  it("lists held spam without payload and releases it for authorized delivery", async () => {
    const held: PublicFormAcceptance = {
      ...accepted,
      classification: "suspected_spam",
      deliveryStatus: "held",
    };
    await createD1PublicFormAcceptanceStore(database).accept(held);
    const store = createD1PublicFormNotificationStore(database);

    await expect(store.listSuspectedSpam({ siteId })).resolves.toEqual([
      {
        formId: held.identity.formId,
        receiptId: held.receiptId,
        acceptedAt: held.acceptedAt,
      },
    ]);
    await expect(
      store.releaseSuspectedSpam({
        siteId,
        receiptId: held.receiptId,
        actorMembershipId: "membership-editor",
        now: "2026-07-27T20:10:00.000Z",
      }),
    ).resolves.toBe(true);
    await expect(
      store.claimDue({
        siteId,
        now: "2026-07-27T20:10:00.000Z",
        leaseToken: "lease-review",
        leaseUntil: "2026-07-27T20:14:00.000Z",
        limit: 25,
      }),
    ).resolves.toHaveLength(1);
  });
});
