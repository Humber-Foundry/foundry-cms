import { describe, expect, it } from "vitest";

import { createSiteId } from "@humber-foundry/site-definition";

import {
  AccessDeniedError,
  createHumanMembershipId,
  createHumanUserId,
  type ExternalHumanIdentity,
  type HumanCapability,
  type HumanMembership,
} from "./human-access";
import {
  ErasedSubscriberError,
  MissingConsentEvidenceError,
  createSubscriberEventId,
  createSubscriberLedgerApplication,
  type ConsentEvidence,
} from "./subscriber-ledger";
import { createInMemorySubscriberLedgerStore } from "./in-memory-subscriber-ledger-store";

const siteId = createSiteId("site_reference");
const now = new Date("2026-07-27T18:00:00.000Z");
const owner: ExternalHumanIdentity = {
  binding: { issuer: "https://access.example", subject: "owner" },
  email: "owner@example.com",
  nonce: "owner-nonce",
};
const editor: ExternalHumanIdentity = {
  binding: { issuer: "https://access.example", subject: "editor" },
  email: "editor@example.com",
  nonce: "editor-nonce",
};

const ownerMembership: HumanMembership = {
  id: createHumanMembershipId("membership-owner"),
  siteId,
  userId: createHumanUserId("user-owner"),
  email: owner.email,
  identityBinding: owner.binding,
  role: "owner",
  status: "active",
};
const consent: ConsentEvidence = {
  lawfulBasis: "express",
  source: "public_form",
  occurredAt: "2026-07-27T17:55:00.000Z",
  disclosureVersion: "newsletter-v1",
  collectionSurface: "/newsletter",
  evidenceReference: "submission-123",
};

function createFixture() {
  let nextId = 0;
  const store = createInMemorySubscriberLedgerStore();
  const application = createSubscriberLedgerApplication({
    siteId,
    store,
    authorize: async (actor, capability) => {
      if (
        actor.binding.subject !== owner.binding.subject ||
        !(
          [
            "subscribers.manage",
            "subscriber-identities.read",
            "subscriber-ledger.export",
          ] as HumanCapability[]
        ).includes(capability)
      ) {
        throw new AccessDeniedError("capability_not_authorized");
      }
      return ownerMembership;
    },
    identityKeySecret: "test-subscriber-identity-secret-value",
    clock: () => now,
    createId: (kind) => `${kind}-${++nextId}`,
  });
  return { application, store };
}

describe("subscriber consent and suppression ledger", () => {
  it("records normalized canonical identity and consent provenance", async () => {
    const { application } = createFixture();

    const subscriber = await application.commands.recordConsent({
      actor: owner,
      email: " Person@Example.com ",
      evidence: consent,
    });

    expect(subscriber).toMatchObject({
      email: "person@example.com",
      state: "active",
    });
    await expect(
      application.queries.exportLedger({ actor: owner }),
    ).resolves.toMatchObject({
      schemaVersion: 1,
      subscribers: [subscriber],
      events: [
        {
          type: "consent_recorded",
          evidence: consent,
          actor: { type: "human", membershipId: ownerMembership.id },
        },
      ],
    });
  });

  it("requires complete evidence before consent can activate an identity", async () => {
    const { application } = createFixture();

    await expect(
      application.commands.recordConsent({
        actor: owner,
        email: "person@example.com",
        evidence: { ...consent, disclosureVersion: "" },
      }),
    ).rejects.toBeInstanceOf(MissingConsentEvidenceError);
  });

  it("rejects invalid timestamps before they enter immutable history", async () => {
    const { application } = createFixture();
    await application.commands.recordConsent({
      actor: owner,
      email: "person@example.com",
      evidence: consent,
    });

    await expect(
      application.commands.suppress({
        actor: owner,
        email: "person@example.com",
        reason: "unsubscribed",
        occurredAt: "not-a-date",
      }),
    ).rejects.toMatchObject({
      name: "InvalidSubscriberEventTimestampError",
    });
    await expect(
      application.queries.exportLedger({ actor: owner }),
    ).resolves.toMatchObject({
      events: [expect.objectContaining({ type: "consent_recorded" })],
    });
  });

  it.each(["unsubscribed", "complained", "hard_bounced"] as const)(
    "keeps provider profile synchronization from reversing %s",
    async (reason) => {
      const { application } = createFixture();
      await application.commands.recordConsent({
        actor: owner,
        email: "person@example.com",
        evidence: consent,
      });
      await application.provider.ingestSuppression({
        provider: "portable-test-provider",
        providerEventId: `provider-${reason}`,
        email: "person@example.com",
        reason,
        occurredAt: "2026-07-27T18:01:00.000Z",
      });

      const synchronized = await application.provider.synchronizeProfile({
        email: "person@example.com",
      });

      expect(synchronized.state).toBe(reason);
      expect(
        (await application.queries.exportLedger({ actor: owner })).events,
      ).toHaveLength(2);
    },
  );

  it("creates a suppressed canonical identity when a provider event arrives first", async () => {
    const { application } = createFixture();

    const subscriber = await application.provider.ingestSuppression({
      provider: "portable-test-provider",
      providerEventId: "provider-complaint-first",
      email: "person@example.com",
      reason: "complained",
      occurredAt: "2026-07-27T18:01:00.000Z",
    });

    expect(subscriber).toMatchObject({
      email: "person@example.com",
      state: "complained",
    });
    await expect(
      application.provider.synchronizeProfile({
        email: "person@example.com",
      }),
    ).resolves.toMatchObject({ state: "complained" });
  });

  it("records every suppression as an immutable event even when already suppressed", async () => {
    const { application } = createFixture();
    await application.commands.recordConsent({
      actor: owner,
      email: "person@example.com",
      evidence: consent,
    });

    await application.provider.ingestSuppression({
      provider: "provider-a",
      providerEventId: "complaint-a",
      email: "person@example.com",
      reason: "complained",
      occurredAt: "2026-07-27T18:01:00.000Z",
    });
    const result = await application.provider.ingestSuppression({
      provider: "provider-b",
      providerEventId: "unsubscribe-b",
      email: "person@example.com",
      reason: "unsubscribed",
      occurredAt: "2026-07-27T18:02:00.000Z",
    });

    expect(result.state).toBe("complained");
    expect(
      (await application.queries.exportLedger({ actor: owner })).events.map(
        (event) => event.type,
      ),
    ).toEqual(["consent_recorded", "complained", "unsubscribed"]);
  });

  it("records a public unsubscribe by opaque canonical identity key", async () => {
    const { application } = createFixture();
    const subscriber = await application.commands.recordConsent({
      actor: owner,
      email: "person@example.com",
      evidence: consent,
    });

    await expect(
      application.provider.ingestSuppressionByIdentityKey({
        provider: "foundry_unsubscribe",
        providerEventId: "unsubscribe-token-1",
        identityKey: subscriber.identityKey,
        reason: "unsubscribed",
        occurredAt: "2026-07-27T18:01:00.000Z",
      }),
    ).resolves.toMatchObject({
      id: subscriber.id,
      state: "unsubscribed",
    });
  });

  it("deduplicates a retried provider event in the development store", async () => {
    const { application } = createFixture();
    await application.commands.recordConsent({
      actor: owner,
      email: "person@example.com",
      evidence: consent,
    });
    const suppression = {
      provider: "provider-a",
      providerEventId: "provider-retry-1",
      email: "person@example.com",
      reason: "hard_bounced" as const,
      occurredAt: "2026-07-27T18:01:00.000Z",
    };

    await application.provider.ingestSuppression(suppression);
    await application.provider.ingestSuppression(suppression);

    const exported = await application.queries.exportLedger({ actor: owner });
    expect(exported.events.map((event) => event.type)).toEqual([
      "consent_recorded",
      "hard_bounced",
    ]);
  });

  it("preserves suppression precedence under stale development-store writes", async () => {
    const { application, store } = createFixture();
    const original = await application.commands.recordConsent({
      actor: owner,
      email: "person@example.com",
      evidence: consent,
    });
    await store.appendEvent({
      subscriber: {
        ...original,
        state: "complained",
        updatedAt: "2026-07-27T18:01:00.000Z",
      },
      event: {
        id: createSubscriberEventId("stale-complaint"),
        siteId,
        subscriberId: original.id,
        type: "complained",
        occurredAt: "2026-07-27T18:01:00.000Z",
        recordedAt: "2026-07-27T18:01:00.000Z",
        actor: {
          type: "provider",
          provider: "provider-a",
          providerEventId: "complaint-stale-1",
        },
        evidence: null,
      },
    });
    const staleResult = await store.appendEvent({
      subscriber: {
        ...original,
        state: "unsubscribed",
        updatedAt: "2026-07-27T18:02:00.000Z",
      },
      event: {
        id: createSubscriberEventId("stale-unsubscribe"),
        siteId,
        subscriberId: original.id,
        type: "unsubscribed",
        occurredAt: "2026-07-27T18:02:00.000Z",
        recordedAt: "2026-07-27T18:02:00.000Z",
        actor: {
          type: "provider",
          provider: "provider-b",
          providerEventId: "unsubscribe-stale-1",
        },
        evidence: null,
      },
    });

    expect(staleResult.state).toBe("complained");
  });

  it("only reactivates through a distinct evidenced resubscription", async () => {
    const { application } = createFixture();
    await application.commands.recordConsent({
      actor: owner,
      email: "person@example.com",
      evidence: consent,
    });
    await application.commands.suppress({
      actor: owner,
      email: "person@example.com",
      reason: "unsubscribed",
      occurredAt: "2026-07-27T18:01:00.000Z",
    });

    await application.commands.resubscribe({
      actor: owner,
      email: "person@example.com",
      evidence: {
        ...consent,
        occurredAt: "2026-07-27T18:02:00.000Z",
        evidenceReference: "resubscribe-456",
      },
    });

    const exported = await application.queries.exportLedger({ actor: owner });
    expect(exported.subscribers[0]?.state).toBe("active");
    expect(exported.events.map((event) => event.type)).toEqual([
      "consent_recorded",
      "unsubscribed",
      "resubscribed",
    ]);
  });

  it("erases the address but retains a tombstone that routine sync cannot recreate", async () => {
    const { application } = createFixture();
    await application.commands.recordConsent({
      actor: owner,
      email: "person@example.com",
      evidence: consent,
    });
    const erased = await application.commands.suppress({
      actor: owner,
      email: "person@example.com",
      reason: "erased",
      occurredAt: "2026-07-27T18:01:00.000Z",
    });

    expect(erased).toMatchObject({ email: null, state: "erased" });
    await expect(
      application.commands.resubscribe({
        actor: owner,
        email: "person@example.com",
        evidence: consent,
      }),
    ).rejects.toBeInstanceOf(ErasedSubscriberError);
    await expect(
      application.provider.synchronizeProfile({
        email: "person@example.com",
      }),
    ).resolves.toMatchObject({ email: null, state: "erased" });
  });

  it("restricts identities and exports to Owners and audits sensitive access", async () => {
    const { application, store } = createFixture();
    await application.commands.recordConsent({
      actor: owner,
      email: "person@example.com",
      evidence: consent,
    });

    await expect(
      application.queries.listIdentities({ actor: editor }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    await application.queries.listIdentities({ actor: owner });
    await application.queries.exportLedger({ actor: owner });

    await expect(store.listSensitiveAccessEvents(siteId)).resolves.toEqual([
      expect.objectContaining({
        action: "subscriber-identities.read",
        actorMembershipId: ownerMembership.id,
      }),
      expect.objectContaining({
        action: "subscriber-ledger.export",
        actorMembershipId: ownerMembership.id,
      }),
    ]);
  });
});
