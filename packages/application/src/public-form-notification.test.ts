import { describe, expect, it, vi } from "vitest";

import { createSiteId } from "@humber-foundry/site-definition";

import {
  createHumanMembershipId,
  createHumanUserId,
} from "./human-access";
import {
  createPublicFormDeliveryId,
  createPublicFormId,
  createPublicFormReceiptId,
} from "./public-form";
import {
  createPublicFormOperationsApplication,
  deliverDuePublicFormNotifications,
  type PublicFormNotificationAdapter,
  type PublicFormNotificationStore,
} from "./public-form-notification";

const siteId = createSiteId("site_reference");
const deliveryId = createPublicFormDeliveryId("delivery-1");

function store(
  overrides: Partial<PublicFormNotificationStore> = {},
): PublicFormNotificationStore {
  return {
    claimDue: vi.fn().mockResolvedValue([
      {
        deliveryId,
        formId: createPublicFormId("contact"),
        receiptId: createPublicFormReceiptId("receipt-1"),
        acceptedAt: "2026-07-27T20:00:00.000Z",
        previewFields: { name: "Ada" },
        dashboardPath: "/dash/forms/receipt-1",
        leaseToken: "lease-1",
        attempt: 1,
        firstAvailableAt: "2026-07-27T20:00:00.000Z",
      },
    ]),
    recordOutcome: vi.fn().mockResolvedValue(true),
    deliveryHealth: vi.fn().mockResolvedValue({
      pending: 0,
      processing: 0,
      failed: 0,
      retries: 0,
      oldestPendingAgeSeconds: null,
      capacity: { usedPercent: 1, state: "normal" },
    }),
    replayFailed: vi.fn().mockResolvedValue(true),
    listSuspectedSpam: vi.fn().mockResolvedValue([]),
    listFailed: vi.fn().mockResolvedValue([]),
    viewSubmission: vi.fn().mockResolvedValue(null),
    releaseSuspectedSpam: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

describe("public form notification delivery", () => {
  it("requires owner data authority to release suspected spam", async () => {
    const notificationStore = store();
    const authorize = vi.fn().mockResolvedValue({
      id: createHumanMembershipId("membership-owner"),
      siteId,
      userId: createHumanUserId("user-owner"),
      email: "owner@example.com",
      identityBinding: { issuer: "issuer", subject: "owner" },
      role: "owner",
      status: "active",
    });
    const actor = {
      binding: { issuer: "issuer", subject: "owner" },
      email: "owner@example.com",
      nonce: "nonce",
    };
    const application = createPublicFormOperationsApplication({
      siteId,
      store: notificationStore,
      adapter: {
        notify: vi.fn(),
        health: vi.fn().mockResolvedValue("healthy"),
      },
      authorize,
      clock: () => new Date("2026-07-27T20:05:00.000Z"),
    });

    await application.commands.releaseSuspectedSpam({
      actor,
      receiptId: createPublicFormReceiptId("receipt-1"),
    });

    expect(authorize).toHaveBeenCalledWith(actor, "forms.data.manage");
  });

  it("claims a bounded lease and sends only adapter-defined destinations", async () => {
    const notificationStore = store();
    const adapter: PublicFormNotificationAdapter = {
      notify: vi.fn().mockResolvedValue({ outcome: "sent" }),
      health: vi.fn().mockResolvedValue("healthy"),
    };

    await expect(
      deliverDuePublicFormNotifications({
        siteId,
        store: notificationStore,
        adapter,
        now: new Date("2026-07-27T20:05:00.000Z"),
        createLeaseToken: () => "lease-1",
      }),
    ).resolves.toBe(1);

    expect(notificationStore.claimDue).toHaveBeenCalledWith({
      siteId,
      now: "2026-07-27T20:05:00.000Z",
      leaseToken: "lease-1",
      leaseUntil: "2026-07-27T20:09:00.000Z",
      limit: 25,
    });
    expect(adapter.notify).toHaveBeenCalledWith(
      expect.not.objectContaining({ recipient: expect.anything() }),
    );
    expect(notificationStore.recordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryId,
        leaseToken: "lease-1",
        outcome: { outcome: "sent" },
        nextAttemptAt: null,
      }),
    );
  });

  it("stops an ambiguous adapter outcome for explicit reconciliation", async () => {
    const notificationStore = store();
    const adapter: PublicFormNotificationAdapter = {
      notify: vi.fn().mockRejectedValue(new Error("outage")),
      health: vi.fn().mockResolvedValue("unavailable"),
    };

    await deliverDuePublicFormNotifications({
      siteId,
      store: notificationStore,
      adapter,
      now: new Date("2026-07-27T20:05:00.000Z"),
      createLeaseToken: () => "lease-1",
    });

    expect(notificationStore.recordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryId,
        outcome: {
          outcome: "permanent_failure",
          code: "adapter_outcome_unknown",
        },
        nextAttemptAt: null,
      }),
    );
  });
});
