import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  createPublicFormAuditEventId,
  createPublicFormClassificationId,
  createPublicFormDeliveryId,
  createPublicFormInboxPlan,
  createPublicFormId,
  createPublicFormOutboxEventId,
  createPublicFormReceiptId,
  createPublicFormRequestHash,
  createPublicFormSubmissionId,
  type PublicFormAcceptance,
} from "@humber-foundry/application";
import { createSiteId } from "@humber-foundry/site-definition";

import type { D1DatabaseBinding } from "./d1-human-access-store";
import { createD1PublicFormNotificationStore } from "./d1-public-form-notification-store";
import { createD1PublicFormPrivacyStore } from "./d1-public-form-privacy-store";
import { createD1PublicFormAcceptanceStore } from "./d1-public-form-store";
import { useMigratedTestDatabase } from "./test-support/migrated-test-database";

const { database } = useMigratedTestDatabase([
  "0003_public_forms.sql",
  "0004_public_form_notifications.sql",
  "0006_public_form_privacy.sql",
  "0026_public_form_inbox.sql",
]);

const siteId = createSiteId("site_reference");
const accepted: PublicFormAcceptance = {
  identity: {
    siteId,
    formId: createPublicFormId("contact"),
    submissionId: createPublicFormSubmissionId(
      "00000000-0000-4000-8000-000000000047",
    ),
  },
  schemaVersion: "1.0.0",
  receiptId: createPublicFormReceiptId("receipt-47"),
  requestHash: createPublicFormRequestHash("hash-47"),
  fields: { name: "Ada", message: "Private full submission" },
  classification: "accepted",
  deliveryStatus: "pending",
  classificationId: createPublicFormClassificationId("classification-47"),
  auditEventId: createPublicFormAuditEventId("audit-47"),
  deliveryId: createPublicFormDeliveryId("delivery-47"),
  outboxEventId: createPublicFormOutboxEventId("outbox-47"),
  acceptedAt: "2026-07-27T20:00:00.000Z",
};

const inboxPlan = createPublicFormInboxPlan([
  {
    id: createPublicFormId("contact"),
    fields: [
      { id: "name", required: true, maximumLength: 100, inboxRole: "sender" },
      {
        id: "email",
        required: false,
        maximumLength: 254,
        inboxRole: "replyAddress",
      },
      {
        id: "message",
        required: true,
        maximumLength: 2_000,
        inboxRole: "preview",
      },
    ],
  },
]);

function submissionAt(
  index: number,
  overrides: Partial<PublicFormAcceptance> = {},
): PublicFormAcceptance {
  const suffix = String(index).padStart(2, "0");
  return {
    ...accepted,
    identity: {
      ...accepted.identity,
      submissionId: createPublicFormSubmissionId(
        `00000000-0000-4000-8000-0000000000${suffix}`,
      ),
    },
    receiptId: createPublicFormReceiptId(`receipt-${suffix}`),
    requestHash: createPublicFormRequestHash(`hash-${suffix}`),
    classificationId: createPublicFormClassificationId(
      `classification-${suffix}`,
    ),
    auditEventId: createPublicFormAuditEventId(`audit-${suffix}`),
    deliveryId: createPublicFormDeliveryId(`delivery-${suffix}`),
    outboxEventId: createPublicFormOutboxEventId(`outbox-${suffix}`),
    acceptedAt: `2026-07-2${index}T20:00:00.000Z`,
    ...overrides,
  };
}

describe("D1 public form inbox", () => {
  it("lists received messages newest first and leaves held spam out", async () => {
    const acceptanceStore = createD1PublicFormAcceptanceStore(database);
    await acceptanceStore.accept(
      submissionAt(1, {
        fields: {
          name: "Ada",
          email: "ada@example.com",
          message: "Please call me back.",
        },
      }),
    );
    await acceptanceStore.accept(
      submissionAt(2, { fields: { name: "Grace", message: "Second message" } }),
    );
    await acceptanceStore.accept(
      submissionAt(3, {
        fields: { name: "Robot", message: "Cheap watches" },
        classification: "suspected_spam",
        deliveryStatus: "held",
      }),
    );
    const store = createD1PublicFormNotificationStore(database, { inboxPlan });

    const page = await store.listInbox({
      siteId,
      limit: 25,
      olderThanReceiptId: null,
    });

    expect(page.messages).toEqual([
      {
        formId: accepted.identity.formId,
        receiptId: createPublicFormReceiptId("receipt-02"),
        acceptedAt: "2026-07-22T20:00:00.000Z",
        read: false,
        senderName: "Grace",
        replyAddress: null,
        preview: "Second message",
        payloadDeleted: false,
      },
      {
        formId: accepted.identity.formId,
        receiptId: createPublicFormReceiptId("receipt-01"),
        acceptedAt: "2026-07-21T20:00:00.000Z",
        read: false,
        senderName: "Ada",
        replyAddress: "ada@example.com",
        preview: "Please call me back.",
        payloadDeleted: false,
      },
    ]);
    expect(page.olderCursor).toBeNull();
    expect(page.unreadCount).toBe(2);
  });

  it("pages through older messages with a receipt cursor", async () => {
    const acceptanceStore = createD1PublicFormAcceptanceStore(database);
    for (const index of [1, 2, 3]) {
      await acceptanceStore.accept(submissionAt(index));
    }
    const store = createD1PublicFormNotificationStore(database, { inboxPlan });

    const first = await store.listInbox({
      siteId,
      limit: 2,
      olderThanReceiptId: null,
    });
    expect(first.messages.map((message) => message.receiptId)).toEqual([
      "receipt-03",
      "receipt-02",
    ]);
    expect(first.olderCursor).toBe("receipt-02");

    const second = await store.listInbox({
      siteId,
      limit: 2,
      olderThanReceiptId: first.olderCursor,
    });
    expect(second.messages.map((message) => message.receiptId)).toEqual([
      "receipt-01",
    ]);
    expect(second.olderCursor).toBeNull();
    expect(second.unreadCount).toBe(3);
  });

  it("marks a message read the first time a human opens it", async () => {
    await createD1PublicFormAcceptanceStore(database).accept(submissionAt(1));
    const store = createD1PublicFormNotificationStore(database, { inboxPlan });

    await store.viewSubmission({
      siteId,
      receiptId: createPublicFormReceiptId("receipt-01"),
      actorMembershipId: "membership-owner",
      now: "2026-07-27T20:05:00.000Z",
    });
    await store.viewSubmission({
      siteId,
      receiptId: createPublicFormReceiptId("receipt-01"),
      actorMembershipId: "membership-editor",
      now: "2026-07-27T21:05:00.000Z",
    });

    const page = await store.listInbox({
      siteId,
      limit: 25,
      olderThanReceiptId: null,
    });
    expect(page.messages).toEqual([
      expect.objectContaining({ read: true }),
    ]);
    expect(page.unreadCount).toBe(0);
    await expect(
      database
        .prepare(
          `SELECT first_read_at, first_read_by
           FROM public_form_submission_reads`,
        )
        .first<{ first_read_at: string; first_read_by: string }>(),
    ).resolves.toEqual({
      first_read_at: "2026-07-27T20:05:00.000Z",
      first_read_by: "membership-owner",
    });
  });

  it("counts unread messages without reading what they say", async () => {
    const acceptanceStore = createD1PublicFormAcceptanceStore(database);
    await acceptanceStore.accept(
      submissionAt(1, { fields: { name: "Ada", message: "Secret words" } }),
    );
    await acceptanceStore.accept(submissionAt(2));
    await acceptanceStore.accept(
      submissionAt(3, {
        classification: "suspected_spam",
        deliveryStatus: "held",
      }),
    );
    const store = createD1PublicFormNotificationStore(database, { inboxPlan });

    await expect(store.countUnreadInbox({ siteId })).resolves.toBe(2);

    await store.viewSubmission({
      siteId,
      receiptId: createPublicFormReceiptId("receipt-01"),
      actorMembershipId: "membership-owner",
      now: "2026-07-27T20:05:00.000Z",
    });
    await expect(store.countUnreadInbox({ siteId })).resolves.toBe(1);
  });

  it("keeps an erased message in the inbox without its payload", async () => {
    await createD1PublicFormAcceptanceStore(database).accept(submissionAt(1));
    await createD1PublicFormPrivacyStore(
      database as unknown as D1DatabaseBinding,
    ).eraseSubmissionPayload({
      siteId,
      receiptId: createPublicFormReceiptId("receipt-01"),
      actorMembershipId: "membership-owner",
      reason: "authorized_erasure",
      now: "2026-07-27T20:05:00.000Z",
    });
    const store = createD1PublicFormNotificationStore(database, { inboxPlan });

    await expect(
      store.listInbox({ siteId, limit: 25, olderThanReceiptId: null }),
    ).resolves.toMatchObject({
      messages: [
        expect.objectContaining({
          payloadDeleted: true,
          preview: "",
          senderName: null,
        }),
      ],
    });
  });
});

describe("D1 public form notification store", () => {
  it("measures capacity in UTF-8 bytes", async () => {
    const unicodeAcceptance = {
      ...accepted,
      fields: { message: "🪶" },
    };
    await createD1PublicFormAcceptanceStore(database).accept(unicodeAcceptance);
    const encodedBytes = new TextEncoder().encode(
      JSON.stringify(unicodeAcceptance.fields),
    ).byteLength;
    const store = createD1PublicFormNotificationStore(database, {
      capacityLimitBytes: encodedBytes + 1024,
    });

    await expect(
      store.deliveryHealth({
        siteId,
        now: "2026-07-27T20:05:00.000Z",
      }),
    ).resolves.toMatchObject({
      capacity: { usedPercent: 100, state: "critical" },
    });
  });

  it("claims once, exposes only configured preview fields, and records delivery", async () => {
    await createD1PublicFormAcceptanceStore(database).accept(accepted);
    const store = createD1PublicFormNotificationStore(database, {
      notificationPreviewFieldIds: ["name"],
    });

    const claim = await store.claimDue({
      siteId,
      now: "2026-07-27T20:05:00.000Z",
      leaseToken: "lease-1",
      leaseUntil: "2026-07-27T20:09:00.000Z",
      limit: 25,
    });
    expect(claim).toEqual([
      expect.objectContaining({
        deliveryId: accepted.deliveryId,
        previewFields: { name: "Ada" },
        attempt: 1,
      }),
    ]);
    expect(JSON.stringify(claim)).not.toContain("Private full submission");
    await expect(
      store.claimDue({
        siteId,
        now: "2026-07-27T20:05:00.000Z",
        leaseToken: "lease-2",
        leaseUntil: "2026-07-27T20:09:00.000Z",
        limit: 25,
      }),
    ).resolves.toEqual([]);
    await expect(
      store.recordOutcome({
        siteId,
        deliveryId: accepted.deliveryId,
        leaseToken: "lease-1",
        outcome: { outcome: "sent", providerReference: "provider-1" },
        now: "2026-07-27T20:05:01.000Z",
        nextAttemptAt: null,
      }),
    ).resolves.toBe(true);
  });

  it("keeps failures replayable without changing the accepted submission", async () => {
    await createD1PublicFormAcceptanceStore(database).accept(accepted);
    const store = createD1PublicFormNotificationStore(database);
    await store.claimDue({
      siteId,
      now: "2026-07-27T20:05:00.000Z",
      leaseToken: "lease-1",
      leaseUntil: "2026-07-27T20:09:00.000Z",
      limit: 25,
    });
    await store.recordOutcome({
      siteId,
      deliveryId: accepted.deliveryId,
      leaseToken: "lease-1",
      outcome: { outcome: "permanent_failure", code: "rejected" },
      now: "2026-07-27T20:05:01.000Z",
      nextAttemptAt: null,
    });
    await expect(store.listFailed({ siteId })).resolves.toEqual([
      {
        deliveryId: accepted.deliveryId,
        formId: accepted.identity.formId,
        receiptId: accepted.receiptId,
        attempts: 1,
        errorCode: "rejected",
        updatedAt: "2026-07-27T20:05:01.000Z",
      },
    ]);
    await expect(
      store.replayFailed({
        siteId,
        deliveryId: accepted.deliveryId,
        actorMembershipId: "membership-owner",
        now: "2026-07-27T20:06:00.000Z",
      }),
    ).resolves.toBe(true);
    const submission = await database
      .prepare(
        "SELECT fields_json FROM public_form_submissions WHERE receipt_id = ?1",
      )
      .bind(accepted.receiptId)
      .first<{ fields_json: string }>();
    expect(submission?.fields_json).toContain("Private full submission");
  });

  it("does not list or replay a delivery after its payload is erased", async () => {
    await createD1PublicFormAcceptanceStore(database).accept(accepted);
    await database
      .prepare(
        `UPDATE public_form_notification_jobs
         SET status = 'failed', last_error_code = 'rejected'
         WHERE delivery_id = ?1`,
      )
      .bind(accepted.deliveryId)
      .run();
    await createD1PublicFormPrivacyStore(
      database as unknown as D1DatabaseBinding,
    ).eraseSubmissionPayload({
      siteId,
      receiptId: accepted.receiptId,
      actorMembershipId: "membership-owner",
      reason: "authorized_erasure",
      now: "2026-07-27T20:05:00.000Z",
    });
    const store = createD1PublicFormNotificationStore(database);

    await expect(store.listFailed({ siteId })).resolves.toEqual([]);
    await expect(
      store.viewSubmission({
        siteId,
        receiptId: accepted.receiptId,
        actorMembershipId: "membership-owner",
        now: "2026-07-27T20:05:30.000Z",
      }),
    ).resolves.toMatchObject({ fields: {}, payloadDeleted: true });
    await expect(
      store.replayFailed({
        siteId,
        deliveryId: accepted.deliveryId,
        actorMembershipId: "membership-owner",
        now: "2026-07-27T20:06:00.000Z",
      }),
    ).resolves.toBe(false);
  });

  it("preserves successful retry counts in delivery health", async () => {
    await createD1PublicFormAcceptanceStore(database).accept(accepted);
    await database
      .prepare(
        `UPDATE public_form_notification_jobs
         SET status = 'delivered', attempts = 2, last_error_code = NULL
         WHERE delivery_id = ?1`,
      )
      .bind(accepted.deliveryId)
      .run();

    await expect(
      createD1PublicFormNotificationStore(database).deliveryHealth({
        siteId,
        now: "2026-07-27T20:06:00.000Z",
      }),
    ).resolves.toMatchObject({ failed: 0, retries: 1 });
  });

  it("does not release erased spam or record a misleading release audit", async () => {
    const held: PublicFormAcceptance = {
      ...accepted,
      classification: "suspected_spam",
      deliveryStatus: "held",
    };
    await createD1PublicFormAcceptanceStore(database).accept(held);
    await database
      .prepare(
        `UPDATE public_form_notification_jobs
         SET attempts = 3 WHERE delivery_id = ?1`,
      )
      .bind(held.deliveryId)
      .run();
    await createD1PublicFormPrivacyStore(
      database as unknown as D1DatabaseBinding,
    ).eraseSubmissionPayload({
      siteId,
      receiptId: held.receiptId,
      actorMembershipId: "membership-owner",
      reason: "authorized_erasure",
      now: "2026-07-27T20:05:00.000Z",
    });
    const store = createD1PublicFormNotificationStore(database);

    await expect(store.listSuspectedSpam({ siteId })).resolves.toEqual([]);
    await expect(
      store.deliveryHealth({
        siteId,
        now: "2026-07-27T20:06:00.000Z",
      }),
    ).resolves.toMatchObject({ failed: 0, retries: 0 });
    await expect(
      store.releaseSuspectedSpam({
        siteId,
        receiptId: held.receiptId,
        actorMembershipId: "membership-owner",
        now: "2026-07-27T20:06:00.000Z",
      }),
    ).resolves.toBe(false);
    const classification = await database
      .prepare(
        `SELECT classification FROM public_form_classifications
         WHERE site_id = ?1`,
      )
      .bind(siteId)
      .first<{ classification: string }>();
    expect(classification?.classification).toBe("suspected_spam");
    const releaseFacts = await database
      .prepare(
        `SELECT COUNT(*) AS count FROM public_form_operation_audit_events
         WHERE action = 'spam_released'`,
      )
      .first<{ count: number }>();
    expect(releaseFacts?.count).toBe(0);
  });

  it("stops an expired claim for explicit reconciliation", async () => {
    await createD1PublicFormAcceptanceStore(database).accept(accepted);
    const store = createD1PublicFormNotificationStore(database);
    await store.claimDue({
      siteId,
      now: "2026-07-27T20:05:00.000Z",
      leaseToken: "lost-worker",
      leaseUntil: "2026-07-27T20:09:00.000Z",
      limit: 25,
    });

    await expect(
      store.claimDue({
        siteId,
        now: "2026-07-27T20:10:00.000Z",
        leaseToken: "next-worker",
        leaseUntil: "2026-07-27T20:14:00.000Z",
        limit: 25,
      }),
    ).resolves.toEqual([]);
    await expect(store.listFailed({ siteId })).resolves.toEqual([
      expect.objectContaining({
        deliveryId: accepted.deliveryId,
        errorCode: "claim_outcome_unknown",
      }),
    ]);
    const audit = await database
      .prepare(
        `SELECT action, outcome_code
         FROM public_form_operation_audit_events
         WHERE delivery_id = ?1`,
      )
      .bind(accepted.deliveryId)
      .first<{ action: string; outcome_code: string }>();
    expect(audit).toEqual({
      action: "delivery_failed",
      outcome_code: "claim_outcome_unknown",
    });
    await expect(
      store.replayFailed({
        siteId,
        deliveryId: accepted.deliveryId,
        actorMembershipId: "membership-owner",
        now: "2026-07-27T20:11:00.000Z",
      }),
    ).resolves.toBe(true);
  });

  it("lists held spam without payload and releases it for authorized delivery", async () => {
    const held: PublicFormAcceptance = {
      ...accepted,
      classification: "suspected_spam",
      deliveryStatus: "held",
    };
    await createD1PublicFormAcceptanceStore(database).accept(held);
    const store = createD1PublicFormNotificationStore(database);

    await expect(store.listSuspectedSpam({ siteId })).resolves.toEqual([
      {
        formId: held.identity.formId,
        receiptId: held.receiptId,
        acceptedAt: held.acceptedAt,
      },
    ]);
    await expect(
      store.viewSubmission({
        siteId,
        receiptId: held.receiptId,
        actorMembershipId: "membership-editor",
        now: "2026-07-27T20:09:00.000Z",
      }),
    ).resolves.toEqual({
      formId: held.identity.formId,
      receiptId: held.receiptId,
      acceptedAt: held.acceptedAt,
      classification: "suspected_spam",
      fields: held.fields,
      payloadDeleted: false,
    });
    await expect(
      store.releaseSuspectedSpam({
        siteId,
        receiptId: held.receiptId,
        actorMembershipId: "membership-owner",
        now: "2026-07-27T20:10:00.000Z",
      }),
    ).resolves.toBe(true);
    await expect(
      store.claimDue({
        siteId,
        now: "2026-07-27T20:10:00.000Z",
        leaseToken: "lease-review",
        leaseUntil: "2026-07-27T20:14:00.000Z",
        limit: 25,
      }),
    ).resolves.toHaveLength(1);
  });
});
