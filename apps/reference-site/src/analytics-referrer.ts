/**
 * Reduces a referrer to something an aggregate may hold.
 *
 * Only a bare host, or one of the channel words the read model allows, ever
 * leaves this module. The path, the query string and the fragment of a
 * referring address are dropped here, before any analytics code sees them, so
 * they cannot reach the read model. See ADR-0003 and ADR-0047.
 */

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

/** Reduces a referrer to a bare host, or to a channel when there is none. */
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
  return { key: "referrer_host", value: host };
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
