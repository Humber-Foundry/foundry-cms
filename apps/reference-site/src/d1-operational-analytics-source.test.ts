import { readFile } from "node:fs/promises";

import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createSiteId } from "@foundry/site-definition";

import { createD1OperationalAnalyticsSource } from "./d1-operational-analytics-source";
import type { D1DatabaseBinding } from "./d1-human-access-store";

let runtime: Miniflare;
let database: Awaited<ReturnType<Miniflare["getD1Database"]>>;
const siteId = createSiteId("site_reference");

function migrationStatements(migration: string): string[] {
  const statements: string[] = [];
  let current = "";
  let inTrigger = false;
  for (const line of migration.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("--")) continue;
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
    "0002_subscriber_ledger.sql",
    "0003_public_forms.sql",
    "0004_public_form_notifications.sql",
  ]) {
    const migration = await readFile(
      new URL(`../migrations/${name}`, import.meta.url),
      "utf8",
    );
    for (const statement of migrationStatements(migration)) {
      await database.prepare(statement).run();
    }
  }
});

afterEach(async () => {
  await runtime.dispose();
});

async function acceptSubmission({
  submissionId,
  acceptedAt,
  classification,
}: {
  submissionId: string;
  acceptedAt: string;
  classification: "accepted" | "suspected_spam";
}) {
  await database
    .prepare(
      `INSERT INTO public_form_submissions (
         site_id, form_id, submission_id, schema_version, receipt_id,
         request_hash, fields_json, accepted_at
       ) VALUES (?1, 'form_contact', ?2, 'v1', ?3, 'hash', '{}', ?4)`,
    )
    .bind(siteId, submissionId, `receipt_${submissionId}`, acceptedAt)
    .run();
  await database
    .prepare(
      `INSERT INTO public_form_classifications (
         id, site_id, form_id, submission_id, classification, classified_at
       ) VALUES (?1, ?2, 'form_contact', ?3, ?4, ?5)`,
    )
    .bind(
      `classification_${submissionId}`,
      siteId,
      submissionId,
      classification,
      acceptedAt,
    )
    .run();
}

async function recordLedgerEvent(eventType: string, occurredAt: string) {
  const id = `event_${eventType}_${occurredAt}`;
  await database
    .prepare(
      `INSERT OR IGNORE INTO subscribers (
         id, site_id, identity_key, email, state, created_at, updated_at
       ) VALUES ('subscriber_1', ?1, 'key', 'person@example.com', 'active',
                 ?2, ?2)`,
    )
    .bind(siteId, occurredAt)
    .run();
  await database
    .prepare(
      `INSERT INTO subscriber_ledger_events (
         id, site_id, subscriber_id, event_type, occurred_at, recorded_at,
         actor_type, actor_membership_id, provider, provider_event_id,
         evidence_json
       ) VALUES (?1, ?2, 'subscriber_1', ?3, ?4, ?4, 'human', 'membership_1',
                 NULL, NULL, ?5)`,
    )
    .bind(
      id,
      siteId,
      eventType,
      occurredAt,
      eventType === "consent_recorded" || eventType === "resubscribed"
        ? '{"source":"dashboard"}'
        : null,
    )
    .run();
}

function source() {
  return createD1OperationalAnalyticsSource(
    database as unknown as D1DatabaseBinding,
    siteId,
  );
}

const window = {
  startUtc: "2026-08-01T00:00:00.000Z",
  endUtc: "2026-08-03T00:00:00.000Z",
  formIds: ["form_contact"],
};

describe("projecting committed operational records", () => {
  it("counts accepted submissions exactly", async () => {
    await acceptSubmission({
      submissionId: "submission_1",
      acceptedAt: "2026-08-01T10:00:00.000Z",
      classification: "accepted",
    });
    await acceptSubmission({
      submissionId: "submission_2",
      acceptedAt: "2026-08-01T11:00:00.000Z",
      classification: "accepted",
    });
    await acceptSubmission({
      submissionId: "submission_3",
      acceptedAt: "2026-08-01T12:00:00.000Z",
      classification: "suspected_spam",
    });

    const measurements = await source().measurements(window);

    expect(
      measurements.find(
        (entry) =>
          entry.metricKey === "form.submissions_accepted" &&
          entry.bucketStartUtc === "2026-08-01T00:00:00.000Z",
      ),
    ).toMatchObject({ value: 2, quality: "exact", subjectId: "form_contact" });
    expect(
      measurements.find(
        (entry) =>
          entry.metricKey === "form.submissions_blocked" &&
          entry.bucketStartUtc === "2026-08-01T00:00:00.000Z",
      ),
    ).toMatchObject({ value: 1 });
  });

  it("reports a day with no activity as a measured zero", async () => {
    const measurements = await source().measurements(window);

    const days = measurements.filter(
      (entry) => entry.metricKey === "form.submissions_accepted",
    );
    expect(days).toHaveLength(2);
    expect(days.every((entry) => entry.value === 0)).toBe(true);
    expect(days.every((entry) => entry.unavailableReason === null)).toBe(true);
  });

  it("counts consent and suppression transitions", async () => {
    await recordLedgerEvent("consent_recorded", "2026-08-01T09:00:00.000Z");
    await recordLedgerEvent("unsubscribed", "2026-08-01T10:00:00.000Z");
    await recordLedgerEvent("complained", "2026-08-02T10:00:00.000Z");

    const measurements = await source().measurements(window);
    const onDay = (metricKey: string, day: string) =>
      measurements.find(
        (entry) =>
          entry.metricKey === metricKey &&
          entry.bucketStartUtc === `${day}T00:00:00.000Z`,
      );

    expect(onDay("subscriber.confirmed", "2026-08-01")).toMatchObject({
      value: 1,
    });
    expect(onDay("subscriber.unsubscribed", "2026-08-01")).toMatchObject({
      value: 1,
    });
    expect(onDay("subscriber.complained", "2026-08-02")).toMatchObject({
      value: 1,
    });
    expect(
      measurements.some((entry) =>
        JSON.stringify(entry).includes("person@example.com"),
      ),
    ).toBe(false);
  });

  it("reports a shrinking list as negative net growth", async () => {
    await recordLedgerEvent("unsubscribed", "2026-08-01T10:00:00.000Z");
    await recordLedgerEvent("hard_bounced", "2026-08-01T11:00:00.000Z");

    const measurements = await source().measurements(window);

    expect(
      measurements.find(
        (entry) =>
          entry.metricKey === "subscriber.net_growth" &&
          entry.bucketStartUtc === "2026-08-01T00:00:00.000Z",
      ),
    ).toMatchObject({ value: -2, quality: "derived_exact" });
  });

  it("snapshots the active count once, at the end of the window", async () => {
    await recordLedgerEvent("consent_recorded", "2026-08-01T09:00:00.000Z");

    const measurements = await source().measurements(window);
    const active = measurements.filter(
      (entry) => entry.metricKey === "subscriber.active",
    );

    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({
      value: 1,
      bucketStartUtc: "2026-08-02T00:00:00.000Z",
    });
  });

  it("counts delivered and failed staff notifications per form", async () => {
    await acceptSubmission({
      submissionId: "submission_1",
      acceptedAt: "2026-08-01T10:00:00.000Z",
      classification: "accepted",
    });
    await database
      .prepare(
        `INSERT INTO public_form_delivery_intents (
           id, site_id, form_id, submission_id, status, created_at
         ) VALUES ('delivery_1', ?1, 'form_contact', 'submission_1',
                   'pending', '2026-08-01T10:00:00.000Z')`,
      )
      .bind(siteId)
      .run();
    await database
      .prepare(
        `INSERT INTO public_form_notification_jobs (
           delivery_id, status, attempts, available_at, first_available_at,
           delivered_at, updated_at
         ) VALUES ('delivery_1', 'delivered', 1, '2026-08-01T10:00:00.000Z',
                   '2026-08-01T10:00:00.000Z', '2026-08-01T10:05:00.000Z',
                   '2026-08-01T10:05:00.000Z')`,
      )
      .run();

    const measurements = await source().measurements(window);

    expect(
      measurements.find(
        (entry) =>
          entry.metricKey === "form.notifications_delivered" &&
          entry.bucketStartUtc === "2026-08-01T00:00:00.000Z",
      ),
    ).toMatchObject({ value: 1, subjectId: "form_contact" });
    expect(
      measurements.find(
        (entry) =>
          entry.metricKey === "form.notifications_failed" &&
          entry.bucketStartUtc === "2026-08-01T00:00:00.000Z",
      ),
    ).toMatchObject({ value: 0 });
  });
});
