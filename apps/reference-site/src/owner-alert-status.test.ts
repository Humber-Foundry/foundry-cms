import { describe, expect, it } from "vitest";

import type { PublicFormDeliveryHealth } from "@humber-foundry/application";

import {
  ownerAlertSenderState,
  ownerAlertStopReason,
  ownerAlertSummary,
} from "./owner-alert-status";

const healthy: PublicFormDeliveryHealth = {
  pending: 0,
  processing: 0,
  failed: 0,
  retries: 0,
  oldestPendingAgeSeconds: null,
  adapter: "healthy",
  capacity: { usedPercent: 0, state: "normal" },
};

describe("owner alert summary", () => {
  it("says the alerts are working only when nothing failed and the sender is healthy", () => {
    expect(ownerAlertSummary(healthy)).toBe(
      "Email alerts about new messages are working.",
    );
  });

  it("never claims the alerts are working while the email service cannot send", () => {
    expect(ownerAlertSummary({ ...healthy, adapter: "unavailable" })).toBe(
      "Email alerts about new messages are not being sent right now.",
    );
    expect(ownerAlertSummary({ ...healthy, adapter: "degraded" })).toBe(
      "Email alerts about new messages are slower than usual.",
    );
  });

  it("counts the alerts that stopped, and does not call one of them several", () => {
    expect(ownerAlertSummary({ ...healthy, failed: 1 })).toBe(
      "1 email alert did not reach you.",
    );
    expect(ownerAlertSummary({ ...healthy, failed: 3 })).toBe(
      "3 email alerts did not reach you.",
    );
  });

  it("names a stopped alert first, because that is the one to send again", () => {
    expect(
      ownerAlertSummary({ ...healthy, failed: 2, adapter: "unavailable" }),
    ).toBe("2 email alerts did not reach you.");
  });

  it("waiting alerts are alerts working, not a warning", () => {
    expect(
      ownerAlertSummary({
        ...healthy,
        pending: 4,
        processing: 1,
        oldestPendingAgeSeconds: 120,
      }),
    ).toBe("Email alerts about new messages are working.");
  });
});

describe("owner alert sender state", () => {
  it("says in words whether the email service can send", () => {
    expect(ownerAlertSenderState("healthy")).toBe(
      "The email service is working.",
    );
    expect(ownerAlertSenderState("unavailable")).toBe(
      "Email alerts about new messages are not being sent right now.",
    );
  });
});

describe("owner alert stop reason", () => {
  it("explains a known code in words", () => {
    expect(ownerAlertStopReason("adapter_outcome_unknown")).toBe(
      "The email service did not answer.",
    );
  });

  it("falls back to a plain sentence for a code it does not know", () => {
    expect(ownerAlertStopReason("provider_rejected")).toBe(
      "The email service refused it.",
    );
  });
});
