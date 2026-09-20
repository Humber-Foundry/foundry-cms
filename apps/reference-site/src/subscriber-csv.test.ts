import {
  createSubscriberEventId,
  createSubscriberId,
  type Subscriber,
  type SubscriberEvent,
} from "@humber-foundry/application";
import { describe, expect, it } from "vitest";

import { subscribersToCsv } from "./subscriber-csv";

function subscriber(overrides: Partial<Subscriber>): Subscriber {
  return {
    id: createSubscriberId("subscriber-1"),
    siteId: "site_reference" as Subscriber["siteId"],
    identityKey: "a".repeat(64),
    email: "person@example.com",
    state: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function consentEvent(
  subscriberId: Subscriber["id"],
  occurredAt: string,
): SubscriberEvent {
  return {
    id: createSubscriberEventId(`event-${subscriberId}-${occurredAt}`),
    siteId: "site_reference" as Subscriber["siteId"],
    subscriberId,
    type: "consent_recorded",
    occurredAt,
    recordedAt: occurredAt,
    actor: { type: "human", membershipId: "membership-1" as never },
    evidence: {
      lawfulBasis: "express",
      source: "public_form",
      occurredAt,
      disclosureVersion: "newsletter-v1",
      collectionSurface: "/newsletter",
      evidenceReference: "submission-1",
    },
  };
}

describe("subscribersToCsv", () => {
  it("writes a header row and one row per subscriber, in plain words", () => {
    const alice = subscriber({
      id: createSubscriberId("subscriber-alice"),
      email: "person@example.com",
      state: "active",
    });
    const bob = subscriber({
      id: createSubscriberId("subscriber-bob"),
      email: "left@example.com",
      state: "unsubscribed",
    });
    const csv = subscribersToCsv({
      subscribers: [alice, bob],
      events: [
        consentEvent(alice.id, "2026-01-01T00:00:00.000Z"),
        consentEvent(bob.id, "2026-01-02T00:00:00.000Z"),
      ],
    });
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe("Email address,State,Consent date");
    expect(lines[1]).toBe(
      "person@example.com,Confirmed,2026-01-01T00:00:00.000Z",
    );
    expect(lines[2]).toBe(
      "left@example.com,Unsubscribed,2026-01-02T00:00:00.000Z",
    );
    // Ends with a trailing line break, then nothing else.
    expect(lines.at(-1)).toBe("");
  });

  it("groups every suppression reason under Suppressed", () => {
    const csv = subscribersToCsv({
      subscribers: [
        subscriber({
          id: createSubscriberId("s1"),
          email: "a@example.com",
          state: "complained",
        }),
        subscriber({
          id: createSubscriberId("s2"),
          email: "b@example.com",
          state: "hard_bounced",
        }),
        subscriber({
          id: createSubscriberId("s3"),
          email: "c@example.com",
          state: "erased",
        }),
      ],
      events: [],
    });
    for (const line of csv.split("\r\n").slice(1, 4)) {
      expect(line).toContain(",Suppressed,");
    }
  });

  it("writes an empty field, not the word null, for an erased address", () => {
    const csv = subscribersToCsv({
      subscribers: [subscriber({ state: "erased", email: null })],
      events: [],
    });
    expect(csv.split("\r\n")[1]).toBe(",Suppressed,");
  });

  it("writes an empty consent date when no consent or resubscribe event exists", () => {
    const csv = subscribersToCsv({
      subscribers: [subscriber({ state: "complained" })],
      events: [],
    });
    expect(csv.split("\r\n")[1]).toBe("person@example.com,Suppressed,");
  });

  it("writes the latest consent date, not the record's creation date", () => {
    const person = subscriber({
      createdAt: "2020-01-01T00:00:00.000Z",
      state: "active",
    });
    const csv = subscribersToCsv({
      subscribers: [person],
      events: [
        consentEvent(person.id, "2020-01-01T00:00:00.000Z"),
        consentEvent(person.id, "2026-06-01T00:00:00.000Z"),
      ],
    });
    expect(csv.split("\r\n")[1]).toBe(
      "person@example.com,Confirmed,2026-06-01T00:00:00.000Z",
    );
  });

  it("quotes a field that holds a comma so a spreadsheet reads it as one field", () => {
    // An address cannot legally hold a comma, but a defensive escape still
    // protects every other field the ledger might one day add.
    const csv = subscribersToCsv({
      subscribers: [subscriber({ email: 'weird,"quoted"@example.com' })],
      events: [],
    });
    expect(csv.split("\r\n")[1]).toBe(
      '"weird,""quoted""@example.com",Confirmed,',
    );
  });

  it("writes only the header for an empty list", () => {
    expect(subscribersToCsv({ subscribers: [], events: [] })).toBe(
      "Email address,State,Consent date\r\n",
    );
  });

  describe("neutralizes CSV formula injection", () => {
    // A spreadsheet application treats a cell as a formula when it opens
    // with any of these characters. An email's local part may legally start
    // with =, + or - (email-address.ts only forbids whitespace and @), and
    // the address comes straight from the public signup form, so an Owner
    // opening the export in a spreadsheet must never run somebody else's
    // formula. @, tab and CR are neutralized too, defensively, in case this
    // column ever carries a value normalizeEmailAddress does not police.
    it.each([
      ["=", "=SUM(A1:A9)@evil.example"],
      ["+", "+1-800-000-0000@evil.example"],
      ["-", "-2+3+cmd|' /C calc'!A0@evil.example"],
      ["@", "@SUM(1+1)*cmd|' /C calc'!A0@evil.example"],
      ["tab", "\tmalicious@evil.example"],
    ])("prefixes a value starting with %s with a single quote", (_label, email) => {
      const csv = subscribersToCsv({
        subscribers: [subscriber({ email })],
        events: [],
      });
      const field = csv.split("\r\n")[1]?.split(",")[0];
      expect(field).toBe(`'${email}`);
      expect(field?.startsWith("=")).toBe(false);
      expect(field?.startsWith("+")).toBe(false);
      expect(field?.startsWith("-")).toBe(false);
      expect(field?.startsWith("@")).toBe(false);
    });

    it("prefixes a value starting with CR, then still quotes it for the embedded CR", () => {
      const email = "\rmalicious@evil.example";
      const csv = subscribersToCsv({
        subscribers: [subscriber({ email })],
        events: [],
      });
      expect(csv).toContain(`"'${email}",Confirmed,`);
    });
  });
});
