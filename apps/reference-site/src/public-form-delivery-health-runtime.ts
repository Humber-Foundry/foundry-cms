import "server-only";

import {
  createPublicFormOperationsApplication,
  type PublicFormDeliveryHealth,
  type PublicFormNotificationAdapter,
} from "@humber-foundry/application";

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

function configurationHealth(environment: Record<string, unknown>) {
  return isCloudflareFormEmailConfigurationValid(
    environment as CloudflareFormEmailEnvironment,
  );
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
  return application;
}

export async function loadPublicFormOperationsDashboard(
  humanContext: HumanAccessRequestContext,
) {
  if (humanContext.state !== "authorized") {
    throw new Error("form_delivery_not_authorized");
  }
  if (process.env.NODE_ENV === "development") {
    return {
      health: localHealth,
      failedDeliveries: [],
      suspectedSpam: [],
    };
  }
  const application = await createPublicFormOperationsContext(humanContext);
  const [health, suspectedSpam, failedDeliveries] = await Promise.all([
    application.queries.health({ actor: humanContext.identity }),
    application.queries.suspectedSpam({ actor: humanContext.identity }),
    humanContext.membership.role === "owner"
      ? application.queries.failedDeliveries({
          actor: humanContext.identity,
        })
      : Promise.resolve([]),
  ]);
  return { health, failedDeliveries, suspectedSpam };
}
