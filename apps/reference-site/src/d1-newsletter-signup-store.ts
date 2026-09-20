import {
  createNewsletterSignupRequestId,
  type NewsletterConfirmationJob,
  type NewsletterSignupRequestState,
  type NewsletterSignupStore,
  type PendingNewsletterSignup,
} from "@humber-foundry/application";
import { createSiteId } from "@humber-foundry/site-definition";

import type { D1DatabaseBinding } from "./d1-human-access-store";

type SignupRow = {
  id: string;
  site_id: string;
  submission_id: string;
  identity_key: string;
  email: string | null;
  disclosure_version: string;
  collection_surface: string;
  requested_at: string;
  expires_at: string;
  state: NewsletterSignupRequestState;
  settled_at: string | null;
};

type JobRow = {
  request_id: string;
  site_id: string;
  address: string;
  identity_key: string;
  expires_at: string;
  attempts: number;
  first_available_at: string;
};

function pendingSignup(row: SignupRow): PendingNewsletterSignup {
  return Object.freeze({
    id: createNewsletterSignupRequestId(row.id),
    siteId: createSiteId(row.site_id),
    submissionId: row.submission_id,
    identityKey: row.identity_key,
    email: row.email,
    disclosureVersion: row.disclosure_version,
    collectionSurface: row.collection_surface,
    requestedAt: row.requested_at,
    expiresAt: row.expires_at,
    state: row.state,
    settledAt: row.settled_at,
  });
}

function confirmationJob(row: JobRow): NewsletterConfirmationJob {
  return Object.freeze({
    requestId: createNewsletterSignupRequestId(row.request_id),
    siteId: createSiteId(row.site_id),
    address: row.address,
    identityKey: row.identity_key,
    expiresAt: row.expires_at,
    attempts: row.attempts,
    firstAvailableAt: row.first_available_at,
  });
}

/**
 * The durable store behind newsletter signup.
 *
 * Every statement that settles a request clears the address in the same
 * statement, so the database never holds an address for a request that can no
 * longer be confirmed. The table's own CHECK constraint says the same thing, so
 * a future caller that forgets is stopped by SQLite rather than by review.
 */
export function createD1NewsletterSignupStore(
  database: D1DatabaseBinding,
): NewsletterSignupStore {
  return {
    async savePendingSignup({ pending, job }) {
      const results = await database.batch([
        database
          .prepare(
            `INSERT INTO newsletter_signup_requests (
               id, site_id, submission_id, identity_key, email,
               disclosure_version, collection_surface, requested_at,
               expires_at, state, settled_at
             )
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'pending', NULL)
             ON CONFLICT (site_id, submission_id) DO NOTHING`,
          )
          .bind(
            pending.id,
            pending.siteId,
            pending.submissionId,
            pending.identityKey,
            pending.email,
            pending.disclosureVersion,
            pending.collectionSurface,
            pending.requestedAt,
            pending.expiresAt,
          ),
        database
          .prepare(
            `INSERT INTO newsletter_confirmation_jobs (
               request_id, site_id, address, identity_key, expires_at,
               status, attempts, available_at, first_available_at,
               lease_token, lease_until, updated_at
             )
             SELECT ?1, ?2, ?3, ?4, ?5, 'pending', 0, ?6, ?6, NULL, NULL, ?6
             FROM newsletter_signup_requests
             WHERE id = ?1
             ON CONFLICT (request_id) DO NOTHING`,
          )
          .bind(
            job.requestId,
            job.siteId,
            job.address,
            job.identityKey,
            job.expiresAt,
            job.firstAvailableAt,
          ),
      ]);
      return {
        outcome:
          (results[0]?.meta.changes ?? 0) > 0 ? "accepted" : "replayed",
      };
    },

    async findPendingSignupBySubmissionId({ siteId, submissionId }) {
      const row = await database
        .prepare(
          `SELECT * FROM newsletter_signup_requests
           WHERE site_id = ?1 AND submission_id = ?2`,
        )
        .bind(siteId, submissionId)
        .first<SignupRow>();
      return row === null ? null : pendingSignup(row);
    },

    async findPendingSignupById({ siteId, requestId }) {
      const row = await database
        .prepare(
          `SELECT * FROM newsletter_signup_requests
           WHERE site_id = ?1 AND id = ?2`,
        )
        .bind(siteId, requestId)
        .first<SignupRow>();
      return row === null ? null : pendingSignup(row);
    },

    async supersedePendingSignups({ siteId, identityKey, settledAt }) {
      await database
        .prepare(
          `UPDATE newsletter_signup_requests
           SET state = 'superseded', email = NULL, settled_at = ?3
           WHERE site_id = ?1 AND identity_key = ?2 AND state = 'pending'`,
        )
        .bind(siteId, identityKey, settledAt)
        .run();
    },

    async settlePendingSignup({ siteId, requestId, state, settledAt }) {
      await database
        .prepare(
          `UPDATE newsletter_signup_requests
           SET state = ?3, email = NULL, settled_at = ?4
           WHERE site_id = ?1 AND id = ?2 AND state = 'pending'`,
        )
        .bind(siteId, requestId, state, settledAt)
        .run();
    },

    async expirePendingSignups({ siteId, now }) {
      const result = await database
        .prepare(
          `UPDATE newsletter_signup_requests
           SET state = 'expired', email = NULL, settled_at = ?2
           WHERE site_id = ?1 AND state = 'pending' AND expires_at <= ?2`,
        )
        .bind(siteId, now)
        .run();
      return { expired: result.meta.changes ?? 0 };
    },

    async claimDueConfirmationJobs({
      siteId,
      now,
      leaseToken,
      leaseUntil,
      limit,
    }) {
      // A lease that ran out means the previous attempt's outcome is unknown.
      // Give up on it rather than risk a second message to the same person.
      await database
        .prepare(
          `UPDATE newsletter_confirmation_jobs
           SET status = 'failed', address = '', lease_token = NULL,
               lease_until = NULL, updated_at = ?2
           WHERE site_id = ?1 AND status = 'processing' AND lease_until <= ?2`,
        )
        .bind(siteId, now)
        .run();

      await database
        .prepare(
          `UPDATE newsletter_confirmation_jobs
           SET status = 'processing', attempts = attempts + 1,
               lease_token = ?2, lease_until = ?3, updated_at = ?4
           WHERE request_id IN (
             SELECT request_id FROM newsletter_confirmation_jobs
             WHERE site_id = ?1
               AND status = 'pending'
               AND available_at <= ?4
               AND (lease_until IS NULL OR lease_until <= ?4)
             ORDER BY available_at
             LIMIT ?5
           )`,
        )
        .bind(siteId, leaseToken, leaseUntil, now, limit)
        .run();

      const claimed = await database
        .prepare(
          `SELECT request_id, site_id, address, identity_key, expires_at,
                  attempts - 1 AS attempts, first_available_at
           FROM newsletter_confirmation_jobs
           WHERE site_id = ?1 AND status = 'processing' AND lease_token = ?2`,
        )
        .bind(siteId, leaseToken)
        .all<JobRow>();
      return claimed.results.map(confirmationJob);
    },

    async recordConfirmationOutcome({
      siteId,
      requestId,
      leaseToken,
      outcome,
      availableAt,
      recordedAt,
    }) {
      if (outcome === "retry" && availableAt !== null) {
        await database
          .prepare(
            `UPDATE newsletter_confirmation_jobs
             SET status = 'pending', available_at = ?4, lease_token = NULL,
                 lease_until = NULL, updated_at = ?5
             WHERE site_id = ?1 AND request_id = ?2 AND lease_token = ?3`,
          )
          .bind(siteId, requestId, leaseToken, availableAt, recordedAt)
          .run();
        return;
      }
      // A message that was sent, and a message that will never be sent, both
      // stop needing the address.
      await database
        .prepare(
          `UPDATE newsletter_confirmation_jobs
           SET status = ?4, address = '', lease_token = NULL,
               lease_until = NULL, updated_at = ?5
           WHERE site_id = ?1 AND request_id = ?2 AND lease_token = ?3`,
        )
        .bind(
          siteId,
          requestId,
          leaseToken,
          outcome === "sent" ? "sent" : "failed",
          recordedAt,
        )
        .run();
    },
  };
}
