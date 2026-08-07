import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  createHumanMembershipId,
  createSubscriberEventId,
  createSubscriberId,
  createSubscriberIdentityKey,
  type Subscriber,
  type SubscriberEvent,
} from "@foundry/application";
import { createSiteId } from "@foundry/site-definition";

import type { D1DatabaseBinding } from "./d1-human-access-store";
import { createD1SubscriberLedgerStore } from "./d1-subscriber-ledger-store";
import {
  type TestD1Database,
  useMigratedTestDatabase,
} from "./test-support/migrated-test-database";

const siteId = createSiteId("site_reference");
const now = "2026-07-27T18:00:00.000Z";
const identitySecret = "test-subscriber-identity-secret-value";
let database: TestD1Database;
const testDatabase = useMigratedTestDatabase([
  "0001_human_access.sql",
  "0002_subscriber_ledger.sql",
]);

beforeEach(async () => {
  database = testDatabase.database;
});

async function fixture() {
  const identityKey = await createSubscriberIdentityKey(
    "person@example.com",
    identitySecret,
  );
  const subscriber: Subscriber = {
    id: createSubscriberId("subscriber-1"),
    siteId,
    identityKey,
    email: "person@example.com",
    state: "active",
    createdAt: now,
    updatedAt: now,
  };
  const event: SubscriberEvent = {
    id: createSubscriberEventId("event-consent"),
    siteId,
    subscriberId: subscriber.id,
    type: "consent_recorded",
    occurredAt: now,
    recordedAt: now,
    actor: {
      type: "human",
      membershipId: createHumanMembershipId("membership-owner"),
    },
    evidence: {
      lawfulBasis: "express",
      source: "public_form",
      occurredAt: now,
      disclosureVersion: "newsletter-v1",
      collectionSurface: "/newsletter",
      evidenceReference: "submission-1",
    },
  };
  const store = createD1SubscriberLedgerStore(
    database as unknown as D1DatabaseBinding,
  );
  await store.createWithEvent({ subscriber, event });
  return { store, subscriber };
}

describe("D1 subscriber ledger store", () => {
  it("round-trips consent evidence and provider-neutral actors", async () => {
    const { store } = await fixture();

    await expect(store.readSnapshot(siteId)).resolves.toMatchObject({
      events: [
        expect.objectContaining({
          type: "consent_recorded",
          actor: {
            type: "human",
            membershipId: "membership-owner",
          },
          evidence: expect.objectContaining({
            evidenceReference: "submission-1",
          }),
        }),
      ],
    });
  });

  it("keeps the most restrictive suppression under stale writes", async () => {
    const { store, subscriber } = await fixture();
    await store.appendEvent({
      subscriber: {
        ...subscriber,
        state: "complained",
        updatedAt: "2026-07-27T18:01:00.000Z",
      },
      event: {
        id: createSubscriberEventId("event-complaint"),
        siteId,
        subscriberId: subscriber.id,
        type: "complained",
        occurredAt: "2026-07-27T18:01:00.000Z",
        recordedAt: "2026-07-27T18:01:00.000Z",
        actor: {
          type: "provider",
          provider: "provider-a",
          providerEventId: "complaint-1",
        },
        evidence: null,
      },
    });
    const staleResult = await store.appendEvent({
      subscriber: {
        ...subscriber,
        state: "unsubscribed",
        updatedAt: "2026-07-27T18:02:00.000Z",
      },
      event: {
        id: createSubscriberEventId("event-unsubscribe"),
        siteId,
        subscriberId: subscriber.id,
        type: "unsubscribed",
        occurredAt: "2026-07-27T18:02:00.000Z",
        recordedAt: "2026-07-27T18:02:00.000Z",
        actor: {
          type: "provider",
          provider: "provider-b",
          providerEventId: "unsubscribe-1",
        },
        evidence: null,
      },
    });

    expect(staleResult.state).toBe("complained");
    expect((await store.readSnapshot(siteId)).events).toHaveLength(3);
  });

  it("deduplicates provider events and forbids ledger mutation", async () => {
    const { store, subscriber } = await fixture();
    const event: SubscriberEvent = {
      id: createSubscriberEventId("event-provider"),
      siteId,
      subscriberId: subscriber.id,
      type: "hard_bounced",
      occurredAt: now,
      recordedAt: now,
      actor: {
        type: "provider",
        provider: "provider-a",
        providerEventId: "provider-event-1",
      },
      evidence: null,
    };
    await store.appendEvent({
      subscriber: { ...subscriber, state: "hard_bounced" },
      event,
    });
    await store.appendEvent({
      subscriber: { ...subscriber, state: "hard_bounced" },
      event: { ...event, id: createSubscriberEventId("event-retry") },
    });

    expect((await store.readSnapshot(siteId)).events).toHaveLength(2);
    await expect(
      database
        .prepare(
          "UPDATE subscriber_ledger_events SET occurred_at = ?1 WHERE id = ?2",
        )
        .bind("changed", "event-provider")
        .run(),
    ).rejects.toThrow("subscriber_ledger_events_are_immutable");
  });

  it("does not change another subscriber when a provider event ID is reused", async () => {
    const { store, subscriber } = await fixture();
    const first = await store.appendEvent({
      subscriber: { ...subscriber, state: "unsubscribed" },
      event: {
        id: createSubscriberEventId("event-provider-original"),
        siteId,
        subscriberId: subscriber.id,
        type: "unsubscribed",
        occurredAt: now,
        recordedAt: now,
        actor: {
          type: "provider",
          provider: "provider-a",
          providerEventId: "provider-reused-id",
        },
        evidence: null,
      },
    });
    expect(first.state).toBe("unsubscribed");

    const otherIdentityKey =
      await createSubscriberIdentityKey("other@example.com", identitySecret);
    const other: Subscriber = {
      id: createSubscriberId("subscriber-2"),
      siteId,
      identityKey: otherIdentityKey,
      email: "other@example.com",
      state: "active",
      createdAt: now,
      updatedAt: now,
    };
    await expect(
      store.createWithEvent({
        subscriber: { ...other, state: "complained" },
        event: {
          id: createSubscriberEventId("event-provider-conflict"),
          siteId,
          subscriberId: other.id,
          type: "complained",
          occurredAt: now,
          recordedAt: now,
          actor: {
            type: "provider",
            provider: "provider-a",
            providerEventId: "provider-reused-id",
          },
          evidence: null,
        },
      }),
    ).rejects.toThrow("provider_event_conflict");
    await expect(
      store.findByIdentityKey({ siteId, identityKey: otherIdentityKey }),
    ).resolves.toBeNull();

    await expect(
      store.appendEvent({
        subscriber: { ...subscriber, state: "complained" },
        event: {
          id: createSubscriberEventId("event-provider-conflict-append"),
          siteId,
          subscriberId: subscriber.id,
          type: "complained",
          occurredAt: now,
          recordedAt: now,
          actor: {
            type: "provider",
            provider: "provider-a",
            providerEventId: "provider-reused-id",
          },
          evidence: null,
        },
      }),
    ).resolves.toMatchObject({ state: "unsubscribed" });
  });

  it("reports a concurrent human identity insert as an existing subscriber", async () => {
    const { store, subscriber } = await fixture();

    await expect(
      store.createWithEvent({
        subscriber: {
          ...subscriber,
          id: createSubscriberId("subscriber-concurrent"),
        },
        event: {
          id: createSubscriberEventId("event-concurrent-consent"),
          siteId,
          subscriberId: createSubscriberId("subscriber-concurrent"),
          type: "consent_recorded",
          occurredAt: now,
          recordedAt: now,
          actor: {
            type: "human",
            membershipId: createHumanMembershipId("membership-owner"),
          },
          evidence: {
            lawfulBasis: "express",
            source: "public_form",
            occurredAt: now,
            disclosureVersion: "newsletter-v1",
            collectionSurface: "/newsletter",
            evidenceReference: "concurrent-consent",
          },
        },
      }),
    ).rejects.toMatchObject({ name: "SubscriberAlreadyExistsError" });
  });

  it("persists erased identities only as non-reversible tombstones", async () => {
    const { store, subscriber } = await fixture();
    const erased = await store.appendEvent({
      subscriber: {
        ...subscriber,
        email: null,
        state: "erased",
        updatedAt: "2026-07-27T18:03:00.000Z",
      },
      event: {
        id: createSubscriberEventId("event-erased"),
        siteId,
        subscriberId: subscriber.id,
        type: "erased",
        occurredAt: "2026-07-27T18:03:00.000Z",
        recordedAt: "2026-07-27T18:03:00.000Z",
        actor: {
          type: "human",
          membershipId: createHumanMembershipId("membership-owner"),
        },
        evidence: null,
      },
    });

    expect(erased).toMatchObject({ email: null, state: "erased" });
    await expect(
      store.appendEvent({
        subscriber: {
          ...subscriber,
          state: "active",
          updatedAt: "2026-07-27T18:04:00.000Z",
        },
        event: {
          id: createSubscriberEventId("event-resubscribe"),
          siteId,
          subscriberId: subscriber.id,
          type: "resubscribed",
          occurredAt: "2026-07-27T18:04:00.000Z",
          recordedAt: "2026-07-27T18:04:00.000Z",
          actor: {
            type: "human",
            membershipId: createHumanMembershipId("membership-owner"),
          },
          evidence: {
            lawfulBasis: "express",
            source: "public_form",
            occurredAt: "2026-07-27T18:04:00.000Z",
            disclosureVersion: "newsletter-v1",
            collectionSurface: "/newsletter",
            evidenceReference: "resubscribe-1",
          },
        },
      }),
    ).rejects.toMatchObject({ name: "ErasedSubscriberError" });
  });

  it("does not append resubscription evidence after a concurrent erasure", async () => {
    const { store, subscriber } = await fixture();
    await store.appendEvent({
      subscriber: {
        ...subscriber,
        email: null,
        state: "erased",
        updatedAt: "2026-07-27T18:05:00.000Z",
      },
      event: {
        id: createSubscriberEventId("event-concurrent-erasure"),
        siteId,
        subscriberId: subscriber.id,
        type: "erased",
        occurredAt: "2026-07-27T18:05:00.000Z",
        recordedAt: "2026-07-27T18:05:00.000Z",
        actor: {
          type: "human",
          membershipId: createHumanMembershipId("membership-owner"),
        },
        evidence: null,
      },
    });

    await expect(
      store.appendEvent({
        subscriber: {
          ...subscriber,
          state: "active",
          updatedAt: "2026-07-27T18:06:00.000Z",
        },
        event: {
          id: createSubscriberEventId("event-stale-resubscribe"),
          siteId,
          subscriberId: subscriber.id,
          type: "resubscribed",
          occurredAt: "2026-07-27T18:04:00.000Z",
          recordedAt: "2026-07-27T18:06:00.000Z",
          actor: {
            type: "human",
            membershipId: createHumanMembershipId("membership-owner"),
          },
          evidence: {
            lawfulBasis: "express",
            source: "public_form",
            occurredAt: "2026-07-27T18:04:00.000Z",
            disclosureVersion: "newsletter-v1",
            collectionSurface: "/newsletter",
            evidenceReference: "resubscribe-race",
          },
        },
      }),
    ).rejects.toMatchObject({ name: "ErasedSubscriberError" });
    await expect(store.readSnapshot(siteId)).resolves.not.toMatchObject({
      events: expect.arrayContaining([
        expect.objectContaining({ id: "event-stale-resubscribe" }),
      ]),
    });
  });
});
