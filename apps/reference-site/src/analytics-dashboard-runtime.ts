import "server-only";

import {
  createAnalyticsQueryApplication,
  createAnalyticsQueryCache,
  type AnalyticsQueryCache,
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

export type AnalyticsDashboardErrorCode =
  | "analytics_not_authorized"
  | "analytics_not_configured";

export class AnalyticsDashboardError extends Error {
  readonly code: AnalyticsDashboardErrorCode;

  constructor(code: AnalyticsDashboardErrorCode) {
    super(`The analytics dashboard was refused: ${code}.`);
    this.name = "AnalyticsDashboardError";
    this.code = code;
  }
}

/**
 * Our own contract failures are bugs and must reach the error boundary. Only a
 * site that has no analytics tables yet gets the empty panel; a privacy or
 * vocabulary breach rendering as "no data" would hide the thing the guard
 * exists to catch.
 */
const contractErrorNames: ReadonlySet<string> = new Set([
  "AnalyticsPrivacyViolationError",
  "AnalyticsVocabularyError",
  "AnalyticsComparabilityError",
  "AnalyticsProjectionError",
]);

function isContractFailure(error: unknown): boolean {
  return error instanceof Error && contractErrorNames.has(error.name);
}

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

/**
 * The query cache lives here rather than inside the application, because
 * `/dash` is dynamic and builds a fresh application on every request. A cache
 * owned by the application would be thrown away before it was read. This one
 * belongs to the Worker isolate, so an answer survives between requests for
 * as long as ADR-0003 allows.
 */
const queryCachesBySite = new Map<string, AnalyticsQueryCache>();

function queryCacheFor(siteId: string): AnalyticsQueryCache {
  const existing = queryCachesBySite.get(siteId);
  if (existing !== undefined) return existing;
  const created = createAnalyticsQueryCache();
  queryCachesBySite.set(siteId, created);
  return created;
}

export async function createAnalyticsDashboardContext(
  humanContext: HumanAccessRequestContext,
  now: () => string = () => new Date().toISOString(),
) {
  if (humanContext.state !== "authorized") {
    throw new AnalyticsDashboardError("analytics_not_authorized");
  }
  const environment = await loadHumanAccessEnvironment();
  const database = environment.FOUNDRY_DB;
  if (database === undefined) {
    throw new AnalyticsDashboardError("analytics_not_configured");
  }
  const siteId = referenceSiteDefinition.site.id;
  return createAnalyticsQueryApplication<ExternalHumanIdentity>({
    siteId,
    store: createD1AnalyticsStore(database, siteId),
    reportingTimeZone: defaultReportingTimeZone,
    now,
    cache: queryCacheFor(siteId),
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
  createContext = createAnalyticsDashboardContext,
): Promise<AnalyticsDashboardData | null> {
  if (humanContext.state !== "authorized") return null;
  const actor = humanContext.identity;
  const range = defaultReportingRange(now());
  try {
    const application = await createContext(humanContext, now);
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
  } catch (error) {
    if (isContractFailure(error)) throw error;
    // A site without the analytics tables yet renders the rest of the
    // dashboard; the analytics section says the read model is unavailable
    // rather than showing zeros.
    console.error("analytics_dashboard_unavailable", {
      failure: error instanceof Error ? error.name : "unknown",
    });
    return null;
  }
}
