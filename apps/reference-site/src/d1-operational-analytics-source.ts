import "server-only";

import {
  analyticsCompositeKey,
  type AnalyticsFactMeasurement,
  type AnalyticsMetricKey,
} from "@foundry/application";
import type { SiteId } from "@foundry/site-definition";

import type { D1DatabaseBinding } from "./d1-human-access-store";

/**
 * Projects the operational D1 tables the CMS already commits to. These are the
 * only exact analytics values in the product, because the same transaction
 * that accepted a submission or applied a suppression recorded them.
 *
 * Nothing here reads a submission payload, a contact detail, consent evidence
 * or a suppression reason. Only counts leave this module.
 */

export const operationalAnalyticsSourceName = "foundry";
export const operationalAnalyticsDefinitionVersion = 1;

type CountRow = { day: string; subject: string; total: number };

function dayBucket(day: string) {
  const bucketStartUtc = `${day}T00:00:00.000Z`;
  return {
    bucketStartUtc,
    bucketEndUtc: new Date(
      Date.parse(bucketStartUtc) + 86_400_000,
    ).toISOString(),
  };
}

function utcDaysBetween(startUtc: string, endUtc: string): string[] {
  const days: string[] = [];
  for (
    let instant = Date.parse(`${startUtc.slice(0, 10)}T00:00:00.000Z`);
    instant < Date.parse(endUtc);
    instant += 86_400_000
  ) {
    days.push(new Date(instant).toISOString().slice(0, 10));
  }
  return days;
}

function countMeasurement({
  metricKey,
  day,
  subjectType,
  subjectId,
  value,
  quality = "exact",
}: {
  metricKey: AnalyticsMetricKey;
  day: string;
  subjectType: AnalyticsFactMeasurement["subjectType"];
  subjectId: string;
  value: number;
  quality?: AnalyticsFactMeasurement["quality"];
}): AnalyticsFactMeasurement {
  return {
    metricKey,
    ...dayBucket(day),
    granularity: "day",
    subjectType,
    subjectId,
    dimension: { key: "", value: "" },
    unit: "count",
    quality,
    sampleInterval: 1,
    value,
    unavailableReason: null,
  };
}

const ledgerMetricByEvent: Readonly<Record<string, AnalyticsMetricKey>> =
  Object.freeze({
    consent_recorded: "subscriber.confirmed",
    resubscribed: "subscriber.confirmed",
    unsubscribed: "subscriber.unsubscribed",
    hard_bounced: "subscriber.hard_bounced",
    complained: "subscriber.complained",
  });

const suppressingMetrics: ReadonlyArray<AnalyticsMetricKey> = Object.freeze([
  "subscriber.unsubscribed",
  "subscriber.hard_bounced",
  "subscriber.complained",
]);

export function createD1OperationalAnalyticsSource(
  database: D1DatabaseBinding,
  siteId: SiteId,
) {
  async function countsByDayAndSubject(
    sql: string,
    parameters: ReadonlyArray<string>,
  ): Promise<ReadonlyArray<CountRow>> {
    const { results } = await database
      .prepare(sql)
      .bind(...parameters)
      .all<CountRow>();
    return results;
  }

  return {
    /** The forms that have ever received a submission on this site. */
    async listFormIds(): Promise<ReadonlyArray<string>> {
      const { results } = await database
        .prepare(
          `SELECT DISTINCT form_id FROM public_form_submissions
           WHERE site_id = ?1 ORDER BY form_id`,
        )
        .bind(siteId)
        .all<{ form_id: string }>();
      return results.map((row) => row.form_id);
    },

    /**
     * Every D1 metric is zero-filled across the window. A day with no
     * submissions therefore records a measured zero, which the dashboard
     * shows as the real count it is. A source that reported nothing at all
     * records `unavailable`, and the dashboard shows that differently.
     */
    async measurements({
      startUtc,
      endUtc,
      formIds,
    }: {
      startUtc: string;
      endUtc: string;
      formIds: ReadonlyArray<string>;
    }): Promise<ReadonlyArray<AnalyticsFactMeasurement>> {
      const days = utcDaysBetween(startUtc, endUtc);
      const [
        accepted,
        blocked,
        delivered,
        failed,
        ledger,
        activeRow,
      ] = await Promise.all([
        countsByDayAndSubject(
          `SELECT substr(submission.accepted_at, 1, 10) AS day,
                  submission.form_id AS subject,
                  COUNT(*) AS total
           FROM public_form_submissions AS submission
           JOIN public_form_classifications AS classification
             ON classification.site_id = submission.site_id
            AND classification.form_id = submission.form_id
            AND classification.submission_id = submission.submission_id
           WHERE submission.site_id = ?1
             AND submission.accepted_at >= ?2
             AND submission.accepted_at < ?3
             AND classification.classification = 'accepted'
           GROUP BY day, subject`,
          [siteId, startUtc, endUtc],
        ),
        countsByDayAndSubject(
          `SELECT substr(submission.accepted_at, 1, 10) AS day,
                  submission.form_id AS subject,
                  COUNT(*) AS total
           FROM public_form_submissions AS submission
           JOIN public_form_classifications AS classification
             ON classification.site_id = submission.site_id
            AND classification.form_id = submission.form_id
            AND classification.submission_id = submission.submission_id
           WHERE submission.site_id = ?1
             AND submission.accepted_at >= ?2
             AND submission.accepted_at < ?3
             AND classification.classification = 'suspected_spam'
           GROUP BY day, subject`,
          [siteId, startUtc, endUtc],
        ),
        countsByDayAndSubject(
          `SELECT substr(job.delivered_at, 1, 10) AS day,
                  intent.form_id AS subject,
                  COUNT(*) AS total
           FROM public_form_notification_jobs AS job
           JOIN public_form_delivery_intents AS intent
             ON intent.id = job.delivery_id
           WHERE intent.site_id = ?1
             AND job.status = 'delivered'
             AND job.delivered_at >= ?2
             AND job.delivered_at < ?3
           GROUP BY day, subject`,
          [siteId, startUtc, endUtc],
        ),
        countsByDayAndSubject(
          `SELECT substr(job.updated_at, 1, 10) AS day,
                  intent.form_id AS subject,
                  COUNT(*) AS total
           FROM public_form_notification_jobs AS job
           JOIN public_form_delivery_intents AS intent
             ON intent.id = job.delivery_id
           WHERE intent.site_id = ?1
             AND job.status = 'failed'
             AND job.updated_at >= ?2
             AND job.updated_at < ?3
           GROUP BY day, subject`,
          [siteId, startUtc, endUtc],
        ),
        countsByDayAndSubject(
          `SELECT substr(occurred_at, 1, 10) AS day,
                  event_type AS subject,
                  COUNT(*) AS total
           FROM subscriber_ledger_events
           WHERE site_id = ?1
             AND occurred_at >= ?2
             AND occurred_at < ?3
             AND event_type <> 'erased'
           GROUP BY day, subject`,
          [siteId, startUtc, endUtc],
        ),
        database
          .prepare(
            `SELECT COUNT(*) AS total FROM subscribers
             WHERE site_id = ?1 AND state = 'active'`,
          )
          .bind(siteId)
          .first<{ total: number }>(),
      ]);

      const lookup = (rows: ReadonlyArray<CountRow>) =>
        new Map(
          rows.map((row) => [
            analyticsCompositeKey([row.day, row.subject]),
            row.total,
          ]),
        );
      const acceptedByKey = lookup(accepted);
      const blockedByKey = lookup(blocked);
      const deliveredByKey = lookup(delivered);
      const failedByKey = lookup(failed);

      const measurements: AnalyticsFactMeasurement[] = [];

      for (const day of days) {
        for (const formId of formIds) {
          const key = analyticsCompositeKey([day, formId]);
          measurements.push(
            countMeasurement({
              metricKey: "form.submissions_accepted",
              day,
              subjectType: "form",
              subjectId: formId,
              value: acceptedByKey.get(key) ?? 0,
            }),
            countMeasurement({
              metricKey: "form.submissions_blocked",
              day,
              subjectType: "form",
              subjectId: formId,
              value: blockedByKey.get(key) ?? 0,
            }),
            countMeasurement({
              metricKey: "form.notifications_delivered",
              day,
              subjectType: "form",
              subjectId: formId,
              value: deliveredByKey.get(key) ?? 0,
            }),
            countMeasurement({
              metricKey: "form.notifications_failed",
              day,
              subjectType: "form",
              subjectId: formId,
              value: failedByKey.get(key) ?? 0,
            }),
          );
        }

        const ledgerTotals = new Map<string, number>();
        for (const row of ledger) {
          if (row.day !== day) continue;
          const metricKey = ledgerMetricByEvent[row.subject];
          if (metricKey === undefined) continue;
          ledgerTotals.set(
            metricKey,
            (ledgerTotals.get(metricKey) ?? 0) + row.total,
          );
        }
        for (const metricKey of Object.values(ledgerMetricByEvent)) {
          measurements.push(
            countMeasurement({
              metricKey,
              day,
              subjectType: "site",
              subjectId: siteId,
              value: ledgerTotals.get(metricKey) ?? 0,
            }),
          );
        }
        const confirmed = ledgerTotals.get("subscriber.confirmed") ?? 0;
        const exits = suppressingMetrics.reduce(
          (total, metricKey) => total + (ledgerTotals.get(metricKey) ?? 0),
          0,
        );
        measurements.push(
          countMeasurement({
            metricKey: "subscriber.net_growth",
            day,
            subjectType: "site",
            subjectId: siteId,
            // A shrinking list reports a real negative. Net growth is the one
            // canonical metric whose declared domain is signed.
            value: confirmed - exits,
            quality: "derived_exact",
          }),
        );
      }

      const latestDay = days.at(-1);
      if (latestDay !== undefined) {
        measurements.push(
          countMeasurement({
            metricKey: "subscriber.active",
            day: latestDay,
            subjectType: "site",
            subjectId: siteId,
            value: activeRow?.total ?? 0,
          }),
        );
      }

      return measurements;
    },
  };
}
