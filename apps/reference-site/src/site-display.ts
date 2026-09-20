/**
 * The single letter shown in the dashboard header's round wordmark badge,
 * taken from the site's own name (#213 — it used to always show "F", the
 * framework's own initial, no matter which site was open).
 *
 * Falls back to "F" only when the name is empty or blank. The Site
 * Definition schema already requires a non-blank name whose first and last
 * character are not whitespace, so that fallback is a defensive floor, not
 * the ordinary path.
 */
export function siteInitial(siteName: string): string {
  const first = siteName.trim().charAt(0);
  return first === "" ? "F" : first.toUpperCase();
}
