// @ts-expect-error The OpenNext worker is generated before Wrangler bundles this entry.
import openNextWorker from "./.open-next/worker.js";

import {
  reconcileHumanAccessEligibility,
  stableRejectionReason,
} from "@humber-foundry/application";

import { installedSiteDefinition } from "./foundry/site-definition";

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
  deliverNewsletterConfirmationsIfDue,
  type NewsletterConfirmationEnvironment,
} from "./src/newsletter-confirmation-runtime";
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
import {
  runScheduledCampaignBulkDeliveries,
} from "./src/campaign-bulk-scheduler-runtime";
import {
  runScheduledAnalyticsProjection,
  type AnalyticsProjectionEnvironment,
} from "./src/analytics-projection-runtime";
import {
  withWebTrafficCounting,
  type WebTrafficEnvironment,
} from "./src/web-traffic-collector";

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
    siteId: installedSiteDefinition.site.id,
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
    PublicFormPrivacyEnvironment &
    NewsletterConfirmationEnvironment &
    AnalyticsProjectionEnvironment,
) {
  await Promise.all([
    deliverNewsletterConfirmationsIfDue(environment).catch(() => {
      // Never log the request or the address. A failed run leaves the pending
      // requests in place, and the next run picks them up.
      console.error("scheduled_newsletter_confirmation_failed");
    }),
    reconcileHumanAccessEligibilityIfDue(environment),
    runScheduledBlogPostPublications(environment).catch(() => {
      console.error("scheduled_blog_publication_failed");
    }),
    runScheduledCampaignBulkDeliveries(environment).catch((error: unknown) => {
      // The reason is logged, not swallowed. A worker that stops because the
      // installation has not set its sender details is not a fault to chase;
      // an operator needs to read which of the two it was. Only the stable
      // reason code is logged, and it never carries a setting value.
      console.error(
        "scheduled_campaign_delivery_failed",
        JSON.stringify({
          reason: stableRejectionReason(
            error,
            "scheduled_campaign_delivery_failed",
          ),
        }),
      );
    }),
    runScheduledAnalyticsProjection(environment).catch(() => {
      // Analytics is never authoritative for an operation, so a failed
      // projection degrades reporting and nothing else.
      console.error("scheduled_analytics_projection_failed");
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

/**
 * Serves the page, then counts it. A public page view is one anonymous point:
 * the page, the referring host and an arrival marker. No cookie is set, no
 * address is read, and the answer is never changed. See ADR-0047.
 */
const publicFetch = withWebTrafficCounting<
  McpProductionEnvironment & WebTrafficEnvironment,
  ExecutionContext
>((request, environment, context) =>
  dashboardFetch(request, environment, context),
);

async function fetch(
  request: Request,
  environment: McpProductionEnvironment & WebTrafficEnvironment,
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
  return publicFetch(request, environment, context);
}

export default {
  fetch,
  scheduled(
    _event: unknown,
    environment: HumanAccessEnvironment &
      PublicFormNotificationEnvironment &
      PublicFormPrivacyEnvironment &
      NewsletterConfirmationEnvironment &
      AnalyticsProjectionEnvironment,
    context: ExecutionContext,
  ) {
    context.waitUntil(runScheduledWork(environment));
  },
};
