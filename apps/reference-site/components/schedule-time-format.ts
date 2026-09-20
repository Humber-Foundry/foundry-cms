/**
 * A local date and time, e.g. "November 1, 2026, 1:30 AM (America/Vancouver)".
 * `localDateTime` is already civil time in `ianaTimeZone` — no further zone
 * conversion is needed, so this formats it as a UTC instant with the same
 * clock digits and labels the zone name alongside it.
 *
 * No "use client" here: the dashboard's server-rendered Overview page and
 * the client-rendered Blog post controls both need this exact formatting,
 * so it lives in a plain module either side can import.
 */
export function formatLocalScheduleTime(
  localDateTime: string,
  ianaTimeZone: string,
): string {
  const [datePart, timePart] = localDateTime.split("T");
  const [year, month, day] = datePart.split("-").map(Number);
  const [hour, minute] = timePart.split(":").map(Number);
  const asIfUtc = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const formatted = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(asIfUtc);
  return `${formatted} (${ianaTimeZone})`;
}
