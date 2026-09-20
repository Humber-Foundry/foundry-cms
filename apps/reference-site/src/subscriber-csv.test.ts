import { createSubscriberId, type Subscriber } from "@humber-foundry/application";
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

describe("subscribersToCsv", () => {
  it("writes a header row and one row per subscriber, in plain words", () => {
    const csv = subscribersToCsv([
      subscriber({ email: "person@example.com", state: "active" }),
      subscriber({ email: "left@example.com", state: "unsubscribed" }),
    ]);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe("Email address,State,Consent date");
    expect(lines[1]).toBe(
      "person@example.com,Confirmed,2026-01-01T00:00:00.000Z",
    );
    expect(lines[2]).toBe(
      "left@example.com,Unsubscribed,2026-01-01T00:00:00.000Z",
    );
    // Ends with a trailing line break, then nothing else.
    expect(lines.at(-1)).toBe("");
  });

  it("groups every suppression reason under Suppressed", () => {
    const csv = subscribersToCsv([
      subscriber({ email: "a@example.com", state: "complained" }),
      subscriber({ email: "b@example.com", state: "hard_bounced" }),
      subscriber({ email: "c@example.com", state: "erased" }),
    ]);
    for (const line of csv.split("\r\n").slice(1, 4)) {
      expect(line).toContain(",Suppressed,");
    }
  });

  it("writes an empty field, not the word null, for an erased address", () => {
    const csv = subscribersToCsv([subscriber({ state: "erased", email: null })]);
    expect(csv.split("\r\n")[1]).toBe(",Suppressed,2026-01-01T00:00:00.000Z");
  });

  it("quotes a field that holds a comma so a spreadsheet reads it as one field", () => {
    // An address cannot legally hold a comma, but a defensive escape still
    // protects every other field the ledger might one day add.
    const csv = subscribersToCsv([
      subscriber({ email: 'weird,"quoted"@example.com' }),
    ]);
    expect(csv.split("\r\n")[1]).toBe(
      '"weird,""quoted""@example.com",Confirmed,2026-01-01T00:00:00.000Z',
    );
  });

  it("writes only the header for an empty list", () => {
    expect(subscribersToCsv([])).toBe("Email address,State,Consent date\r\n");
  });
});
