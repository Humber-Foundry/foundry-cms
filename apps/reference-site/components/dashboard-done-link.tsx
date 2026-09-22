/**
 * The end of a screen the owner opens to finish one task.
 *
 * A sub-screen that exists for one job (connect an agent, answer a draft
 * review) ends with this control, so the owner is handed back to the screen
 * they came from once the job is done. It is the same address the screen's
 * `DashboardBackLink` names.
 *
 * It is a link, not a button: a middle click opens the parent screen in a
 * new tab, the same as every other way back.
 */
export function DashboardDoneLink({
  href,
}: {
  /** The address of the screen this returns to. */
  href: string;
}) {
  return (
    <p className="panel-actions">
      <a className="dash-button dash-button-primary" href={href}>
        Done
      </a>
    </p>
  );
}
