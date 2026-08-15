/**
 * One reporting time zone for the whole dashboard. Analytics ranges and the
 * times shown next to a message use it, so two parts of the CMS never label
 * the same instant with two different days.
 *
 * This module is browser-safe: it holds no binding, secret or adapter.
 */
export const dashboardTimeZone = "America/Vancouver";

const momentFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: dashboardTimeZone,
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

/**
 * A stored instant, written the way a person reads it. An unparseable value
 * is returned unchanged rather than shown as "Invalid Date".
 */
export function formatDashboardMoment(value: string): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return value;
  }
  // Intl separates the time from "am" or "pm" with a narrow no-break
  // space. Plain spaces are what the rest of the dashboard copy uses.
  return momentFormat.format(new Date(parsed)).replace(/\u202f/gu, " ");
}
