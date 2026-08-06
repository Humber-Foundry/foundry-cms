import "server-only";

import {
  createAnalyticsQueryApplication,
  type AnalyticsAudienceView,
  type AnalyticsCampaignsView,
  type AnalyticsContentView,
  type AnalyticsFormsView,
  type AnalyticsHealthView,
  type AnalyticsOverviewView,
  type AnalyticsRangeRequest,
  type ExternalHumanIdentity,
} from "@foundry/application";
import { referenceSiteDefinition } from "@foundry/site-definition";

import { createD1AnalyticsStore } from "./d1-analytics-store";
import { loadHumanAccessEnvironment } from "./human-access-environment";
import type { HumanAccessRequestContext } from "./human-access-runtime";

/**
 * `/dash` reads the aggregate projection through the application layer only.
 * No Cloudflare or provider credential reaches a rendered page, and no view
 * queries a source API directly.
 */

export const defaultReportingTimeZone = "America/Vancouver";

export function defaultReportingRange(
  now: string,
  timeZone: string = defaultReportingTimeZone,
): AnalyticsRangeRequest {
  const localToday = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Date.parse(now)));
  const fromLocalDate = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Date.parse(now) - 27 * 86_400_000));
  return { fromLocalDate, toLocalDate: localToday };
}

export async function createAnalyticsDashboardContext(
  humanContext: HumanAccessRequestContext,
  now: () => string = () => new Date().toISOString(),
) {
  if (humanContext.state !== "authorized") {
    throw new Error("analytics_not_authorized");
  }
  const environment = await loadHumanAccessEnvironment();
  const database = environment.FOUNDRY_DB;
  if (database === undefined) {
    throw new Error("analytics_not_configured");
  }
  const siteId = referenceSiteDefinition.site.id;
  return createAnalyticsQueryApplication<ExternalHumanIdentity>({
    siteId,
    store: createD1AnalyticsStore(database, siteId),
    reportingTimeZone: defaultReportingTimeZone,
    now,
    authorize: (actor, capability) =>
      humanContext.application.queries.requireCapability({
        actor,
        capability,
      }),
  });
}

export type AnalyticsDashboardData = Readonly<{
  overview: AnalyticsOverviewView;
  content: AnalyticsContentView;
  forms: AnalyticsFormsView;
  audience: AnalyticsAudienceView;
  campaigns: AnalyticsCampaignsView;
  health: AnalyticsHealthView;
}>;

export async function loadAnalyticsDashboard(
  humanContext: HumanAccessRequestContext,
  now: () => string = () => new Date().toISOString(),
): Promise<AnalyticsDashboardData | null> {
  if (humanContext.state !== "authorized") return null;
  let application;
  try {
    application = await createAnalyticsDashboardContext(humanContext, now);
  } catch {
    // A site without the analytics tables yet renders the rest of the
    // dashboard; the analytics section says the read model is unavailable
    // rather than showing zeros.
    return null;
  }
  const actor = humanContext.identity;
  const range = defaultReportingRange(now());
  try {
    const [overview, content, forms, audience, campaigns, health] =
      await Promise.all([
        application.queries.overview({ actor, range }),
        application.queries.content({ actor, range, limit: 10 }),
        application.queries.forms({ actor, range }),
        application.queries.audience({ actor, range }),
        application.queries.campaigns({ actor, range, limit: 10 }),
        application.queries.health({ actor, range }),
      ]);
    return { overview, content, forms, audience, campaigns, health };
  } catch {
    return null;
  }
}
