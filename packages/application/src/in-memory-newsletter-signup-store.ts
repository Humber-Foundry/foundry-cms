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
 * enforces with SQL: one pending request per address, an address cleared as
 * soon as a request stops being pending, and a claimed job that another caller
 * cannot claim again before the lease runs out.
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
    async claimDueConfirmationJobs({
      siteId,
      now,
      leaseToken,
      leaseUntil,
      limit,
    }) {
      const claimed: NewsletterConfirmationJob[] = [];
      for (const [id, job] of jobs) {
        if (claimed.length >= limit) break;
        const leaseFree =
          job.leaseUntil === null || Date.parse(job.leaseUntil) <= Date.parse(now);
        if (
          job.siteId !== siteId ||
          (job.status !== "pending" && job.status !== "processing") ||
          Date.parse(job.availableAt) > Date.parse(now) ||
          !leaseFree
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
