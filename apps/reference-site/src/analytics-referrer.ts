/**
 * Reduces a referrer to something an aggregate may hold.
 *
 * Only a bare host, or one of the channel words the read model allows, ever
 * leaves this module. The path, the query string and the fragment of a
 * referring address are dropped here, before any analytics code sees them, so
 * they cannot reach the read model. See ADR-0003 and ADR-0047.
 */

import {
  assertAggregateAnalyticsPayload,
  isAllowedAnalyticsDimension,
} from "@humber-foundry/application";

export type ReferrerDimension = Readonly<{ key: string; value: string }>;

const referrerChannels: ReadonlyArray<
  Readonly<{ channel: string; hosts: ReadonlyArray<string> }>
> = Object.freeze([
  {
    channel: "search",
    hosts: ["google.", "bing.", "duckduckgo.", "search.", "ecosia."],
  },
  {
    channel: "social",
    hosts: [
      "facebook.",
      "instagram.",
      "linkedin.",
      "mastodon.",
      "reddit.",
      "bsky.",
      "x.com",
      "t.co",
    ],
  },
]);

/**
 * Reduces a referrer to a bare host, or to a channel when there is none.
 *
 * The host is checked against the read model's own rules before it is
 * returned. A host those rules refuse — a machine name with no dot, a network
 * address, a name with an underscore — becomes the plain channel `referral`.
 * Returning it unchanged would make the projector refuse the whole run, and
 * one odd referring link would then cost a week of counting.
 */
export function normalizeReferrer(refererHost: string): ReferrerDimension {
  const host = refererHost.trim().toLowerCase();
  if (host === "" || host === "(none)" || host === "direct") {
    return { key: "referrer_channel", value: "direct" };
  }
  const channel = referrerChannels.find((entry) =>
    entry.hosts.some((candidate) => host.startsWith(candidate)),
  );
  if (channel !== undefined) {
    return { key: "referrer_channel", value: channel.channel };
  }
  const dimension = { key: "referrer_host", value: host };
  return readModelAccepts(dimension)
    ? dimension
    : { key: "referrer_channel", value: "referral" };
}

/**
 * Both rules the read model applies to a referrer: the shape rule for a
 * dimension, and the privacy rule that refuses anything that could name a
 * person or a machine, such as a network address.
 */
function readModelAccepts(dimension: ReferrerDimension): boolean {
  if (!isAllowedAnalyticsDimension(dimension)) return false;
  try {
    assertAggregateAnalyticsPayload(dimension);
    return true;
  } catch {
    return false;
  }
}

/**
 * The host of a `Referer` header, or `""` when there is none and when the
 * header cannot be read as an address. Nothing but the host is returned.
 */
export function referrerHostOf(refererHeader: string | null): string {
  if (refererHeader === null) return "";
  try {
    return new URL(refererHeader).hostname.toLowerCase();
  } catch {
    return "";
  }
}
