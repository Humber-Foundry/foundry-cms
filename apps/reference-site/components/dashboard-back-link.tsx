/**
 * The way back from a sub-screen to the screen that opened it.
 *
 * A sub-screen is a screen the owner reaches from another screen rather than
 * from the sidebar. Every sub-screen puts this above its page heading, so
 * the owner is never stranded.
 *
 * Name the screen it returns to. "Back to Settings" tells the owner where
 * they land; "Back" does not.
 */
export function DashboardBackLink({
  href,
  label,
}: {
  /** The address of the screen this returns to. */
  href: string;
  /** Where it goes, named. For example "Back to Settings". */
  label: string;
}) {
  return (
    <a className="dash-back-link" href={href}>
      <span className="dash-back-link-arrow" aria-hidden="true">
        ←
      </span>
      {label}
    </a>
  );
}
