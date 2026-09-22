/**
 * How far back the Visitors screen looks.
 *
 * The screen offers two periods and nothing else, so the chosen period is one
 * of two numbers everywhere: in the address, in the query the screen runs, and
 * on the buttons that switch it. This module has no server-only import, so the
 * rendered screen can read the two options as well.
 */

export const reportingPeriodDays = Object.freeze([7, 30] as const);

export type ReportingPeriodDays = (typeof reportingPeriodDays)[number];

/** Reads the period from the address. Anything else gives the shorter one. */
export function resolveReportingPeriodDays(
  requested: string | number | undefined,
): ReportingPeriodDays {
  const days = Number(requested);
  return reportingPeriodDays.includes(days as ReportingPeriodDays)
    ? (days as ReportingPeriodDays)
    : reportingPeriodDays[0];
}
