import type { ReactNode } from "react";

import { DashboardEmptyState } from "./dashboard-empty-state";
import { DashboardList, DashboardListRow } from "./dashboard-list";
import { DashboardStateLabel } from "./dashboard-state-label";
import type {
  OverviewActivityItem,
  OverviewNumber,
} from "@/src/overview-summary";

/**
 * The parts Overview is built from.
 *
 * Each one takes what it shows as a prop. Nothing here reads a database, so
 * the words on screen and the shape of each section are covered by ordinary
 * unit tests, and `app/dash/page.tsx` is left with the loading only.
 */

/**
 * The card at the top of Overview: a picture of the home page, the site's
 * name, the address a reader types, whether the draft holds unpublished
 * changes, and the one button that opens the page editor.
 *
 * The address is the link to the live site, so the owner reads their own
 * address rather than a word that repeats the header.
 */
export function SiteCard({
  siteName,
  publicAddress,
  publicHref,
  editHref,
  hasDraftChanges,
  preview,
}: {
  /** The site's name, as the owner wrote it. */
  siteName: string;
  /** The address a reader types, such as `example.com`. */
  publicAddress: string;
  /** Where the address link goes. */
  publicHref: string;
  /** Opens the page editor on the home page, in this person's own draft. */
  editHref: string;
  /** True when the draft holds changes that are not on the live site. */
  hasDraftChanges: boolean;
  /** The picture of the home page. */
  preview: ReactNode;
}) {
  return (
    <section className="dash-site-card" aria-labelledby="site-card-name">
      <div className="dash-site-card-picture">{preview}</div>
      <div className="dash-site-card-detail">
        <h1 id="site-card-name">{siteName}</h1>
        <a className="dash-site-card-address" href={publicHref}>
          {publicAddress}
        </a>
        <p className="dash-site-card-state">
          {hasDraftChanges ? (
            <DashboardStateLabel tone="draft">
              Draft changes waiting to be published
            </DashboardStateLabel>
          ) : (
            <DashboardStateLabel tone="live">
              Your draft matches your live site
            </DashboardStateLabel>
          )}
        </p>
        <p className="dash-site-card-actions">
          <a className="dash-button dash-button-primary" href={editHref}>
            Edit site
          </a>
        </p>
      </div>
    </section>
  );
}

/**
 * The key numbers, each one a link to the screen that explains it.
 *
 * A number a source cannot supply shows one sentence in its place, never a
 * zero. The count is fixed at four, so the row always fills.
 */
export function OverviewNumbers({
  numbers,
  sample,
}: {
  numbers: ReadonlyArray<OverviewNumber>;
  /**
   * True only on a developer's own machine, where the visit figures are
   * made up. The sentence it draws says so.
   */
  sample: boolean;
}) {
  return (
    <section aria-labelledby="key-numbers">
      <h2 id="key-numbers">Key numbers</h2>
      {sample ? (
        <p className="dash-numbers-sample" role="note">
          The visit figures below are made-up samples for local development.
          A published site shows only its own counted numbers.
        </p>
      ) : null}
      <ul className="dash-numbers">
        {numbers.map((number) => (
          <li className="dash-number" key={number.key}>
            <a className="dash-number-link" href={number.href}>
              {number.value === null ? null : (
                <span className="dash-number-value">{number.value}</span>
              )}
              <span className="dash-number-label">{number.label}</span>
              {number.note === null ? null : (
                <span className="dash-number-note">{number.note}</span>
              )}
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The last few things that happened to the site, newest first. Each line
 * opens the page editor, where the full published history is kept.
 */
export function OverviewActivity({
  items,
}: {
  items: ReadonlyArray<OverviewActivityItem>;
}) {
  return (
    <section aria-labelledby="recent-activity">
      <h2 id="recent-activity">Recent activity</h2>
      {items.length === 0 ? (
        <DashboardEmptyState title="Nothing has happened yet">
          Edit your site and publish it. Every publish and every saved draft
          is listed here.
        </DashboardEmptyState>
      ) : (
        <DashboardList label="Recent activity">
          {items.map((item) => (
            <DashboardListRow
              key={item.key}
              href={item.href}
              title={item.label}
              note={item.time}
            />
          ))}
        </DashboardList>
      )}
    </section>
  );
}
