import "server-only";

import {
  createPublicFormId,
  createPublicFormInboxPlan,
  createPublicFormReceiptId,
  createPublicFormOperationsApplication,
  type PublicFormDeliveryHealth,
  type PublicFormInboxPage,
  type PublicFormNotificationAdapter,
} from "@humber-foundry/application";

import { installedPublicForms } from "../foundry/public-forms";
import { installedSiteDefinition } from "../foundry/site-definition";

import { createD1PublicFormNotificationStore } from "./d1-public-form-notification-store";
import {
  isCloudflareFormEmailConfigurationValid,
  type CloudflareFormEmailEnvironment,
} from "./cloudflare-form-email-adapter";
import { loadHumanAccessEnvironment } from "./human-access-environment";
import type { HumanAccessRequestContext } from "./human-access-runtime";

const localHealth: PublicFormDeliveryHealth = {
  pending: 0,
  processing: 0,
  failed: 0,
  retries: 0,
  oldestPendingAgeSeconds: null,
  adapter: "healthy",
  capacity: { usedPercent: 0, state: "normal" },
};

const emptyInbox: PublicFormInboxPage = {
  messages: [],
  olderCursor: null,
  unreadCount: 0,
};

export const installedPublicFormInboxPlan = createPublicFormInboxPlan(
  installedPublicForms.map((form) => ({
    id: createPublicFormId(form.id),
    fields: form.fields,
  })),
);

function configurationHealth(environment: Record<string, unknown>) {
  return isCloudflareFormEmailConfigurationValid(
    environment as CloudflareFormEmailEnvironment,
  );
}

/**
 * `next dev` runs without the deployed bindings, so the dashboard cannot read
 * real submissions there. It shows an empty inbox rather than an error.
 */
function isLocalDevelopment() {
  return process.env.NODE_ENV === "development";
}

export async function createPublicFormOperationsContext(
  humanContext: HumanAccessRequestContext,
) {
  if (humanContext.state !== "authorized") {
    throw new Error("form_delivery_not_authorized");
  }
  const environment = (await loadHumanAccessEnvironment()) as Record<
    string,
    unknown
  >;
  const database = environment.FOUNDRY_DB;
  if (database === undefined) {
    throw new Error("form_notification_not_configured");
  }
  const adapter: PublicFormNotificationAdapter = {
    async notify() {
      throw new Error("dashboard_cannot_deliver_form_notifications");
    },
    async health() {
      return configurationHealth(environment) ? "healthy" : "unavailable";
    },
  };
  const application = createPublicFormOperationsApplication({
    siteId: installedSiteDefinition.site.id,
    store: createD1PublicFormNotificationStore(
      database as Parameters<typeof createD1PublicFormNotificationStore>[0],
      { inboxPlan: installedPublicFormInboxPlan },
    ),
    adapter,
    authorize: (actor, capability) =>
      humanContext.application.queries.requireCapability({
        actor,
        capability,
      }),
  });
  return application;
}

/**
 * What Messages shows: the received messages, anything held as spam, and one
 * line about whether the owner's notification emails are getting through.
 */
export async function loadPublicFormInbox(
  humanContext: HumanAccessRequestContext,
  olderThanReceiptId: string | null = null,
) {
  if (humanContext.state !== "authorized") {
    throw new Error("form_delivery_not_authorized");
  }
  if (isLocalDevelopment()) {
    return {
      inbox: emptyInbox,
      suspectedSpam: [],
      notificationHealth: localHealth,
    };
  }
  const application = await createPublicFormOperationsContext(humanContext);
  const [inbox, suspectedSpam, notificationHealth] = await Promise.all([
    application.queries.inbox({
      actor: humanContext.identity,
      olderThanReceiptId:
        olderThanReceiptId === null
          ? null
          : createPublicFormReceiptId(olderThanReceiptId),
    }),
    application.queries.suspectedSpam({ actor: humanContext.identity }),
    application.queries.health({ actor: humanContext.identity }),
  ]);
  return { inbox, suspectedSpam, notificationHealth };
}

/**
 * Settings shows the owner-notification detail: the email queue and any
 * notification that never reached the owner. The messages themselves are kept
 * whatever this says.
 */
export async function loadOwnerNotificationStatus(
  humanContext: HumanAccessRequestContext,
) {
  if (humanContext.state !== "authorized") {
    throw new Error("form_delivery_not_authorized");
  }
  if (isLocalDevelopment()) {
    return { health: localHealth, failedDeliveries: [] };
  }
  const application = await createPublicFormOperationsContext(humanContext);
  const [health, failedDeliveries] = await Promise.all([
    application.queries.health({ actor: humanContext.identity }),
    humanContext.membership.role === "owner"
      ? application.queries.failedDeliveries({ actor: humanContext.identity })
      : Promise.resolve([]),
  ]);
  return { health, failedDeliveries };
}

/**
 * The counts Overview needs to say what is waiting, without loading any
 * message content.
 */
export async function loadMessagesAttention(
  humanContext: HumanAccessRequestContext,
) {
  if (humanContext.state !== "authorized") {
    throw new Error("form_delivery_not_authorized");
  }
  if (isLocalDevelopment()) {
    return { unreadCount: 0, heldForReview: 0, undeliveredNotifications: 0 };
  }
  const application = await createPublicFormOperationsContext(humanContext);
  const [inbox, suspectedSpam, failedDeliveries] = await Promise.all([
    application.queries.inbox({
      actor: humanContext.identity,
      olderThanReceiptId: null,
    }),
    application.queries.suspectedSpam({ actor: humanContext.identity }),
    humanContext.membership.role === "owner"
      ? application.queries.failedDeliveries({ actor: humanContext.identity })
      : Promise.resolve([]),
  ]);
  return {
    unreadCount: inbox.unreadCount,
    heldForReview: suspectedSpam.length,
    undeliveredNotifications: failedDeliveries.length,
  };
}
