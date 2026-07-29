import type { SiteId } from "@foundry/site-definition";

import type {
  ExternalHumanIdentity,
  HumanCapability,
  HumanMembership,
  HumanMembershipId,
} from "./human-access";
import {
  InvalidEmailAddressError,
  normalizeEmailAddress,
} from "./email-address";
import type { CampaignAudienceDefinition } from "./campaign";

declare const subscriberIdBrand: unique symbol;
declare const subscriberEventIdBrand: unique symbol;

export type SubscriberId = string & {
  readonly [subscriberIdBrand]: "subscriber";
};
export type SubscriberEventId = string & {
  readonly [subscriberEventIdBrand]: "subscriber_event";
};
export const createSubscriberId = (value: string) => value as SubscriberId;
export const createSubscriberEventId = (value: string) =>
  value as SubscriberEventId;

export type SubscriberState =
  | "active"
  | "unsubscribed"
  | "complained"
  | "hard_bounced"
  | "erased";
export type SuppressionReason = Exclude<SubscriberState, "active">;
export type ConsentLawfulBasis = "express" | "implied";
export type ConsentSource =
  | "public_form"
  | "owner_import"
  | "provider_import";

export type ConsentEvidence = Readonly<{
  lawfulBasis: ConsentLawfulBasis;
  source: ConsentSource;
  occurredAt: string;
  disclosureVersion: string;
  collectionSurface: string;
  evidenceReference: string;
}>;

export type Subscriber = Readonly<{
  id: SubscriberId;
  siteId: SiteId;
  identityKey: string;
  email: string | null;
  state: SubscriberState;
  createdAt: string;
  updatedAt: string;
}>;

export type SubscriberEventActor =
  | Readonly<{ type: "human"; membershipId: HumanMembershipId }>
  | Readonly<{
      type: "provider";
      provider: string;
      providerEventId: string;
    }>;

type SubscriberEventBase = Readonly<{
  id: SubscriberEventId;
  siteId: SiteId;
  subscriberId: SubscriberId;
  occurredAt: string;
  recordedAt: string;
  actor: SubscriberEventActor;
}>;

export type SubscriberEvent =
  | (SubscriberEventBase &
      Readonly<{
        type: "consent_recorded" | "resubscribed";
        evidence: ConsentEvidence;
      }>)
  | (SubscriberEventBase &
      Readonly<{
        type: SuppressionReason;
        evidence: null;
      }>);

export type SensitiveSubscriberAccessEvent = Readonly<{
  id: string;
  siteId: SiteId;
  actorMembershipId: HumanMembershipId;
  action: "subscriber-identities.read" | "subscriber-ledger.export";
  occurredAt: string;
}>;

export interface SubscriberLedgerStore {
  findByIdentityKey(input: {
    siteId: SiteId;
    identityKey: string;
  }): Promise<Subscriber | null>;
  createWithEvent(input: {
    subscriber: Subscriber;
    event: SubscriberEvent;
  }): Promise<Subscriber>;
  appendEvent(input: {
    subscriber: Subscriber;
    event: SubscriberEvent;
  }): Promise<Subscriber>;
  listSubscribers(siteId: SiteId): Promise<ReadonlyArray<Subscriber>>;
  readSnapshot(siteId: SiteId): Promise<
    Readonly<{
      subscribers: ReadonlyArray<Subscriber>;
      events: ReadonlyArray<SubscriberEvent>;
    }>
  >;
  recordSensitiveAccess(event: SensitiveSubscriberAccessEvent): Promise<void>;
}

export function createSubscriberLedgerAudienceResolver({
  siteId,
  store,
}: {
  siteId: SiteId;
  store: SubscriberLedgerStore;
}) {
  return async (
    definition: CampaignAudienceDefinition,
  ): Promise<Readonly<{ eligibleSubscriberCount: number }>> => {
    if (
      definition.id !== "canonical-consent-and-suppression" ||
      definition.version !== 1
    ) {
      throw new TypeError("campaign_audience_definition_invalid");
    }
    const subscribers = await store.listSubscribers(siteId);
    return Object.freeze({
      eligibleSubscriberCount: subscribers.filter(
        (subscriber) => subscriber.state === "active",
      ).length,
    });
  };
}

export type SubscriberLedgerExport = Readonly<{
  schemaVersion: 1;
  siteId: SiteId;
  exportedAt: string;
  subscribers: ReadonlyArray<Subscriber>;
  events: ReadonlyArray<SubscriberEvent>;
}>;

export type SubscriberLedgerApplication = Readonly<{
  queries: Readonly<{
    listIdentities(input: {
      actor: ExternalHumanIdentity;
    }): Promise<ReadonlyArray<Subscriber>>;
    exportLedger(input: {
      actor: ExternalHumanIdentity;
    }): Promise<SubscriberLedgerExport>;
  }>;
  commands: Readonly<{
    recordConsent(input: {
      actor: ExternalHumanIdentity;
      email: unknown;
      evidence: ConsentEvidence;
    }): Promise<Subscriber>;
    suppress(input: {
      actor: ExternalHumanIdentity;
      email: unknown;
      reason: SuppressionReason;
      occurredAt: string;
    }): Promise<Subscriber>;
    resubscribe(input: {
      actor: ExternalHumanIdentity;
      email: unknown;
      evidence: ConsentEvidence;
    }): Promise<Subscriber>;
  }>;
  provider: Readonly<{
    ingestSuppression(input: {
      provider: string;
      providerEventId: string;
      email: unknown;
      reason: Exclude<SuppressionReason, "erased">;
      occurredAt: string;
    }): Promise<Subscriber>;
    synchronizeProfile(input: {
      email: unknown;
    }): Promise<Subscriber>;
  }>;
}>;

export class InvalidSubscriberEmailError extends Error {
  constructor() {
    super("invalid_subscriber_email");
    this.name = "InvalidSubscriberEmailError";
  }
}

export class MissingConsentEvidenceError extends Error {
  constructor() {
    super("missing_consent_evidence");
    this.name = "MissingConsentEvidenceError";
  }
}

export class InvalidSubscriberEventTimestampError extends Error {
  constructor() {
    super("invalid_subscriber_event_timestamp");
    this.name = "InvalidSubscriberEventTimestampError";
  }
}

export class SubscriberNotFoundError extends Error {
  constructor() {
    super("subscriber_not_found");
    this.name = "SubscriberNotFoundError";
  }
}

export class SubscriberAlreadyExistsError extends Error {
  constructor() {
    super("subscriber_already_exists");
    this.name = "SubscriberAlreadyExistsError";
  }
}

export class ErasedSubscriberError extends Error {
  constructor() {
    super("erased_subscriber_cannot_be_reactivated");
    this.name = "ErasedSubscriberError";
  }
}

export function normalizeSubscriberEmail(value: unknown) {
  try {
    return normalizeEmailAddress(value);
  } catch (error) {
    if (!(error instanceof InvalidEmailAddressError)) {
      throw error;
    }
    throw new InvalidSubscriberEmailError();
  }
}

export async function createSubscriberIdentityKey(
  email: string,
  secret: string,
) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(email));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function validateEventTimestamp(value: string) {
  if (!Number.isFinite(Date.parse(value))) {
    throw new InvalidSubscriberEventTimestampError();
  }
}

function validateConsentEvidence(evidence: ConsentEvidence) {
  if (
    !["express", "implied"].includes(evidence.lawfulBasis) ||
    !["public_form", "owner_import", "provider_import"].includes(
      evidence.source,
    ) ||
    evidence.disclosureVersion.trim() === "" ||
    evidence.collectionSurface.trim() === "" ||
    evidence.evidenceReference.trim() === ""
  ) {
    throw new MissingConsentEvidenceError();
  }
  try {
    validateEventTimestamp(evidence.occurredAt);
  } catch (error) {
    if (!(error instanceof InvalidSubscriberEventTimestampError)) {
      throw error;
    }
    throw new MissingConsentEvidenceError();
  }
}

const suppressionPrecedence: Readonly<Record<SubscriberState, number>> = {
  active: 0,
  unsubscribed: 1,
  hard_bounced: 2,
  complained: 3,
  erased: 4,
};

export function subscriberStatesOverriddenBySuppression(
  incoming: SuppressionReason,
): ReadonlyArray<SubscriberState> {
  return (Object.keys(suppressionPrecedence) as SubscriberState[]).filter(
    (state) =>
      suppressionPrecedence[state] < suppressionPrecedence[incoming],
  );
}

function moreRestrictiveState(
  current: SubscriberState,
  incoming: SuppressionReason,
): SubscriberState {
  return suppressionPrecedence[incoming] > suppressionPrecedence[current]
    ? incoming
    : current;
}

export function createSubscriberLedgerApplication({
  siteId,
  store,
  authorize,
  identityKeySecret,
  clock = () => new Date(),
  createId = (kind) => `${kind}-${crypto.randomUUID()}`,
}: {
  siteId: SiteId;
  store: SubscriberLedgerStore;
  authorize(
    actor: ExternalHumanIdentity,
    capability: HumanCapability,
  ): Promise<HumanMembership>;
  identityKeySecret: string;
  clock?: () => Date;
  createId?: (kind: "subscriber" | "subscriber_event" | "audit") => string;
}): SubscriberLedgerApplication {
  async function locate(emailInput: unknown) {
    const email = normalizeSubscriberEmail(emailInput);
    const identityKey = await createSubscriberIdentityKey(
      email,
      identityKeySecret,
    );
    return {
      email,
      identityKey,
      subscriber: await store.findByIdentityKey({ siteId, identityKey }),
    };
  }

  async function sensitiveAccess(
    actor: ExternalHumanIdentity,
    capability:
      | "subscriber-identities.read"
      | "subscriber-ledger.export",
  ) {
    const membership = await authorize(actor, capability);
    await store.recordSensitiveAccess({
      id: createId("audit"),
      siteId,
      actorMembershipId: membership.id,
      action: capability,
      occurredAt: clock().toISOString(),
    });
  }

  async function appendSuppression({
    subscriber,
    reason,
    occurredAt,
    actor,
  }: {
    subscriber: Subscriber;
    reason: SuppressionReason;
    occurredAt: string;
    actor: SubscriberEventActor;
  }) {
    validateEventTimestamp(occurredAt);
    const recordedAt = clock().toISOString();
    return store.appendEvent({
      subscriber: {
        ...subscriber,
        email: reason === "erased" ? null : subscriber.email,
        state: moreRestrictiveState(subscriber.state, reason),
        updatedAt: recordedAt,
      },
      event: {
        id: createSubscriberEventId(createId("subscriber_event")),
        siteId,
        subscriberId: subscriber.id,
        type: reason,
        occurredAt,
        recordedAt,
        actor,
        evidence: null,
      },
    });
  }

  async function createConsentSubscriber({
    email,
    identityKey,
    evidence,
    actor,
  }: {
    email: string;
    identityKey: string;
    evidence: ConsentEvidence;
    actor: SubscriberEventActor;
  }) {
    validateConsentEvidence(evidence);
    const recordedAt = clock().toISOString();
    const subscriber: Subscriber = {
      id: createSubscriberId(createId("subscriber")),
      siteId,
      identityKey,
      email,
      state: "active",
      createdAt: recordedAt,
      updatedAt: recordedAt,
    };
    return store.createWithEvent({
      subscriber,
      event: {
        id: createSubscriberEventId(createId("subscriber_event")),
        siteId,
        subscriberId: subscriber.id,
        type: "consent_recorded",
        occurredAt: evidence.occurredAt,
        recordedAt,
        actor,
        evidence,
      },
    });
  }

  const queries: SubscriberLedgerApplication["queries"] = Object.freeze({
      async listIdentities({ actor }) {
        await sensitiveAccess(actor, "subscriber-identities.read");
        return store.listSubscribers(siteId);
      },
      async exportLedger({ actor }) {
        await sensitiveAccess(actor, "subscriber-ledger.export");
        const snapshot = await store.readSnapshot(siteId);
        return {
          schemaVersion: 1,
          siteId,
          exportedAt: clock().toISOString(),
          subscribers: snapshot.subscribers,
          events: snapshot.events,
        };
      },
    });
  const commands: SubscriberLedgerApplication["commands"] = Object.freeze({
      async recordConsent({ actor, email: emailInput, evidence }) {
        const membership = await authorize(actor, "subscribers.manage");
        const { email, identityKey, subscriber } = await locate(emailInput);
        if (subscriber !== null) {
          throw new SubscriberAlreadyExistsError();
        }
        return createConsentSubscriber({
          email,
          identityKey,
          evidence,
          actor: { type: "human", membershipId: membership.id },
        });
      },
      async suppress({ actor, email, reason, occurredAt }) {
        const membership = await authorize(actor, "subscribers.manage");
        const located = await locate(email);
        if (located.subscriber === null) {
          throw new SubscriberNotFoundError();
        }
        return appendSuppression({
          subscriber: located.subscriber,
          reason,
          occurredAt,
          actor: { type: "human", membershipId: membership.id },
        });
      },
      async resubscribe({ actor, email, evidence }) {
        const membership = await authorize(actor, "subscribers.manage");
        validateConsentEvidence(evidence);
        const located = await locate(email);
        if (located.subscriber === null) {
          throw new SubscriberNotFoundError();
        }
        if (located.subscriber.state === "erased") {
          throw new ErasedSubscriberError();
        }
        const recordedAt = clock().toISOString();
        return store.appendEvent({
          subscriber: {
            ...located.subscriber,
            email: located.email,
            state: "active",
            updatedAt: recordedAt,
          },
          event: {
            id: createSubscriberEventId(createId("subscriber_event")),
            siteId,
            subscriberId: located.subscriber.id,
            type: "resubscribed",
            occurredAt: evidence.occurredAt,
            recordedAt,
            actor: { type: "human", membershipId: membership.id },
            evidence,
          },
        });
      },
    });
  const provider: SubscriberLedgerApplication["provider"] = Object.freeze({
      async ingestSuppression({
        provider,
        providerEventId,
        email,
        reason,
        occurredAt,
      }) {
        validateEventTimestamp(occurredAt);
        const located = await locate(email);
        if (located.subscriber === null) {
          const recordedAt = clock().toISOString();
          const subscriber: Subscriber = {
            id: createSubscriberId(createId("subscriber")),
            siteId,
            identityKey: located.identityKey,
            email: located.email,
            state: reason,
            createdAt: recordedAt,
            updatedAt: recordedAt,
          };
          return store.createWithEvent({
            subscriber,
            event: {
              id: createSubscriberEventId(createId("subscriber_event")),
              siteId,
              subscriberId: subscriber.id,
              type: reason,
              occurredAt,
              recordedAt,
              actor: { type: "provider", provider, providerEventId },
              evidence: null,
            },
          });
        }
        return appendSuppression({
          subscriber: located.subscriber,
          reason,
          occurredAt,
          actor: { type: "provider", provider, providerEventId },
        });
      },
      async synchronizeProfile({ email }) {
        const located = await locate(email);
        if (located.subscriber === null) {
          throw new SubscriberNotFoundError();
        }
        return located.subscriber;
      },
    });

  return Object.freeze({
    queries,
    commands,
    provider,
  });
}
