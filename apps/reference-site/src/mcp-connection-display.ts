import { mcpSupportedScopes } from "@humber-foundry/application";

type SupportedMcpScope = (typeof mcpSupportedScopes)[number];

/**
 * The plain phrase an owner reads for each permission scope an MCP
 * connection may hold. Typed against `mcpSupportedScopes` in
 * `@humber-foundry/application`, so a scope added there without a phrase
 * here fails the typecheck instead of silently falling back at runtime.
 */
const mcpScopePhrases: Readonly<Record<SupportedMcpScope, string>> = {
  "site.read": "Read the site",
  "content.draft": "Draft page and post content",
  "design.draft": "Draft the site design",
  "publication.schedule": "Schedule publishing",
  "publication.publish": "Publish",
  "campaign.draft": "Draft newsletter campaigns",
  "campaign.test": "Send newsletter test emails",
  "analytics.read": "Read analytics",
};

const mcpScopePhrasesByRawScope: Readonly<Record<string, string | undefined>> =
  mcpScopePhrases;

export type McpScopeDisplay = Readonly<{
  scope: string;
  /** The plain phrase for a known scope, or the raw scope for an unknown one. */
  phrase: string;
  /** False when the scope was not recognized and `phrase` is the raw string. */
  known: boolean;
}>;

/**
 * Turns one permission scope into a plain phrase. A scope this installation
 * does not recognize — for example one granted by a newer server version —
 * is not hidden or replaced with a generic word: it is shown as its own raw
 * string, with `known: false` so the caller can add help text next to it.
 */
export function mcpScopeDisplay(scope: string): McpScopeDisplay {
  const phrase = mcpScopePhrasesByRawScope[scope];
  return phrase === undefined
    ? { scope, phrase: scope, known: false }
    : { scope, phrase, known: true };
}

/**
 * The short name an owner reads for a connected agent, derived from its
 * client URL. Falls back to the raw client identifier when it is not a
 * parseable URL, so a malformed value is still shown rather than hidden.
 */
export function mcpConnectionDisplayName(clientId: string): string {
  try {
    return new URL(clientId).hostname || clientId;
  } catch {
    return clientId;
  }
}

const relativeTimeUnits: ReadonlyArray<
  readonly [Intl.RelativeTimeFormatUnit, number]
> = [
  ["year", 31_536_000],
  ["month", 2_592_000],
  ["week", 604_800],
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
];

/**
 * Turns an ISO timestamp into a relative phrase such as "3 days ago" or
 * "in 2 hours", read against `referenceTime` (defaults to now). Anything
 * under a minute either way reads as "just now".
 */
export function mcpRelativeTime(
  iso: string,
  referenceTime: Date = new Date(),
): string {
  const diffSeconds = Math.round(
    (new Date(iso).getTime() - referenceTime.getTime()) / 1_000,
  );
  if (Math.abs(diffSeconds) < 60) return "just now";
  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [unit, secondsInUnit] of relativeTimeUnits) {
    if (Math.abs(diffSeconds) >= secondsInUnit) {
      return formatter.format(Math.round(diffSeconds / secondsInUnit), unit);
    }
  }
  return formatter.format(Math.round(diffSeconds / 60), "minute");
}
