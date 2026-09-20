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
} from "@humber-foundry/application";
import {
  pageDisplayTitle,
  type SiteDefinition,
} from "@humber-foundry/site-definition";

import { installedSiteDefinition } from "../foundry/site-definition";

import { createD1AnalyticsStore } from "./d1-analytics-store";
import { dashboardTimeZone } from "./dashboard-time";
import { loadHumanAccessEnvironment } from "./human-access-environment";
import type { HumanAccessRequestContext } from "./human-access-runtime";

/**
 * `/dash` reads the aggregate projection through the application layer only.
 * No Cloudflare or provider credential reaches a rendered page, and no view
 * queries a source API directly.
 */

export const defaultReportingTimeZone = dashboardTimeZone;

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
 * These errors mean one of our own guards refused a payload. They must reach
 * the Next.js error boundary. Only a site that has no analytics tables yet
 * gets the empty panel. Rendering a privacy or vocabulary breach as "no data"
 * would hide the breach the guard exists to catch.
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
 * The query cache belongs to this module, and therefore to the Worker isolate.
 *
 * `/dash` is dynamic and builds a fresh query application on every request, so
 * a cache owned by the application would be discarded before it was read.
 * Holding it here keeps an answer for as long as ADR-0003 allows.
 *
 * One cache is enough. This app serves one site definition, and every cache
 * key already includes the site ID.
 */
const queryCache: AnalyticsQueryCache = createAnalyticsQueryCache();

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
  const siteId = installedSiteDefinition.site.id;
  return createAnalyticsQueryApplication<ExternalHumanIdentity>({
    siteId,
    store: createD1AnalyticsStore(database, siteId),
    reportingTimeZone: defaultReportingTimeZone,
    now,
    cache: queryCache,
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
  /**
   * The page or blog post title an owner reads for one content subject id.
   * The Content section shows this in place of the internal id. A subject
   * with no known title (a removed page, a tombstoned post) is left out, and
   * the id is shown as a last resort.
   */
  contentTitles: Readonly<Record<string, string>>;
  forms: AnalyticsFormsView;
  audience: AnalyticsAudienceView;
  campaigns: AnalyticsCampaignsView;
  health: AnalyticsHealthView;
}>;

/** The page and blog post title for every content id the site currently has. */
function contentTitlesFor(
  definition: SiteDefinition,
): Readonly<Record<string, string>> {
  const titles: Record<string, string> = {};
  for (const page of definition.pages) {
    titles[page.id] = pageDisplayTitle(page);
  }
  for (const post of definition.blog.posts) {
    titles[post.id] = post.title;
  }
  return titles;
}

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
    return {
      overview,
      content,
      contentTitles: contentTitlesFor(installedSiteDefinition),
      forms,
      audience,
      campaigns,
      health,
    };
  } catch (error) {
    if (isContractFailure(error)) throw error;
    // A site that has no analytics tables yet still renders the rest of the
    // dashboard. Its analytics section states that the read model is
    // unavailable, and shows no numbers.
    console.error("analytics_dashboard_unavailable", {
      failure: error instanceof Error ? error.name : "unknown",
    });
    return null;
  }
}
