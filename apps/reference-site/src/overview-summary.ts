import type {
  AnalyticsOverviewView,
  ContentPublicationHistoryEntry,
  ContentPublicationStatus,
} from "@humber-foundry/application";

/**
 * What Overview shows, worked out from data other modules already load.
 *
 * Everything here is a plain function of its arguments. No binding, no
 * database and no `server-only` import, so the rules the owner reads on
 * screen — which number is shown, which sentence replaces a number that
 * cannot be read, what counts as recent activity — are covered by ordinary
 * unit tests.
 *
 * The honesty rule for this whole module: a number that a source cannot
 * supply is never guessed, never replaced by a zero, and never added to
 * another source's number. Overview says which source is missing instead.
 */

/** One of the key numbers at the top of Overview. */
export type OverviewNumber = Readonly<{
  key: string;
  /** What this counts, in the owner's words. */
  label: string;
  /** The screen that holds this number and explains it. */
  href: string;
  /**
   * The figure as the owner reads it, or `null` when there is none to show.
   * A value that is real but too small to report exactly is written in
   * words, such as "fewer than 5".
   */
  value: string | null;
  /**
   * One sentence, shown only when there is no figure. It says which source
   * could not supply it.
   */
  note: string | null;
}>;

function formatCount(value: number): string {
  return value.toLocaleString("en-CA");
}

/**
 * Visits over the reporting period, from the Visitors read model.
 *
 * Two parts of a site can each count visits, and their counts are different
 * measurements of the same thing. They are never added together. When there
 * is more than one, Overview shows no single figure and sends the owner to
 * Visitors, which lists each count with the part that made it.
 */
export function visitsOverviewNumber(
  overview: AnalyticsOverviewView | null,
  periodDays: number,
): OverviewNumber {
  const shared = {
    key: "visits",
    label: `Visits in the last ${periodDays} days`,
    href: `/dash/analytics?days=${periodDays}`,
  };
  if (overview === null) {
    return {
      ...shared,
      value: null,
      note: "Your site's visit counter is not reporting yet, so there is no figure for this period.",
    };
  }
  const series = overview.metrics.filter(
    (reading) => reading.metricKey === "web.visits",
  );
  if (series.length === 0) {
    return {
      ...shared,
      value: null,
      note: "Your site's visit counter has reported nothing for this period.",
    };
  }
  if (series.length > 1) {
    return {
      ...shared,
      value: null,
      note: "More than one part of your site counts visits. The counts are never added together, so Visitors shows each one on its own.",
    };
  }
  const reading = series[0].value;
  if (reading.state === "available") {
    return { ...shared, value: formatCount(reading.value), note: null };
  }
  if (reading.state === "suppressed") {
    // A real answer, written in words because the exact figure is small
    // enough that reporting it could point at one person.
    return { ...shared, value: reading.label, note: null };
  }
  return {
    ...shared,
    value: null,
    note: "Your site's visit counter has not reported for this period.",
  };
}

/**
 * Messages nobody has read yet. `null` means the message store could not be
 * read on this request.
 */
export function messagesOverviewNumber(
  unreadCount: number | null,
): OverviewNumber {
  const shared = {
    key: "messages",
    label: "Messages you have not read",
    href: "/dash/forms",
  };
  if (unreadCount === null) {
    return {
      ...shared,
      value: null,
      note: "Your message store could not be read just now, so there is no figure.",
    };
  }
  return { ...shared, value: formatCount(unreadCount), note: null };
}

/**
 * People who confirmed their place on the newsletter list. An Editor sees
 * this same count on Subscribers; no address is read to work it out.
 */
export function subscribersOverviewNumber(
  confirmedCount: number | null,
): OverviewNumber {
  const shared = {
    key: "subscribers",
    label: "People on your list",
    href: "/dash/subscribers",
  };
  if (confirmedCount === null) {
    return {
      ...shared,
      value: null,
      note: "Your subscriber list could not be read just now, so there is no figure.",
    };
  }
  return { ...shared, value: formatCount(confirmedCount), note: null };
}

/** How many pages the live site serves. */
export function pagesOverviewNumber(publishedPageCount: number): OverviewNumber {
  return {
    key: "pages",
    label: "Pages on your site",
    href: "/dash/pages",
    value: formatCount(publishedPageCount),
    note: null,
  };
}

/** One line of "Recent activity". */
export type OverviewActivityItem = Readonly<{
  key: string;
  /** What happened, in the owner's words. */
  label: string;
  /** When it happened, already written for a reader. */
  time: string;
  href: string;
}>;

/**
 * What a publish attempt means to the owner, in one short line.
 *
 * The long stage-by-stage words stay in `components/publication-history.tsx`,
 * where the owner is watching a publish run. A line in a list of recent
 * activity only has to say whether the site went live.
 */
function publishLabel(status: ContentPublicationStatus): string {
  if (status === "verified-live") return "You published your site";
  if (status === "failed" || status === "blocked") {
    return "A publish stopped before anything went live";
  }
  return "A publish is still running";
}

/** How many lines Recent activity shows. */
export const overviewActivityLimit = 5;

/**
 * The last few things that happened to the site: each publish attempt, and
 * the owner's own last save of the draft.
 *
 * The publishes come from the same records the Published history panel
 * reads. The save is one time for the whole draft, because a save writes
 * every page together.
 */
export function recentSiteActivity({
  publications,
  draftSavedAt,
  draftRevision,
  editorHref,
  formatMoment,
}: {
  publications: ReadonlyArray<ContentPublicationHistoryEntry>;
  /** When the draft was last written, as a stored instant. */
  draftSavedAt: string;
  /** 0 means the draft has never been changed, so there is no save to show. */
  draftRevision: number;
  /** Where a line opens: the page editor, with the draft already selected. */
  editorHref: string;
  formatMoment: (value: string) => string;
}): ReadonlyArray<OverviewActivityItem> {
  const entries: ReadonlyArray<{ at: string; item: OverviewActivityItem }> = [
    ...publications.map((entry) => ({
      at: entry.publication.updatedAt,
      item: {
        key: `publication-${entry.publication.id}`,
        label: publishLabel(entry.publication.status),
        time: formatMoment(entry.publication.updatedAt),
        href: editorHref,
      },
    })),
    ...(draftRevision > 0
      ? [
          {
            at: draftSavedAt,
            item: {
              key: "draft-saved",
              label: "You saved changes to your draft",
              time: formatMoment(draftSavedAt),
              href: editorHref,
            },
          },
        ]
      : []),
  ];
  return entries
    .slice()
    .sort((left, right) => right.at.localeCompare(left.at))
    .slice(0, overviewActivityLimit)
    .map((entry) => entry.item);
}
