import type {
  NewsletterConfirmationJob,
  NewsletterSignupStore,
  PendingNewsletterSignup,
} from "./newsletter-signup";

type JobRow = NewsletterConfirmationJob & {
  status: "pending" | "processing" | "sent" | "failed";
  availableAt: string;
  leaseToken: string | null;
  leaseUntil: string | null;
};

/**
 * The store the domain tests run against. It keeps the same rules the D1 store
 * enforces with SQL, in the same order:
 *
 * - a repeated submission id changes nothing at all, because it is a retry of
 *   one signup rather than a second one;
 * - otherwise one pending request per address, the earlier one superseded in
 *   the same step as the new one is written;
 * - an address cleared as soon as a request stops being pending;
 * - a claimed job another caller cannot claim again before the lease runs out;
 * - a message that will never be sent settles its request, so nobody is left
 *   waiting for a link that is not coming.
 */
export function createInMemoryNewsletterSignupStore(): NewsletterSignupStore & {
  listSignups(): ReadonlyArray<PendingNewsletterSignup>;
  listJobs(): ReadonlyArray<JobRow>;
} {
  const signups = new Map<string, PendingNewsletterSignup>();
  const jobs = new Map<string, JobRow>();

  return {
    listSignups() {
      return [...signups.values()];
    },
    listJobs() {
      return [...jobs.values()];
    },
    async savePendingSignup({ pending, job }) {
      const replayed = [...signups.values()].some(
        (candidate) =>
          candidate.siteId === pending.siteId &&
          candidate.submissionId === pending.submissionId,
      );
      if (replayed) return { outcome: "replayed" };
      // Superseding happens here, with the insert, the way the D1 store does it
      // in one transaction.
      for (const [id, candidate] of signups) {
        if (
          candidate.siteId === pending.siteId &&
          candidate.identityKey === pending.identityKey &&
          candidate.state === "pending"
        ) {
          signups.set(id, {
            ...candidate,
            email: null,
            state: "superseded",
            settledAt: pending.requestedAt,
          });
          jobs.delete(id);
        }
      }
      signups.set(pending.id, pending);
      jobs.set(pending.id, {
        ...job,
        status: "pending",
        availableAt: job.firstAvailableAt,
        leaseToken: null,
        leaseUntil: null,
      });
      return { outcome: "accepted" };
    },
    async findPendingSignupBySubmissionId({ siteId, submissionId }) {
      return (
        [...signups.values()].find(
          (candidate) =>
            candidate.siteId === siteId &&
            candidate.submissionId === submissionId,
        ) ?? null
      );
    },
    async findPendingSignupById({ siteId, requestId }) {
      const found = signups.get(requestId);
      return found !== undefined && found.siteId === siteId ? found : null;
    },
    async settlePendingSignup({ siteId, requestId, state, settledAt }) {
      const found = signups.get(requestId);
      if (found === undefined || found.siteId !== siteId) return;
      signups.set(requestId, { ...found, email: null, state, settledAt });
      jobs.delete(requestId);
    },
    async expirePendingSignups({ siteId, now }) {
      let expired = 0;
      for (const [id, candidate] of signups) {
        if (
          candidate.siteId === siteId &&
          candidate.state === "pending" &&
          Date.parse(candidate.expiresAt) <= Date.parse(now)
        ) {
          signups.set(id, {
            ...candidate,
            email: null,
            state: "expired",
            settledAt: now,
          });
          jobs.delete(id);
          expired += 1;
        }
      }
      return { expired };
    },
    async countPendingSignups({ siteId, now }) {
      let count = 0;
      for (const candidate of signups.values()) {
        if (
          candidate.siteId === siteId &&
          candidate.state === "pending" &&
          Date.parse(candidate.expiresAt) > Date.parse(now)
        ) {
          count += 1;
        }
      }
      return count;
    },
    async claimDueConfirmationJobs({
      siteId,
      now,
      leaseToken,
      leaseUntil,
      limit,
    }) {
      // A lease that ran out means the previous attempt's outcome is unknown.
      // Give up on it rather than risk a second message to the same person, and
      // settle the request it belonged to: no message is coming, so there is
      // nothing left to confirm and no reason to hold the address. The D1 store
      // does exactly this before it claims anything.
      for (const [id, job] of jobs) {
        if (
          job.siteId !== siteId ||
          job.status !== "processing" ||
          job.leaseUntil === null ||
          Date.parse(job.leaseUntil) > Date.parse(now)
        ) {
          continue;
        }
        const signup = signups.get(id);
        if (signup !== undefined && signup.state === "pending") {
          signups.set(id, {
            ...signup,
            email: null,
            state: "expired",
            settledAt: now,
          });
        }
        jobs.delete(id);
      }

      const claimed: NewsletterConfirmationJob[] = [];
      for (const [id, job] of jobs) {
        if (claimed.length >= limit) break;
        if (
          job.siteId !== siteId ||
          job.status !== "pending" ||
          Date.parse(job.availableAt) > Date.parse(now) ||
          (job.leaseUntil !== null &&
            Date.parse(job.leaseUntil) > Date.parse(now))
        ) {
          continue;
        }
        const next: JobRow = {
          ...job,
          attempts: job.attempts + 1,
          status: "processing",
          leaseToken,
          leaseUntil,
        };
        jobs.set(id, next);
        claimed.push({
          requestId: next.requestId,
          siteId: next.siteId,
          address: next.address,
          identityKey: next.identityKey,
          expiresAt: next.expiresAt,
          attempts: job.attempts,
          firstAvailableAt: next.firstAvailableAt,
        });
      }
      return claimed;
    },
    async recordConfirmationOutcome({
      siteId,
      requestId,
      leaseToken,
      outcome,
      availableAt,
      recordedAt,
    }) {
      const job = jobs.get(requestId);
      if (
        job === undefined ||
        job.siteId !== siteId ||
        job.leaseToken !== leaseToken
      ) {
        return;
      }
      if (outcome === "sent") {
        jobs.set(requestId, {
          ...job,
          status: "sent",
          leaseToken: null,
          leaseUntil: null,
        });
        return;
      }
      if (outcome === "retry" && availableAt !== null) {
        jobs.set(requestId, {
          ...job,
          status: "pending",
          availableAt,
          leaseToken: null,
          leaseUntil: null,
        });
        return;
      }
      // The message will never be sent. Settle the request and drop the job,
      // which is what the D1 store's trigger does.
      const signup = signups.get(requestId);
      if (signup !== undefined && signup.state === "pending") {
        signups.set(requestId, {
          ...signup,
          email: null,
          state: "expired",
          settledAt: recordedAt,
        });
      }
      jobs.set(requestId, {
        ...job,
        status: "failed",
        address: "",
        leaseToken: null,
        leaseUntil: null,
      });
    },
  };
}
