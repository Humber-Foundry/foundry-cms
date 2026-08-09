import {
  deliverDuePublicFormNotifications,
} from "@humber-foundry/application";
import { referenceSiteDefinition } from "@humber-foundry/site-definition";

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
  const previewFieldIds = (
    environment.FOUNDRY_FORM_EMAIL_PREVIEW_FIELDS ?? ""
  )
    .split(",")
    .map((field) => field.trim())
    .filter((field) => /^[a-z][a-z0-9_]*$/u.test(field));
  return deliverDuePublicFormNotifications({
    siteId: referenceSiteDefinition.site.id,
    store: createD1PublicFormNotificationStore(
      environment.FOUNDRY_DB,
      undefined,
      previewFieldIds,
    ),
    adapter: createCloudflareFormEmailAdapter(environment),
    now: new Date(),
    createLeaseToken: () => crypto.randomUUID(),
  });
}
