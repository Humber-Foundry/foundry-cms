// @ts-expect-error The OpenNext worker is generated before Wrangler bundles this entry.
import openNextWorker from "./.open-next/worker.js";

import { reconcileHumanAccessEligibility } from "@foundry/application";
import { referenceSiteDefinition } from "@foundry/site-definition";

import {
  createAccessEligibilitySynchronizer,
  HumanAccessConfigurationError,
  type HumanAccessEnvironment,
} from "./src/human-access-configuration";
import {
  createDashboardIdentityBoundary,
} from "./src/dashboard-identity-availability";
import { createD1HumanAccessStore } from "./src/d1-human-access-store";
import {
  deliverPublicFormNotificationsIfDue,
  type PublicFormNotificationEnvironment,
} from "./src/public-form-notification-runtime";

type ExecutionContext = Readonly<{
  waitUntil(promise: Promise<unknown>): void;
}>;

async function reconcileHumanAccessEligibilityIfDue(
  environment: HumanAccessEnvironment,
) {
  if (environment.FOUNDRY_DB === undefined) {
    throw new HumanAccessConfigurationError();
  }
  const store = createD1HumanAccessStore(environment.FOUNDRY_DB);
  const now = new Date().toISOString();
  await reconcileHumanAccessEligibility({
    siteId: referenceSiteDefinition.site.id,
    store,
    eligibilitySynchronizer:
      createAccessEligibilitySynchronizer(environment),
    now,
    mode: "scheduled",
  });
}

async function runScheduledWork(
  environment: HumanAccessEnvironment & PublicFormNotificationEnvironment,
) {
  await Promise.all([
    reconcileHumanAccessEligibilityIfDue(environment),
    deliverPublicFormNotificationsIfDue(environment),
  ]);
}

const fetch = createDashboardIdentityBoundary<
  HumanAccessEnvironment,
  ExecutionContext
>({
  next: (request, environment, context) =>
    openNextWorker.fetch(request, environment, context),
});

export default {
  fetch,
  scheduled(
    _event: unknown,
    environment: HumanAccessEnvironment,
    context: ExecutionContext,
  ) {
    context.waitUntil(runScheduledWork(environment));
  },
};
