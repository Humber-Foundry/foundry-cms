import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  createNewsletterSignupRequestId,
  type NewsletterConfirmationJob,
  type PendingNewsletterSignup,
} from "@humber-foundry/application";
import { createSiteId } from "@humber-foundry/site-definition";

import { createD1NewsletterSignupStore } from "./d1-newsletter-signup-store";
import type { D1DatabaseBinding } from "./d1-human-access-store";
import { useMigratedTestDatabase } from "./test-support/migrated-test-database";

const siteId = createSiteId("site_reference");
const identityKey = "a".repeat(64);
const address = "reader@example.test";
const requestedAt = "2026-03-01T10:00:00.000Z";
const expiresAt = "2026-03-02T10:00:00.000Z";

const { database } = useMigratedTestDatabase(["0029_newsletter_signup.sql"]);

function store() {
  return createD1NewsletterSignupStore(
    database as unknown as D1DatabaseBinding,
  );
}

function pending(
  overrides: Partial<PendingNewsletterSignup> = {},
): PendingNewsletterSignup {
  return {
    id: createNewsletterSignupRequestId("newsletter_signup-1"),
    siteId,
    submissionId: "3f6c2b3a-6f0f-4a19-9d2b-2f52f4a2a111",
    identityKey,
    email: address,
    disclosureVersion: "newsletter-consent-1.0.0",
    collectionSurface: "https://example.test/#section_newsletter",
    requestedAt,
    expiresAt,
    state: "pending",
    settledAt: null,
    ...overrides,
  };
}

function job(
  overrides: Partial<NewsletterConfirmationJob> = {},
): NewsletterConfirmationJob {
  return {
    requestId: createNewsletterSignupRequestId("newsletter_signup-1"),
    siteId,
    address,
    identityKey,
    expiresAt,
    attempts: 0,
    firstAvailableAt: requestedAt,
    ...overrides,
  };
}

async function savedAddresses() {
  const rows = await database
    .prepare(
      `SELECT state, email FROM newsletter_signup_requests ORDER BY id`,
    )
    .all<{ state: string; email: string | null }>();
  return rows.results.map((row: { state: string; email: string | null }) => [
    row.state,
    row.email,
  ]);
}

async function jobAddresses() {
  const rows = await database
    .prepare(
      `SELECT request_id, status, address FROM newsletter_confirmation_jobs`,
    )
    .all<{ request_id: string; status: string; address: string }>();
  return rows.results;
}

describe("the durable newsletter signup store", () => {
  it("writes the request and its confirmation job together", async () => {
    expect(
      await store().savePendingSignup({ pending: pending(), job: job() }),
    ).toStrictEqual({ outcome: "accepted" });
    expect(await savedAddresses()).toStrictEqual([["pending", address]]);
    expect(await jobAddresses()).toStrictEqual([
      {
        request_id: "newsletter_signup-1",
        status: "pending",
        address,
      },
    ]);
  });

  it("treats a repeated submission id as a replay, not a second request", async () => {
    await store().savePendingSignup({ pending: pending(), job: job() });
    expect(
      await store().savePendingSignup({
        pending: pending({
          id: createNewsletterSignupRequestId("newsletter_signup-2"),
        }),
        job: job({
          requestId: createNewsletterSignupRequestId("newsletter_signup-2"),
        }),
      }),
    ).toStrictEqual({ outcome: "replayed" });
    expect(await savedAddresses()).toHaveLength(1);
  });

  it("allows only one pending request per address", async () => {
    await store().savePendingSignup({ pending: pending(), job: job() });
    await expect(
      store().savePendingSignup({
        pending: pending({
          id: createNewsletterSignupRequestId("newsletter_signup-2"),
          submissionId: "3f6c2b3a-6f0f-4a19-9d2b-2f52f4a2a222",
        }),
        job: job({
          requestId: createNewsletterSignupRequestId("newsletter_signup-2"),
        }),
      }),
    ).rejects.toThrow();
  });

  it("clears the address and removes the job when a request is confirmed", async () => {
    await store().savePendingSignup({ pending: pending(), job: job() });
    await store().settlePendingSignup({
      siteId,
      requestId: createNewsletterSignupRequestId("newsletter_signup-1"),
      state: "confirmed",
      settledAt: "2026-03-01T11:00:00.000Z",
    });
    expect(await savedAddresses()).toStrictEqual([["confirmed", null]]);
    expect(await jobAddresses()).toStrictEqual([]);
  });

  it("clears the address when an earlier request is superseded", async () => {
    await store().savePendingSignup({ pending: pending(), job: job() });
    await store().supersedePendingSignups({
      siteId,
      identityKey,
      settledAt: "2026-03-01T11:00:00.000Z",
    });
    expect(await savedAddresses()).toStrictEqual([["superseded", null]]);
    expect(await jobAddresses()).toStrictEqual([]);

    // The address is free for a new pending request again.
    expect(
      await store().savePendingSignup({
        pending: pending({
          id: createNewsletterSignupRequestId("newsletter_signup-2"),
          submissionId: "3f6c2b3a-6f0f-4a19-9d2b-2f52f4a2a222",
        }),
        job: job({
          requestId: createNewsletterSignupRequestId("newsletter_signup-2"),
        }),
      }),
    ).toStrictEqual({ outcome: "accepted" });
  });

  it("clears the address of a request that ran out of time", async () => {
    await store().savePendingSignup({ pending: pending(), job: job() });
    expect(
      await store().expirePendingSignups({
        siteId,
        now: "2026-03-03T10:00:00.000Z",
      }),
    ).toStrictEqual({ expired: 1 });
    expect(await savedAddresses()).toStrictEqual([["expired", null]]);
    expect(await jobAddresses()).toStrictEqual([]);
  });

  it("leaves a request that is still in time alone", async () => {
    await store().savePendingSignup({ pending: pending(), job: job() });
    expect(
      await store().expirePendingSignups({ siteId, now: requestedAt }),
    ).toStrictEqual({ expired: 0 });
    expect(await savedAddresses()).toStrictEqual([["pending", address]]);
  });

  it("refuses to reopen a settled request", async () => {
    await store().savePendingSignup({ pending: pending(), job: job() });
    await store().settlePendingSignup({
      siteId,
      requestId: createNewsletterSignupRequestId("newsletter_signup-1"),
      state: "confirmed",
      settledAt: "2026-03-01T11:00:00.000Z",
    });
    await expect(
      database
        .prepare(
          `UPDATE newsletter_signup_requests SET state = 'pending'
           WHERE id = 'newsletter_signup-1'`,
        )
        .run(),
    ).rejects.toThrow(/newsletter_signup_already_settled/u);
  });

  it("refuses a settled request that still holds an address", async () => {
    await expect(
      database
        .prepare(
          `INSERT INTO newsletter_signup_requests (
             id, site_id, submission_id, identity_key, email,
             disclosure_version, collection_surface, requested_at,
             expires_at, state, settled_at
           ) VALUES ('r2', ?1, 's2', ?2, ?3, 'v1', 'https://example.test/',
                     ?4, ?5, 'confirmed', ?4)`,
        )
        .bind(siteId, identityKey, address, requestedAt, expiresAt)
        .run(),
    ).rejects.toThrow();
  });

  it("claims a due job once, then hands it back for a retry", async () => {
    await store().savePendingSignup({ pending: pending(), job: job() });
    const claimed = await store().claimDueConfirmationJobs({
      siteId,
      now: requestedAt,
      leaseToken: "lease-1",
      leaseUntil: "2026-03-01T10:04:00.000Z",
      limit: 25,
    });
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({ address, attempts: 0 });

    // A second caller cannot take the same job while the lease holds.
    expect(
      await store().claimDueConfirmationJobs({
        siteId,
        now: requestedAt,
        leaseToken: "lease-2",
        leaseUntil: "2026-03-01T10:04:00.000Z",
        limit: 25,
      }),
    ).toStrictEqual([]);

    await store().recordConfirmationOutcome({
      siteId,
      requestId: claimed[0]!.requestId,
      leaseToken: "lease-1",
      outcome: "retry",
      availableAt: "2026-03-01T10:00:30.000Z",
      recordedAt: requestedAt,
    });
    expect(await jobAddresses()).toStrictEqual([
      { request_id: "newsletter_signup-1", status: "pending", address },
    ]);
  });

  it("clears the address once the message is sent", async () => {
    await store().savePendingSignup({ pending: pending(), job: job() });
    const [claimed] = await store().claimDueConfirmationJobs({
      siteId,
      now: requestedAt,
      leaseToken: "lease-1",
      leaseUntil: "2026-03-01T10:04:00.000Z",
      limit: 25,
    });
    await store().recordConfirmationOutcome({
      siteId,
      requestId: claimed!.requestId,
      leaseToken: "lease-1",
      outcome: "sent",
      availableAt: null,
      recordedAt: requestedAt,
    });
    expect(await jobAddresses()).toStrictEqual([
      { request_id: "newsletter_signup-1", status: "sent", address: "" },
    ]);
  });

  it("ignores an outcome from a caller whose lease has gone", async () => {
    await store().savePendingSignup({ pending: pending(), job: job() });
    const [claimed] = await store().claimDueConfirmationJobs({
      siteId,
      now: requestedAt,
      leaseToken: "lease-1",
      leaseUntil: "2026-03-01T10:04:00.000Z",
      limit: 25,
    });
    await store().recordConfirmationOutcome({
      siteId,
      requestId: claimed!.requestId,
      leaseToken: "somebody-elses-lease",
      outcome: "sent",
      availableAt: null,
      recordedAt: requestedAt,
    });
    expect((await jobAddresses())[0]).toMatchObject({ status: "processing" });
  });

  it("gives up on a job whose lease ran out, and clears its address", async () => {
    await store().savePendingSignup({ pending: pending(), job: job() });
    await store().claimDueConfirmationJobs({
      siteId,
      now: requestedAt,
      leaseToken: "lease-1",
      leaseUntil: "2026-03-01T10:04:00.000Z",
      limit: 25,
    });
    await store().claimDueConfirmationJobs({
      siteId,
      now: "2026-03-01T10:10:00.000Z",
      leaseToken: "lease-2",
      leaseUntil: "2026-03-01T10:14:00.000Z",
      limit: 25,
    });
    expect(await jobAddresses()).toStrictEqual([
      { request_id: "newsletter_signup-1", status: "failed", address: "" },
    ]);
  });

  it("finds a request by its submission id and by its own id", async () => {
    await store().savePendingSignup({ pending: pending(), job: job() });
    expect(
      (await store().findPendingSignupBySubmissionId({
        siteId,
        submissionId: "3f6c2b3a-6f0f-4a19-9d2b-2f52f4a2a111",
      }))?.email,
    ).toBe(address);
    expect(
      (await store().findPendingSignupById({
        siteId,
        requestId: createNewsletterSignupRequestId("newsletter_signup-1"),
      }))?.identityKey,
    ).toBe(identityKey);
    expect(
      await store().findPendingSignupById({
        siteId: createSiteId("site_other"),
        requestId: createNewsletterSignupRequestId("newsletter_signup-1"),
      }),
    ).toBeNull();
  });
});
