import {
  deliverDuePublicFormNotifications,
} from "@foundry/application";
import { referenceSiteDefinition } from "@foundry/site-definition";

import {
  createCloudflareFormEmailAdapter,
  type CloudflareFormEmailEnvironment,
} from "./cloudflare-form-email-adapter";
import { createD1PublicFormNotificationStore } from "./d1-public-form-notification-store";
import type { HumanAccessEnvironment } from "./human-access-configuration";

export type PublicFormNotificationEnvironment =
  HumanAccessEnvironment & CloudflareFormEmailEnvironment;

export async function deliverPublicFormNotificationsIfDue(
  environment: PublicFormNotificationEnvironment,
) {
  if (environment.FOUNDRY_DB === undefined) {
    throw new Error("form_notification_not_configured");
  }
  return deliverDuePublicFormNotifications({
    siteId: referenceSiteDefinition.site.id,
    store: createD1PublicFormNotificationStore(environment.FOUNDRY_DB),
    adapter: createCloudflareFormEmailAdapter(environment),
    now: new Date(),
    createLeaseToken: () => crypto.randomUUID(),
  });
}
