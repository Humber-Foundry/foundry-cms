import type { SiteId } from "@humber-foundry/site-definition";

import type {
  ExternalHumanIdentity,
  HumanCapability,
  HumanMembership,
} from "./human-access";
import {
  publicFormInboxPageSize,
  type PublicFormInboxPage,
} from "./public-form-inbox";
import type {
  PublicFormDeliveryId,
  PublicFormId,
  PublicFormReceiptId,
} from "./public-form";

export type PublicFormNotification = Readonly<{
  deliveryId: PublicFormDeliveryId;
  formId: PublicFormId;
  receiptId: PublicFormReceiptId;
  acceptedAt: string;
  previewFields: Readonly<Record<string, string>>;
  dashboardPath: `/dash${string}`;
}>;

export type PublicFormNotificationOutcome =
  | Readonly<{ outcome: "sent"; providerReference?: string }>
  | Readonly<{ outcome: "retry"; code: string }>
  | Readonly<{ outcome: "permanent_failure"; code: string }>;

export interface PublicFormNotificationAdapter {
  notify(
    notification: PublicFormNotification,
  ): Promise<PublicFormNotificationOutcome>;
  health(): Promise<"healthy" | "degraded" | "unavailable">;
}

export type ClaimedPublicFormNotification = PublicFormNotification &
  Readonly<{
    leaseToken: string;
    attempt: number;
    firstAvailableAt: string;
  }>;

export type PublicFormDeliveryHealth = Readonly<{
  pending: number;
  processing: number;
  failed: number;
  retries: number;
  oldestPendingAgeSeconds: number | null;
  adapter: "healthy" | "degraded" | "unavailable";
  capacity: Readonly<{
    usedPercent: number;
    state: "normal" | "warning" | "critical";
  }>;
}>;

/**
 * A submission the spam check held back.
 *
 * It deliberately carries no field content. Reading what a held submission
 * says is an audited act, so a human opens it through `submission` instead.
 */
export type SuspectedSpamSubmission = Readonly<{
  formId: PublicFormId;
  receiptId: PublicFormReceiptId;
  acceptedAt: string;
}>;

export type FailedPublicFormDelivery = Readonly<{
  deliveryId: PublicFormDeliveryId;
  formId: PublicFormId;
  receiptId: PublicFormReceiptId;
  attempts: number;
  errorCode: string;
  updatedAt: string;
}>;

export type ReviewedPublicFormSubmission = Readonly<{
  formId: PublicFormId;
  receiptId: PublicFormReceiptId;
  acceptedAt: string;
  classification: "accepted" | "suspected_spam";
  fields: Readonly<Record<string, string>>;
  payloadDeleted: boolean;
}>;

export interface PublicFormNotificationStore {
  claimDue(input: {
    siteId: SiteId;
    now: string;
    leaseToken: string;
    leaseUntil: string;
    limit: number;
  }): Promise<ReadonlyArray<ClaimedPublicFormNotification>>;
  recordOutcome(input: {
    siteId: SiteId;
    deliveryId: PublicFormDeliveryId;
    leaseToken: string;
    outcome: PublicFormNotificationOutcome;
    now: string;
    nextAttemptAt: string | null;
  }): Promise<boolean>;
  deliveryHealth(input: {
    siteId: SiteId;
    now: string;
  }): Promise<Omit<PublicFormDeliveryHealth, "adapter">>;
  replayFailed(input: {
    siteId: SiteId;
    deliveryId: PublicFormDeliveryId;
    actorMembershipId: string;
    now: string;
  }): Promise<boolean>;
  listInbox(input: {
    siteId: SiteId;
    limit: number;
    olderThanReceiptId: PublicFormReceiptId | null;
  }): Promise<PublicFormInboxPage>;
  countUnreadInbox(input: { siteId: SiteId }): Promise<number>;
  listSuspectedSpam(input: {
    siteId: SiteId;
  }): Promise<ReadonlyArray<SuspectedSpamSubmission>>;
  listFailed(input: {
    siteId: SiteId;
  }): Promise<ReadonlyArray<FailedPublicFormDelivery>>;
  viewSubmission(input: {
    siteId: SiteId;
    receiptId: PublicFormReceiptId;
    actorMembershipId: string;
    now: string;
  }): Promise<ReviewedPublicFormSubmission | null>;
  releaseSuspectedSpam(input: {
    siteId: SiteId;
    receiptId: PublicFormReceiptId;
    actorMembershipId: string;
    now: string;
  }): Promise<boolean>;
}

export type PublicFormOperationsApplication = Readonly<{
  queries: Readonly<{
    health(input: {
      actor: ExternalHumanIdentity;
    }): Promise<PublicFormDeliveryHealth>;
    inbox(input: {
      actor: ExternalHumanIdentity;
      olderThanReceiptId?: PublicFormReceiptId | null;
    }): Promise<PublicFormInboxPage>;
    unreadCount(input: { actor: ExternalHumanIdentity }): Promise<number>;
    suspectedSpam(input: {
      actor: ExternalHumanIdentity;
    }): Promise<ReadonlyArray<SuspectedSpamSubmission>>;
    failedDeliveries(input: {
      actor: ExternalHumanIdentity;
    }): Promise<ReadonlyArray<FailedPublicFormDelivery>>;
    submission(input: {
      actor: ExternalHumanIdentity;
      receiptId: PublicFormReceiptId;
    }): Promise<ReviewedPublicFormSubmission>;
  }>;
  commands: Readonly<{
    replayFailed(input: {
      actor: ExternalHumanIdentity;
      deliveryId: PublicFormDeliveryId;
    }): Promise<void>;
    releaseSuspectedSpam(input: {
      actor: ExternalHumanIdentity;
      receiptId: PublicFormReceiptId;
    }): Promise<void>;
  }>;
}>;

const maximumAttempts = 8;
const retryWindowMs = 24 * 60 * 60 * 1_000;
const leaseMs = 4 * 60 * 1_000;
const batchSize = 25;

function retryAt(claim: ClaimedPublicFormNotification, now: Date) {
  if (claim.attempt >= maximumAttempts) {
    return null;
  }
  const deadline = Date.parse(claim.firstAvailableAt) + retryWindowMs;
  const delay = Math.min(15 * 60 * 1_000, 30_000 * 2 ** (claim.attempt - 1));
  const next = now.getTime() + delay;
  return next <= deadline ? new Date(next).toISOString() : null;
}

export async function deliverDuePublicFormNotifications({
  siteId,
  store,
  adapter,
  now,
  createLeaseToken,
}: {
  siteId: SiteId;
  store: PublicFormNotificationStore;
  adapter: PublicFormNotificationAdapter;
  now: Date;
  createLeaseToken: () => string;
}) {
  const leaseToken = createLeaseToken();
  const claims = await store.claimDue({
    siteId,
    now: now.toISOString(),
    leaseToken,
    leaseUntil: new Date(now.getTime() + leaseMs).toISOString(),
    limit: batchSize,
  });
  for (const claim of claims) {
    let outcome: PublicFormNotificationOutcome;
    try {
      outcome = await adapter.notify({
        deliveryId: claim.deliveryId,
        formId: claim.formId,
        receiptId: claim.receiptId,
        acceptedAt: claim.acceptedAt,
        previewFields: claim.previewFields,
        dashboardPath: claim.dashboardPath,
      });
    } catch {
      outcome = {
        outcome: "permanent_failure",
        code: "adapter_outcome_unknown",
      };
    }
    const nextAttemptAt =
      outcome.outcome === "retry" ? retryAt(claim, now) : null;
    await store.recordOutcome({
      siteId,
      deliveryId: claim.deliveryId,
      leaseToken,
      outcome:
        outcome.outcome === "retry" && nextAttemptAt === null
          ? { outcome: "permanent_failure", code: "retry_window_exhausted" }
          : outcome,
      now: now.toISOString(),
      nextAttemptAt,
    });
  }
  return claims.length;
}

export function createPublicFormOperationsApplication({
  siteId,
  store,
  adapter,
  authorize,
  clock = () => new Date(),
}: {
  siteId: SiteId;
  store: PublicFormNotificationStore;
  adapter: PublicFormNotificationAdapter;
  authorize(
    actor: ExternalHumanIdentity,
    capability: HumanCapability,
  ): Promise<HumanMembership>;
  clock?: () => Date;
}): PublicFormOperationsApplication {
  const queries: PublicFormOperationsApplication["queries"] = Object.freeze({
      async health({ actor }) {
        await authorize(actor, "dashboard.view");
        const [health, adapterHealth] = await Promise.all([
          store.deliveryHealth({ siteId, now: clock().toISOString() }),
          adapter.health(),
        ]);
        return {
          ...health,
          adapter:
            adapterHealth === "healthy" && health.failed > 0
              ? "degraded"
              : adapterHealth,
        };
      },
      async inbox({ actor, olderThanReceiptId = null }) {
        await authorize(actor, "forms.review");
        return store.listInbox({
          siteId,
          limit: publicFormInboxPageSize,
          olderThanReceiptId,
        });
      },
      async unreadCount({ actor }) {
        await authorize(actor, "forms.review");
        return store.countUnreadInbox({ siteId });
      },
      async suspectedSpam({ actor }) {
        await authorize(actor, "forms.review");
        return store.listSuspectedSpam({ siteId });
      },
      async failedDeliveries({ actor }) {
        await authorize(actor, "forms.delivery.manage");
        return store.listFailed({ siteId });
      },
      async submission({ actor, receiptId }) {
        const membership = await authorize(actor, "forms.review");
        const submission = await store.viewSubmission({
          siteId,
          receiptId,
          actorMembershipId: membership.id,
          now: clock().toISOString(),
        });
        if (submission === null) {
          throw new Error("form_submission_not_found");
        }
        return submission;
      },
    });
  const commands: PublicFormOperationsApplication["commands"] = Object.freeze({
      async replayFailed({ actor, deliveryId }) {
        const membership = await authorize(actor, "forms.delivery.manage");
        if (
          !(await store.replayFailed({
            siteId,
            deliveryId,
            actorMembershipId: membership.id,
            now: clock().toISOString(),
          }))
        ) {
          throw new Error("form_delivery_not_replayable");
        }
      },
      async releaseSuspectedSpam({ actor, receiptId }) {
        const membership = await authorize(actor, "forms.data.manage");
        if (
          !(await store.releaseSuspectedSpam({
            siteId,
            receiptId,
            actorMembershipId: membership.id,
            now: clock().toISOString(),
          }))
        ) {
          throw new Error("form_submission_not_held");
        }
      },
    });
  return Object.freeze({ queries, commands });
}
