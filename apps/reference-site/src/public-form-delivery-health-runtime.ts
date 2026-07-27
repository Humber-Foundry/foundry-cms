import "server-only";

import {
  createPublicFormOperationsApplication,
  type PublicFormDeliveryHealth,
  type PublicFormNotificationAdapter,
} from "@foundry/application";
import { referenceSiteDefinition } from "@foundry/site-definition";

import { createD1PublicFormNotificationStore } from "./d1-public-form-notification-store";
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

function configurationHealth(environment: Record<string, unknown>) {
  return [
    "FOUNDRY_FORM_EMAIL",
    "FOUNDRY_FORM_EMAIL_FROM",
    "FOUNDRY_FORM_EMAIL_RECIPIENT",
    "FOUNDRY_CANONICAL_ORIGIN",
  ].every((key) => environment[key] !== undefined);
}

export async function loadPublicFormDeliveryHealth(
  humanContext: HumanAccessRequestContext,
) {
  if (humanContext.state !== "authorized") {
    throw new Error("form_delivery_not_authorized");
  }
  if (process.env.NODE_ENV === "development") {
    return localHealth;
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
    siteId: referenceSiteDefinition.site.id,
    store: createD1PublicFormNotificationStore(
      database as Parameters<
        typeof createD1PublicFormNotificationStore
      >[0],
    ),
    adapter,
    authorize: (actor, capability) =>
      humanContext.application.queries.requireCapability({
        actor,
        capability,
      }),
  });
  return application.queries.health({ actor: humanContext.identity });
}
