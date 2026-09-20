import {
  createSubscriberId,
  type Subscriber,
  type SubscriberIdentity,
} from "@humber-foundry/application";
import { describe, expect, it } from "vitest";

import {
  countSubscribersByDisplayState,
  subscriberDisplayState,
  subscriberDisplayStateLabel,
  toSubscriberDisplayRow,
} from "./subscriber-display";

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

function identity(
  overrides: Partial<SubscriberIdentity> = {},
): SubscriberIdentity {
  return {
    ...subscriber(overrides),
    latestConsentAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("subscriberDisplayState", () => {
  it("shows a confirmed subscriber as confirmed", () => {
    expect(subscriberDisplayState("active")).toBe("confirmed");
  });

  it("shows an unsubscribed address as unsubscribed", () => {
    expect(subscriberDisplayState("unsubscribed")).toBe("unsubscribed");
  });

  it("groups every suppression reason under suppressed", () => {
    expect(subscriberDisplayState("complained")).toBe("suppressed");
    expect(subscriberDisplayState("hard_bounced")).toBe("suppressed");
    expect(subscriberDisplayState("erased")).toBe("suppressed");
  });

  it("has a plain label for every display state", () => {
    expect(subscriberDisplayStateLabel.confirmed).toBe("Confirmed");
    expect(subscriberDisplayStateLabel.unsubscribed).toBe("Unsubscribed");
    expect(subscriberDisplayStateLabel.suppressed).toBe("Suppressed");
  });
});

describe("toSubscriberDisplayRow", () => {
  it("carries the latest consent date, not the record's own creation date", () => {
    const row = toSubscriberDisplayRow(
      identity({
        state: "hard_bounced",
        createdAt: "2025-03-04T00:00:00.000Z",
        updatedAt: "2026-06-01T00:00:00.000Z",
        latestConsentAt: "2025-03-04T00:00:05.000Z",
      }),
    );
    expect(row.consentDate).toBe("2025-03-04T00:00:05.000Z");
    expect(row.displayState).toBe("suppressed");
  });

  it("keeps a null email as null once an address is erased", () => {
    const row = toSubscriberDisplayRow(
      identity({ state: "erased", email: null }),
    );
    expect(row.email).toBeNull();
    expect(row.displayState).toBe("suppressed");
  });

  it("carries no consent date for a record that never went through consent", () => {
    const row = toSubscriberDisplayRow(
      identity({ state: "complained", latestConsentAt: null }),
    );
    expect(row.consentDate).toBeNull();
  });
});

describe("countSubscribersByDisplayState", () => {
  it("counts each display state without returning any identity", () => {
    const counts = countSubscribersByDisplayState([
      subscriber({ id: createSubscriberId("s1"), state: "active" }),
      subscriber({ id: createSubscriberId("s2"), state: "active" }),
      subscriber({ id: createSubscriberId("s3"), state: "unsubscribed" }),
      subscriber({ id: createSubscriberId("s4"), state: "complained" }),
      subscriber({ id: createSubscriberId("s5"), state: "hard_bounced" }),
      subscriber({ id: createSubscriberId("s6"), state: "erased" }),
    ]);
    expect(counts).toStrictEqual({
      confirmed: 2,
      unsubscribed: 1,
      suppressed: 3,
    });
  });

  it("returns zero counts for no subscribers", () => {
    expect(countSubscribersByDisplayState([])).toStrictEqual({
      confirmed: 0,
      unsubscribed: 0,
      suppressed: 0,
    });
  });
});
