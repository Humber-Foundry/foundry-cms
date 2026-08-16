import "server-only";

import {
  createPublicFormId,
  createPublicFormInboxPlan,
  createPublicFormOperationsApplication,
  type PublicFormDeliveryHealth,
  type PublicFormInboxPage,
  type PublicFormNotificationAdapter,
  type PublicFormReceiptId,
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
 * What every Messages read does before it reads anything.
 *
 * A caller must be an authorized member. `next dev` then runs without the
 * deployed bindings, so the dashboard has no submissions to read there and
 * shows the empty result the caller supplies rather than an error.
 */
async function readMessages<Local, Result>(
  humanContext: HumanAccessRequestContext,
  local: Local,
  read: (
    application: Awaited<ReturnType<typeof createPublicFormOperationsContext>>,
  ) => Promise<Result>,
): Promise<Local | Result> {
  if (humanContext.state !== "authorized") {
    throw new Error("form_delivery_not_authorized");
  }
  if (process.env.NODE_ENV === "development") {
    return local;
  }
  return read(await createPublicFormOperationsContext(humanContext));
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
  olderThanReceiptId: PublicFormReceiptId | null = null,
) {
  return readMessages(
    humanContext,
    {
      inbox: emptyInbox,
      suspectedSpam: [],
      notificationHealth: localHealth,
    },
    async (application) => {
      const [inbox, suspectedSpam, notificationHealth] = await Promise.all([
        application.queries.inbox({
          actor: humanContext.identity,
          olderThanReceiptId,
        }),
        application.queries.suspectedSpam({ actor: humanContext.identity }),
        application.queries.health({ actor: humanContext.identity }),
      ]);
      return { inbox, suspectedSpam, notificationHealth };
    },
  );
}

/**
 * Settings shows the owner-notification detail: the email queue and any
 * notification that never reached the owner. The messages themselves are kept
 * whatever this says.
 *
 * Only an Owner reaches this. The Settings page sends anyone else away, and
 * `failedDeliveries` requires `forms.delivery.manage`, so this function states
 * the rule nowhere itself.
 */
export async function loadOwnerNotificationStatus(
  humanContext: HumanAccessRequestContext,
) {
  return readMessages(
    humanContext,
    { health: localHealth, failedDeliveries: [] },
    async (application) => {
      const [health, failedDeliveries] = await Promise.all([
        application.queries.health({ actor: humanContext.identity }),
        application.queries.failedDeliveries({ actor: humanContext.identity }),
      ]);
      return { health, failedDeliveries };
    },
  );
}

/**
 * The counts Overview needs to say what is waiting. It reads two numbers and
 * no message content: what nobody has opened, and what is held as spam.
 */
export async function loadMessagesAttention(
  humanContext: HumanAccessRequestContext,
) {
  return readMessages(
    humanContext,
    { unreadCount: 0, heldForReview: 0 },
    async (application) => {
      const [unreadCount, suspectedSpam] = await Promise.all([
        application.queries.unreadCount({ actor: humanContext.identity }),
        application.queries.suspectedSpam({ actor: humanContext.identity }),
      ]);
      return { unreadCount, heldForReview: suspectedSpam.length };
    },
  );
}
