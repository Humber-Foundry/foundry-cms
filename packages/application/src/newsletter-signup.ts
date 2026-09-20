import type { SiteId } from "@humber-foundry/site-definition";

import { sha256Text } from "./deterministic-hash";

import {
  InvalidSubscriberEmailError,
  createSubscriberId,
  createSubscriberEventId,
  normalizeSubscriberEmail,
  type ConsentEvidence,
  type Subscriber,
  type SubscriberEvent,
  type SubscriberState,
  type SubscriberLedgerStore,
} from "./subscriber-ledger";

/**
 * Newsletter signup with double opt-in.
 *
 * A visitor who types an address into the public form is not a subscriber. The
 * form writes a pending signup request instead. Only the person who opens the
 * signed link in the confirmation message turns that request into a subscriber
 * row, so an address typed by somebody else never joins the list.
 *
 * Two rules shape every function here.
 *
 * 1. The public answer never depends on the address. A new address, an address
 *    that is already subscribed, an unsubscribed address and an address that
 *    can never be re-added all produce the same public outcome, so the form
 *    cannot be used to find out who is on the list.
 * 2. A confirmed subscriber is the only kind of subscriber. Bulk sending reads
 *    the subscriber ledger, and a pending request is not in it.
 */

declare const newsletterSignupRequestIdBrand: unique symbol;

export type NewsletterSignupRequestId = string & {
  readonly [newsletterSignupRequestIdBrand]: "newsletter_signup_request";
};

export const createNewsletterSignupRequestId = (value: string) =>
  value as NewsletterSignupRequestId;

export type NewsletterSignupRequestState =
  | "pending"
  | "confirmed"
  | "expired"
  | "superseded"
  | "refused";

export type PendingNewsletterSignup = Readonly<{
  id: NewsletterSignupRequestId;
  siteId: SiteId;
  submissionId: string;
  identityKey: string;
  /** Cleared as soon as the request stops being pending. */
  email: string | null;
  disclosureVersion: string;
  collectionSurface: string;
  requestedAt: string;
  expiresAt: string;
  state: NewsletterSignupRequestState;
  settledAt: string | null;
}>;

/**
 * The confirmation message this installation must send. It carries the address
 * because a transactional message has to reach it. Nothing else may read it:
 * the sender writes it to the provider and the row is cleared afterwards.
 */
export type NewsletterConfirmationJob = Readonly<{
  requestId: NewsletterSignupRequestId;
  siteId: SiteId;
  address: string;
  identityKey: string;
  expiresAt: string;
  attempts: number;
  firstAvailableAt: string;
}>;

export type NewsletterConfirmationMessage = Readonly<{
  requestId: NewsletterSignupRequestId;
  address: string;
  confirmationUrl: string;
  senderIdentityId: string;
  /** The same legal footer a campaign carries. */
  legalFooter: string;
  expiresAt: string;
}>;

export type NewsletterConfirmationOutcome =
  | "sent"
  | "retry"
  | "permanent_failure";

export interface NewsletterConfirmationSender {
  send(
    message: NewsletterConfirmationMessage,
  ): Promise<Readonly<{ outcome: NewsletterConfirmationOutcome }>>;
}

export interface NewsletterConfirmationLinkFactory {
  createConfirmationUrl(input: {
    requestId: NewsletterSignupRequestId;
    identityKey: string;
    expiresAt: string;
  }): Promise<string>;
  consumeConfirmationToken(token: string): Promise<
    Readonly<{ requestId: NewsletterSignupRequestId; identityKey: string }>
  >;
}

/**
 * What the person agreed to, and where.
 *
 * `wording` is the exact consent sentence that was on screen. A site owner can
 * rewrite that sentence in the visual editor, so a hand-kept version number
 * would go stale the moment they did. The version recorded in the consent
 * evidence is therefore a fingerprint of the sentence itself: change a word and
 * the version changes with it, and every record keeps pointing at the words it
 * was actually given.
 */
export type NewsletterSignupDisclosure = Readonly<{
  wording: string;
  surface: string;
}>;

/**
 * The version recorded against a consent record. It identifies one exact
 * consent sentence, and the same sentence always produces the same version.
 */
export async function newsletterConsentWordingVersion(wording: string) {
  return `wording-sha256:${(await sha256Text(wording.trim())).slice(0, 32)}`;
}

export interface NewsletterSignupStore {
  /**
   * Writes the pending request and its confirmation job in one transaction, the
   * way the public form writes its submission and its outbox event. A repeated
   * submission id returns the first result instead of writing a second request.
   *
   * Any earlier pending request for the same address is superseded inside that
   * same transaction. Doing it in a separate statement would let two requests
   * arriving together both pass the check and then collide, so the person would
   * see a failure instead of a confirmation message.
   */
  savePendingSignup(input: {
    pending: PendingNewsletterSignup;
    job: NewsletterConfirmationJob;
  }): Promise<Readonly<{ outcome: "accepted" | "replayed" }>>;
  findPendingSignupBySubmissionId(input: {
    siteId: SiteId;
    submissionId: string;
  }): Promise<PendingNewsletterSignup | null>;
  findPendingSignupById(input: {
    siteId: SiteId;
    requestId: NewsletterSignupRequestId;
  }): Promise<PendingNewsletterSignup | null>;
  /**
   * Marks the request confirmed and clears the address in the same statement,
   * so a confirmed request never keeps a copy of the address the ledger already
   * holds.
   */
  settlePendingSignup(input: {
    siteId: SiteId;
    requestId: NewsletterSignupRequestId;
    state: Exclude<NewsletterSignupRequestState, "pending">;
    settledAt: string;
  }): Promise<void>;
  expirePendingSignups(input: {
    siteId: SiteId;
    now: string;
  }): Promise<Readonly<{ expired: number }>>;
  /**
   * How many people are waiting to confirm: requests still in the `pending`
   * state whose `expiresAt` has not yet passed `now`. A row a sweep has not
   * reached yet, past its own `expiresAt`, is not counted as waiting — it is
   * already effectively expired, whether or not `expirePendingSignups` has
   * run against it. Never returns an address, so it needs no actor and no
   * sensitive-access audit record, unlike `listIdentities`.
   */
  countPendingSignups(input: {
    siteId: SiteId;
    now: string;
  }): Promise<number>;
  claimDueConfirmationJobs(input: {
    siteId: SiteId;
    now: string;
    leaseToken: string;
    leaseUntil: string;
    limit: number;
  }): Promise<ReadonlyArray<NewsletterConfirmationJob>>;
  recordConfirmationOutcome(input: {
    siteId: SiteId;
    requestId: NewsletterSignupRequestId;
    leaseToken: string;
    outcome: NewsletterConfirmationOutcome;
    availableAt: string | null;
    recordedAt: string;
  }): Promise<void>;
}

/**
 * The public result of a signup attempt. `check_your_inbox` is returned for
 * every address the form accepts, whatever the ledger already knows about it.
 * `not_available` means the installation cannot send a confirmation message at
 * all, so the address was not stored.
 */
export type NewsletterSignupResult = Readonly<{
  outcome: "check_your_inbox" | "not_available";
}>;

/**
 * A confirmation link that this installation did not sign, or that no longer
 * works. It is a typed error so a route can tell it apart from a genuine fault
 * in this code, which must never be shown to a visitor as a bad link.
 */
export class NewsletterConfirmationLinkInvalidError extends Error {
  constructor() {
    super("newsletter_confirmation_link_invalid");
    this.name = "NewsletterConfirmationLinkInvalidError";
  }
}

export class NewsletterSignupRejectedError extends Error {
  constructor(public readonly reason: "invalid_email" | "invalid_request") {
    super("newsletter_signup_rejected");
    this.name = "NewsletterSignupRejectedError";
  }
}

export class NewsletterConfirmationExpiredError extends Error {
  constructor() {
    super("newsletter_confirmation_expired");
    this.name = "NewsletterConfirmationExpiredError";
  }
}

export const newsletterSignupConfirmationWindowMs = 24 * 60 * 60 * 1_000;
export const newsletterConfirmationLeaseMs = 4 * 60 * 1_000;
export const newsletterConfirmationRetryWindowMs = 24 * 60 * 60 * 1_000;
export const newsletterConfirmationBatchSize = 25;

const submissionIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const identityKeyPattern = /^[a-f0-9]{64}$/u;
const maximumSurfaceLength = 200;
const maximumWordingLength = 400;

export function newsletterConfirmationRetryAt({
  attempts,
  firstAvailableAt,
  now,
}: {
  attempts: number;
  firstAvailableAt: string;
  now: Date;
}): string | null {
  const backoffMs = Math.min(
    15 * 60 * 1_000,
    30 * 1_000 * 2 ** Math.max(0, attempts - 1),
  );
  const retryAt = now.getTime() + backoffMs;
  const deadline =
    Date.parse(firstAvailableAt) + newsletterConfirmationRetryWindowMs;
  return retryAt > deadline ? null : new Date(retryAt).toISOString();
}

function validateDisclosure(disclosure: NewsletterSignupDisclosure) {
  if (
    typeof disclosure.wording !== "string" ||
    disclosure.wording.trim() === "" ||
    disclosure.wording.length > maximumWordingLength ||
    typeof disclosure.surface !== "string" ||
    disclosure.surface.trim() === "" ||
    disclosure.surface.length > maximumSurfaceLength
  ) {
    throw new NewsletterSignupRejectedError("invalid_request");
  }
}

/**
 * The subscriber states a public signup may still lead to consent from.
 *
 * Two states are refused outright, and the form cannot tell you which.
 *
 * `erased` — erasure is a standing instruction not to hold the address again.
 * A form submission is not evidence that the erased person asked to come back.
 *
 * `complained` — this address reported our mail as spam. Sending it a
 * confirmation message would be sending it exactly the kind of mail it
 * complained about. Coming back has to start somewhere other than this form.
 *
 * `unsubscribed` and `hard_bounced` may come back, because the person has to
 * open a link in a message sent to that address to do it. That act is both the
 * fresh consent and the proof that the address works again.
 */
export const subscriberStatesRefusedBySignup: ReadonlyArray<SubscriberState> =
  Object.freeze(["erased", "complained"]);

export function subscriberCanBeConfirmedAgain(subscriber: Subscriber | null) {
  return (
    subscriber === null ||
    !subscriberStatesRefusedBySignup.includes(subscriber.state)
  );
}

export function createNewsletterSignupApplication({
  siteId,
  store,
  ledgerStore,
  createIdentityKey,
  confirmationLinks,
  sender,
  readDelivery,
  clock = () => new Date(),
  createId = (kind) => `${kind}-${crypto.randomUUID()}`,
}: {
  siteId: SiteId;
  store: NewsletterSignupStore;
  ledgerStore: SubscriberLedgerStore;
  createIdentityKey(email: string): Promise<string>;
  confirmationLinks: NewsletterConfirmationLinkFactory;
  sender: NewsletterConfirmationSender;
  /**
   * The sender identity and legal footer this installation is configured with,
   * or `null` when a setting is missing. A confirmation message carries the same
   * legal footer as a campaign, so with no footer there is no message to send
   * and the form must not take the address.
   */
  readDelivery(): Promise<
    Readonly<{ senderIdentityId: string; legalFooter: string }> | null
  >;
  clock?: () => Date;
  createId?: (kind: "newsletter_signup" | "subscriber" | "subscriber_event") => string;
}) {
  async function requestSignup(input: {
    submissionId: string;
    email: unknown;
    disclosure: NewsletterSignupDisclosure;
  }): Promise<NewsletterSignupResult> {
    if (!submissionIdPattern.test(input.submissionId)) {
      throw new NewsletterSignupRejectedError("invalid_request");
    }
    validateDisclosure(input.disclosure);

    // Checked before the address is touched. An installation that cannot send
    // a confirmation message must not hold an address it can never confirm.
    const delivery = await readDelivery();
    if (delivery === null) {
      return Object.freeze({ outcome: "not_available" as const });
    }

    let email: string;
    try {
      email = normalizeSubscriberEmail(input.email);
    } catch (error) {
      if (error instanceof InvalidSubscriberEmailError) {
        throw new NewsletterSignupRejectedError("invalid_email");
      }
      throw error;
    }

    const existingBySubmission = await store.findPendingSignupBySubmissionId({
      siteId,
      submissionId: input.submissionId,
    });
    if (existingBySubmission !== null) {
      return Object.freeze({ outcome: "check_your_inbox" as const });
    }

    const identityKey = await createIdentityKey(email);
    const subscriber = await ledgerStore.findByIdentityKey({
      siteId,
      identityKey,
    });

    // From here every branch returns the same answer. A request is only written
    // when a confirmation could change something, but the visitor cannot tell
    // the difference, so the form reveals nothing about the list.
    if (!subscriberCanBeConfirmedAgain(subscriber)) {
      return Object.freeze({ outcome: "check_your_inbox" as const });
    }

    const requestedAt = clock();
    const expiresAt = new Date(
      requestedAt.getTime() + newsletterSignupConfirmationWindowMs,
    ).toISOString();
    const requestId = createNewsletterSignupRequestId(
      createId("newsletter_signup"),
    );
    const requestedAtText = requestedAt.toISOString();

    await store.savePendingSignup({
      pending: Object.freeze({
        id: requestId,
        siteId,
        submissionId: input.submissionId,
        identityKey,
        email,
        disclosureVersion: await newsletterConsentWordingVersion(
          input.disclosure.wording,
        ),
        collectionSurface: input.disclosure.surface.trim(),
        requestedAt: requestedAtText,
        expiresAt,
        state: "pending",
        settledAt: null,
      }),
      job: Object.freeze({
        requestId,
        siteId,
        address: email,
        identityKey,
        expiresAt,
        attempts: 0,
        firstAvailableAt: requestedAtText,
      }),
    });
    return Object.freeze({ outcome: "check_your_inbox" as const });
  }

  async function confirmSignup(input: {
    token: string;
  }): Promise<Readonly<{ outcome: "confirmed" }>> {
    const verified = await confirmationLinks.consumeConfirmationToken(
      input.token,
    );
    const pending = await store.findPendingSignupById({
      siteId,
      requestId: verified.requestId,
    });
    const now = clock();
    if (
      pending === null ||
      pending.state !== "pending" ||
      pending.email === null ||
      pending.identityKey !== verified.identityKey ||
      !identityKeyPattern.test(pending.identityKey) ||
      Date.parse(pending.expiresAt) <= now.getTime()
    ) {
      throw new NewsletterConfirmationExpiredError();
    }

    const subscriber = await ledgerStore.findByIdentityKey({
      siteId,
      identityKey: pending.identityKey,
    });
    if (!subscriberCanBeConfirmedAgain(subscriber)) {
      // No consent is written, so the request must not claim one. It is
      // recorded as refused. The person still sees the same page, because the
      // page must not report what the ledger already holds about them.
      await store.settlePendingSignup({
        siteId,
        requestId: pending.id,
        state: "refused",
        settledAt: now.toISOString(),
      });
      return Object.freeze({ outcome: "confirmed" as const });
    }

    const recordedAt = now.toISOString();
    const evidence: ConsentEvidence = Object.freeze({
      lawfulBasis: "express",
      source: "public_form",
      // The moment the person confirmed, not the moment they typed the address.
      occurredAt: recordedAt,
      disclosureVersion: pending.disclosureVersion,
      collectionSurface: pending.collectionSurface,
      evidenceReference: `newsletter-signup:${pending.id}`,
    });
    const event = (subscriberId: string): SubscriberEvent => ({
      id: createSubscriberEventId(createId("subscriber_event")),
      siteId,
      subscriberId: createSubscriberId(subscriberId),
      type: subscriber === null ? "consent_recorded" : "resubscribed",
      occurredAt: recordedAt,
      recordedAt,
      // A visitor confirming their own address is not a member of staff and not
      // a provider callback, so the actor is this installation's signup flow.
      actor: {
        type: "provider",
        provider: "foundry_newsletter_signup",
        providerEventId: `newsletter-signup:${pending.id}`,
      },
      evidence,
    });

    if (subscriber === null) {
      const created: Subscriber = {
        id: createSubscriberId(createId("subscriber")),
        siteId,
        identityKey: pending.identityKey,
        email: pending.email,
        state: "active",
        createdAt: recordedAt,
        updatedAt: recordedAt,
      };
      await ledgerStore.createWithEvent({
        subscriber: created,
        event: event(created.id),
      });
    } else {
      await ledgerStore.appendEvent({
        subscriber: {
          ...subscriber,
          email: pending.email,
          state: "active",
          updatedAt: recordedAt,
        },
        event: event(subscriber.id),
      });
    }

    await store.settlePendingSignup({
      siteId,
      requestId: pending.id,
      state: "confirmed",
      settledAt: recordedAt,
    });
    return Object.freeze({ outcome: "confirmed" as const });
  }

  /**
   * Sends the confirmation messages that are due. Called from the scheduled
   * worker, next to the public form notification drain.
   */
  async function deliverDueConfirmations(input: {
    leaseToken: string;
  }): Promise<Readonly<{ sent: number; retried: number; failed: number }>> {
    const now = clock();
    await store.expirePendingSignups({ siteId, now: now.toISOString() });
    const delivery = await readDelivery();
    if (delivery === null) {
      return Object.freeze({ sent: 0, retried: 0, failed: 0 });
    }
    const jobs = await store.claimDueConfirmationJobs({
      siteId,
      now: now.toISOString(),
      leaseToken: input.leaseToken,
      leaseUntil: new Date(
        now.getTime() + newsletterConfirmationLeaseMs,
      ).toISOString(),
      limit: newsletterConfirmationBatchSize,
    });

    let sent = 0;
    let retried = 0;
    let failed = 0;
    for (const job of jobs) {
      let outcome: NewsletterConfirmationOutcome;
      try {
        const confirmationUrl = await confirmationLinks.createConfirmationUrl({
          requestId: job.requestId,
          identityKey: job.identityKey,
          expiresAt: job.expiresAt,
        });
        outcome = (
          await sender.send({
            requestId: job.requestId,
            address: job.address,
            confirmationUrl,
            senderIdentityId: delivery.senderIdentityId,
            legalFooter: delivery.legalFooter,
            expiresAt: job.expiresAt,
          })
        ).outcome;
      } catch {
        // The provider's answer is unknown. Treat it as retryable rather than
        // send a second message the person did not ask for.
        outcome = "retry";
      }

      let availableAt: string | null = null;
      if (outcome === "retry") {
        availableAt = newsletterConfirmationRetryAt({
          attempts: job.attempts + 1,
          firstAvailableAt: job.firstAvailableAt,
          now,
        });
        if (availableAt === null) outcome = "permanent_failure";
      }
      await store.recordConfirmationOutcome({
        siteId,
        requestId: job.requestId,
        leaseToken: input.leaseToken,
        outcome,
        availableAt,
        recordedAt: now.toISOString(),
      });
      if (outcome === "sent") sent += 1;
      else if (outcome === "retry") retried += 1;
      else failed += 1;
    }
    return Object.freeze({ sent, retried, failed });
  }

  return Object.freeze({
    requestSignup,
    confirmSignup,
    deliverDueConfirmations,
  });
}

export type NewsletterSignupApplication = ReturnType<
  typeof createNewsletterSignupApplication
>;
