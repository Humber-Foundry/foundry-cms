import type { SiteId } from "@foundry/site-definition";

import {
  ErasedSubscriberError,
  SubscriberAlreadyExistsError,
  subscriberStatesOverriddenBySuppression,
  type SuppressionReason,
  SensitiveSubscriberAccessEvent,
  Subscriber,
  SubscriberEvent,
  SubscriberLedgerStore,
} from "./subscriber-ledger";

export function createInMemorySubscriberLedgerStore(): SubscriberLedgerStore & {
  listSensitiveAccessEvents(
    siteId: SiteId,
  ): Promise<ReadonlyArray<SensitiveSubscriberAccessEvent>>;
} {
  const subscribers = new Map<string, Subscriber>();
  const events: SubscriberEvent[] = [];
  const accessEvents: SensitiveSubscriberAccessEvent[] = [];

  function isDuplicateEvent(event: SubscriberEvent) {
    return events.some(
      (candidate) =>
        candidate.id === event.id ||
        (candidate.actor.type === "provider" &&
          event.actor.type === "provider" &&
          candidate.siteId === event.siteId &&
          candidate.actor.provider === event.actor.provider &&
          candidate.actor.providerEventId ===
            event.actor.providerEventId),
    );
  }

  return {
    async findByIdentityKey({ siteId, identityKey }) {
      return (
        [...subscribers.values()].find(
          (subscriber) =>
            subscriber.siteId === siteId &&
            subscriber.identityKey === identityKey,
        ) ?? null
      );
    },
    async createWithEvent({ subscriber, event }) {
      if (isDuplicateEvent(event)) {
        throw new Error("provider_event_conflict");
      }
      const existing = [...subscribers.values()].some(
        (candidate) =>
          candidate.siteId === subscriber.siteId &&
          candidate.identityKey === subscriber.identityKey,
      );
      if (existing) {
        throw new SubscriberAlreadyExistsError();
      }
      subscribers.set(subscriber.id, subscriber);
      events.push(event);
      return subscriber;
    },
    async appendEvent({ subscriber, event }) {
      const current = subscribers.get(subscriber.id);
      if (current === undefined) {
        throw new Error("subscriber_not_found");
      }
      if (isDuplicateEvent(event)) {
        return current;
      }
      events.push(event);
      let saved: Subscriber;
      if (event.type === "resubscribed") {
        if (current.state === "erased") {
          events.pop();
          throw new ErasedSubscriberError();
        }
        saved = subscriber;
      } else if (event.type === "consent_recorded") {
        events.pop();
        throw new Error("initial_consent_must_create_subscriber");
      } else if (event.type === "erased") {
        saved = {
          ...current,
          email: null,
          state: "erased",
          updatedAt: subscriber.updatedAt,
        };
      } else {
        const overridden = subscriberStatesOverriddenBySuppression(
          event.type as SuppressionReason,
        );
        saved = {
          ...current,
          state: overridden.includes(current.state)
            ? event.type
            : current.state,
          updatedAt: subscriber.updatedAt,
        };
      }
      subscribers.set(saved.id, saved);
      return saved;
    },
    async listSubscribers(siteId) {
      return [...subscribers.values()]
        .filter((subscriber) => subscriber.siteId === siteId)
        .sort((left, right) => left.id.localeCompare(right.id));
    },
    async readSnapshot(siteId) {
      return {
        subscribers: [...subscribers.values()]
          .filter((subscriber) => subscriber.siteId === siteId)
          .sort((left, right) => left.id.localeCompare(right.id)),
        events: events.filter((event) => event.siteId === siteId),
      };
    },
    async recordSensitiveAccess(event) {
      accessEvents.push(event);
    },
    async listSensitiveAccessEvents(siteId) {
      return accessEvents.filter((event) => event.siteId === siteId);
    },
  };
}
