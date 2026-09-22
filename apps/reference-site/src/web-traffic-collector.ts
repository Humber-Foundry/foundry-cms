import { pagePath } from "@humber-foundry/site-definition";

import { installedSiteDefinition } from "../foundry/site-definition";

import { normalizeReferrer, referrerHostOf } from "./analytics-referrer";
import {
  webTrafficEventKind,
  type AnalyticsEngineDataset,
} from "./analytics-engine-source";

/**
 * Counts public page views in the Worker request path.
 *
 * The site counts its own traffic. There is no browser beacon, no cookie and
 * no stored identifier, so nothing here can describe a person. Four things
 * are recorded for one page view: that it was a page view, which published
 * page it was, where the reader came from as a bare host or a channel word,
 * and whether the request was an arrival rather than a move inside the site.
 *
 * The address itself, its query string, the reader's address, the browser
 * name and every request header apart from the referring host are dropped
 * here and never leave this module. See ADR-0047.
 *
 * `custom-worker.ts` imports this module, so it must not import
 * `server-only`.
 */

/**
 * One page view, as the four labels and one marker the dataset holds. The
 * referrer is two flat fields because they are two separate dataset columns,
 * which is also how the rollup reads them back.
 */
export type WebTrafficPoint = Readonly<{
  /** The published page or post id, or `""` for a path the site does not own. */
  contentId: string;
  /** `referrer_host`, `referrer_channel`, or `""` for a move inside the site. */
  referrerKey: string;
  referrerValue: string;
  /** True when the reader arrived from somewhere other than this site. */
  arrival: boolean;
}>;

/** Paths the public site never serves as a readable page. */
const privatePathPrefixes: ReadonlyArray<string> = Object.freeze([
  "/dash",
  "/api/",
  "/_next/",
  "/mcp",
]);

export function isPublicPagePath(path: string): boolean {
  if (!path.startsWith("/")) return false;
  if (privatePathPrefixes.some((prefix) => path.startsWith(prefix))) {
    return false;
  }
  // Foundry's own internal routes all start a segment with an underscore.
  return !path.split("/").some((segment) => segment.startsWith("_"));
}

/** One published web address per page and post, keyed by the address. */
export function publishedContentRoutes(
  definition = installedSiteDefinition,
): ReadonlyMap<string, string> {
  const routes = new Map<string, string>();
  for (const page of definition.pages) {
    routes.set(pagePath(page), page.id);
  }
  for (const post of definition.blog.posts) {
    routes.set(`/blog/${post.slug}`, post.id);
  }
  return routes;
}

/**
 * The address as the site publishes it: readable, and with no trailing slash
 * unless it is the home page. A badly encoded address gives `null`, and is
 * not counted.
 */
function readablePath(pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.length > 1 && decoded.endsWith("/")) return decoded.slice(0, -1);
  return decoded;
}

/**
 * Decides whether one served request is a public page view, and reduces it to
 * the four aggregate fields. It returns `null` for everything else: a
 * dashboard page, an API call, an asset, a redirect, an error page and any
 * method other than GET.
 */
export function webTrafficPointFor({
  request,
  response,
  routes,
}: {
  request: Request;
  response: Response;
  routes: ReadonlyMap<string, string>;
}): WebTrafficPoint | null {
  if (request.method !== "GET") return null;
  if (response.status !== 200) return null;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("text/html")) return null;

  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return null;
  }
  const path = readablePath(url.pathname);
  if (path === null || !isPublicPagePath(path)) return null;

  // A reader who moved inside the site is not an arrival. Two signals say so,
  // and either one is enough: the referring host is this host, or the browser
  // says the request came from this same site. Neither names a person.
  const referrerHost = referrerHostOf(request.headers.get("referer"));
  const sameSite =
    referrerHost === url.hostname ||
    request.headers.get("sec-fetch-site") === "same-origin";
  const referrer = sameSite
    ? { key: "", value: "" }
    : normalizeReferrer(referrerHost);

  return {
    contentId: routes.get(path) ?? "",
    referrerKey: referrer.key,
    referrerValue: referrer.value,
    arrival: !sameSite,
  };
}

export function writeWebTrafficPoint(
  dataset: AnalyticsEngineDataset,
  point: WebTrafficPoint,
): void {
  dataset.writeDataPoint({
    blobs: [
      webTrafficEventKind,
      point.contentId,
      point.referrerKey,
      point.referrerValue,
    ],
    doubles: [1, point.arrival ? 1 : 0],
  });
}

export type WebTrafficEnvironment = Readonly<{
  FOUNDRY_INTERACTIONS?: AnalyticsEngineDataset;
}>;

/**
 * Wraps the Worker's request handler so every public page it serves is
 * counted. The answer is returned exactly as the handler made it, and the
 * count is taken from the finished response.
 */
export function withWebTrafficCounting<
  Environment extends WebTrafficEnvironment,
  Context,
>(
  next: (
    request: Request,
    environment: Environment,
    context: Context,
  ) => Promise<Response>,
  routes: ReadonlyMap<string, string> = publishedContentRoutes(),
) {
  return async (
    request: Request,
    environment: Environment,
    context: Context,
  ): Promise<Response> => {
    const response = await next(request, environment, context);
    recordWebTraffic({
      request,
      response,
      dataset: environment.FOUNDRY_INTERACTIONS,
      routes,
    });
    return response;
  };
}

/**
 * Counts one served request, and never changes it. Collection is best effort:
 * a dropped point leaves a count low, and nothing else in the request depends
 * on it, so every failure here is swallowed.
 */
export function recordWebTraffic({
  request,
  response,
  dataset,
  routes,
}: {
  request: Request;
  response: Response;
  dataset: AnalyticsEngineDataset | undefined;
  routes: ReadonlyMap<string, string>;
}): void {
  if (dataset === undefined) return;
  try {
    const point = webTrafficPointFor({ request, response, routes });
    if (point === null) return;
    writeWebTrafficPoint(dataset, point);
  } catch {
    // Best effort by design.
  }
}
