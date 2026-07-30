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
import {
  runPublicFormBackupMaintenanceIfDue,
  runPublicFormRetentionMaintenanceIfDue,
  type PublicFormPrivacyEnvironment,
} from "./src/public-form-privacy-runtime";
import {
  createProductionMcpRuntime,
  isMcpProductionRequest,
  type McpProductionEnvironment,
} from "./src/mcp-production-runtime";
import {
  runScheduledBlogPostPublications,
} from "./src/blog-post-operations-runtime";

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
  environment: HumanAccessEnvironment &
    PublicFormNotificationEnvironment &
    PublicFormPrivacyEnvironment,
) {
  await Promise.all([
    reconcileHumanAccessEligibilityIfDue(environment),
    runScheduledBlogPostPublications(environment).catch(() => {
      console.error("scheduled_blog_publication_failed");
    }),
    (async () => {
      try {
        await runPublicFormRetentionMaintenanceIfDue(environment);
      } catch {
        console.error("public_form_privacy_maintenance_failed");
        return;
      }
      await Promise.all([
        deliverPublicFormNotificationsIfDue(environment),
        runPublicFormBackupMaintenanceIfDue(environment).catch(() => {
          console.error("public_form_backup_maintenance_failed");
        }),
      ]);
    })(),
  ]);
}

const dashboardFetch = createDashboardIdentityBoundary<
  HumanAccessEnvironment,
  ExecutionContext
>({
  next: (request, environment, context) =>
    openNextWorker.fetch(request, environment, context),
});

async function fetch(
  request: Request,
  environment: McpProductionEnvironment,
  context: ExecutionContext,
) {
  if (isMcpProductionRequest(request)) {
    try {
      return await createProductionMcpRuntime(environment, context).fetch(
        request,
      );
    } catch {
      return new Response(
        JSON.stringify({ error: "mcp_service_unavailable" }),
        {
          status: 503,
          headers: {
            "cache-control": "no-store",
            "content-type": "application/json; charset=utf-8",
            "retry-after": "30",
          },
        },
      );
    }
  }
  return dashboardFetch(request, environment, context);
}

export default {
  fetch,
  scheduled(
    _event: unknown,
    environment: HumanAccessEnvironment &
      PublicFormNotificationEnvironment &
      PublicFormPrivacyEnvironment,
    context: ExecutionContext,
  ) {
    context.waitUntil(runScheduledWork(environment));
  },
};
