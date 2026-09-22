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
  type AnalyticsTrafficView,
  type ExternalHumanIdentity,
} from "@humber-foundry/application";
import {
  pageDisplayTitle,
  type SiteDefinition,
} from "@humber-foundry/site-definition";

import { installedSiteDefinition } from "../foundry/site-definition";

import {
  reportingPeriodDays,
  type ReportingPeriodDays,
} from "./analytics-reporting-period";
import { sampleAnalyticsDashboard } from "./analytics-sample-data";
import { createD1AnalyticsStore } from "./d1-analytics-store";
import { dashboardTimeZone } from "./dashboard-time";
import { loadHumanAccessEnvironment } from "./human-access-environment";
import type { HumanAccessRequestContext } from "./human-access-runtime";
import { publishedContentRoutes } from "./web-traffic-collector";

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

function localDate(instantMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(instantMs));
}

/** The reporting range that ends today and covers `days` local days. */
export function defaultReportingRange(
  now: string,
  timeZone: string = defaultReportingTimeZone,
  days: ReportingPeriodDays = reportingPeriodDays[0],
): AnalyticsRangeRequest {
  const nowMs = Date.parse(now);
  return {
    fromLocalDate: localDate(nowMs - (days - 1) * 86_400_000, timeZone),
    toLocalDate: localDate(nowMs, timeZone),
  };
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
  /** How many days this reading covers. */
  periodDays: ReportingPeriodDays;
  /**
   * True only for the made-up figures a developer sees on their own machine.
   * The screen says so on every sample number. It is never true in a
   * deployed site.
   */
  sample: boolean;
  overview: AnalyticsOverviewView;
  traffic: AnalyticsTrafficView;
  content: AnalyticsContentView;
  /**
   * The page or blog post title an owner reads for one content subject id.
   * The Content section shows this in place of the internal id. A subject
   * with no known title (a removed page, a tombstoned post) is left out, and
   * the id is shown as a last resort.
   */
  contentTitles: Readonly<Record<string, string>>;
  /** The web address of each content subject, for the top pages list. */
  contentPaths: Readonly<Record<string, string>>;
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

/**
 * The web address of every page and post the site currently has. It is the
 * same map the Worker counts against, read the other way round, so the screen
 * and the counter can never disagree about which address a page has.
 */
function contentPathsFor(
  definition: SiteDefinition,
): Readonly<Record<string, string>> {
  const paths: Record<string, string> = {};
  for (const [path, contentId] of publishedContentRoutes(definition)) {
    paths[contentId] = path;
  }
  return paths;
}

/**
 * Sample figures are for local development only.
 *
 * `next dev` has no D1 binding, so the read model cannot answer and the screen
 * would be empty on a developer's machine. A built site always reports its
 * own measurements or says a source is unavailable; it never shows these.
 */
function localDevelopmentSampleAllowed(): boolean {
  return process.env.NODE_ENV === "development";
}

/** The headline part of the Visitors read model, on its own. */
export type AnalyticsOverviewSummary = Readonly<{
  periodDays: ReportingPeriodDays;
  /** True only for the made-up figures a developer sees on their own machine. */
  sample: boolean;
  overview: AnalyticsOverviewView;
}>;

/**
 * The headline readings only, for Overview's key numbers.
 *
 * Overview shows one figure, so it reads one view. `loadAnalyticsDashboard`
 * below runs seven queries because the Visitors screen draws all seven; doing
 * that work for a single number would slow every Overview load.
 *
 * `null` means the read model could not answer. The caller then says so and
 * shows no figure, the same rule the Visitors screen follows.
 */
export async function loadAnalyticsOverview(
  humanContext: HumanAccessRequestContext,
  {
    now = () => new Date().toISOString(),
    createContext = createAnalyticsDashboardContext,
    periodDays = reportingPeriodDays[0],
  }: {
    now?: () => string;
    createContext?: typeof createAnalyticsDashboardContext;
    periodDays?: ReportingPeriodDays;
  } = {},
): Promise<AnalyticsOverviewSummary | null> {
  if (humanContext.state !== "authorized") return null;
  const actor = humanContext.identity;
  const observedNow = now();
  const range = defaultReportingRange(
    observedNow,
    defaultReportingTimeZone,
    periodDays,
  );
  try {
    const application = await createContext(humanContext, now);
    const overview = await application.queries.overview({
      actor,
      range,
      comparison: "previous_period",
    });
    return { periodDays, sample: false, overview };
  } catch (error) {
    if (isContractFailure(error)) throw error;
    if (localDevelopmentSampleAllowed()) {
      const sample = sampleAnalyticsDashboard({
        now: observedNow,
        periodDays,
        timeZone: defaultReportingTimeZone,
        siteId: installedSiteDefinition.site.id,
        contentTitles: contentTitlesFor(installedSiteDefinition),
        contentPaths: contentPathsFor(installedSiteDefinition),
      });
      return { periodDays, sample: true, overview: sample.overview };
    }
    console.error("analytics_overview_unavailable", {
      failure: error instanceof Error ? error.name : "unknown",
    });
    return null;
  }
}

export async function loadAnalyticsDashboard(
  humanContext: HumanAccessRequestContext,
  {
    now = () => new Date().toISOString(),
    createContext = createAnalyticsDashboardContext,
    periodDays = reportingPeriodDays[0],
  }: {
    now?: () => string;
    createContext?: typeof createAnalyticsDashboardContext;
    periodDays?: ReportingPeriodDays;
  } = {},
): Promise<AnalyticsDashboardData | null> {
  if (humanContext.state !== "authorized") return null;
  const actor = humanContext.identity;
  const observedNow = now();
  const range = defaultReportingRange(
    observedNow,
    defaultReportingTimeZone,
    periodDays,
  );
  try {
    const application = await createContext(humanContext, now);
    const [overview, traffic, content, forms, audience, campaigns, health] =
      await Promise.all([
        application.queries.overview({
          actor,
          range,
          comparison: "previous_period",
        }),
        application.queries.traffic({ actor, range }),
        application.queries.content({ actor, range, limit: 10 }),
        application.queries.forms({ actor, range }),
        application.queries.audience({ actor, range }),
        application.queries.campaigns({ actor, range, limit: 10 }),
        application.queries.health({ actor, range }),
      ]);
    return {
      periodDays,
      sample: false,
      overview,
      traffic,
      content,
      contentTitles: contentTitlesFor(installedSiteDefinition),
      contentPaths: contentPathsFor(installedSiteDefinition),
      forms,
      audience,
      campaigns,
      health,
    };
  } catch (error) {
    if (isContractFailure(error)) throw error;
    if (localDevelopmentSampleAllowed()) {
      return sampleAnalyticsDashboard({
        now: observedNow,
        periodDays,
        timeZone: defaultReportingTimeZone,
        siteId: installedSiteDefinition.site.id,
        contentTitles: contentTitlesFor(installedSiteDefinition),
        contentPaths: contentPathsFor(installedSiteDefinition),
      });
    }
    // A site that has no analytics tables yet still renders the rest of the
    // dashboard. Its analytics section states that the numbers cannot be
    // read, and shows no numbers.
    console.error("analytics_dashboard_unavailable", {
      failure: error instanceof Error ? error.name : "unknown",
    });
    return null;
  }
}
