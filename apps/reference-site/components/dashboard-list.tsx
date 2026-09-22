import type { ReactNode } from "react";

/**
 * A list of things the owner can open — pages, posts, messages, campaigns.
 *
 * Rows, not cards in a grid. A site may hold any number of things, and a
 * grid would leave a part-filled last row.
 *
 * Put `DashboardListRow` children inside it and nothing else.
 */
export function DashboardList({
  label,
  children,
}: {
  /** What this list holds, for a screen reader. For example "Your pages". */
  label: string;
  /** One `DashboardListRow` per thing in the list. */
  children: ReactNode;
}) {
  return (
    <ul className="dash-list" aria-label={label}>
      {children}
    </ul>
  );
}

/**
 * One row of a `DashboardList`.
 *
 * The whole row opens the thing it names. The row holds one link, and that
 * link's cover reaches the four edges of the row, so a press anywhere on the
 * row follows it. A control in the `actions` slot sits above that cover, so
 * pressing the control does not follow the link.
 *
 * Two type sizes in a row: the title, and everything that describes it. The
 * supporting line and the state label both read at the small size, and
 * colour carries the rest.
 *
 * Use `state` for a `DashboardStateLabel` and `actions` for a
 * `DashboardActionMenu`. Do not put a row of plain buttons in `actions`; a
 * long row of buttons is what this component replaces.
 *
 * This component and `DashboardList` run on the server as well as in the
 * browser. `DashboardActionMenu` runs in the browser only, so a row with a
 * menu has to be built by a Client Component.
 */
export function DashboardListRow({
  href,
  title,
  note,
  state,
  actions,
}: {
  /** Where the row goes when it is pressed. */
  href: string;
  /** The name of the thing, as the owner named it. */
  title: ReactNode;
  /** One supporting line, such as the page's web address. Optional. */
  note?: ReactNode;
  /** A `DashboardStateLabel`. Leave it out when the row has no state. */
  state?: ReactNode;
  /** A `DashboardActionMenu`. Leave it out when the row has no actions. */
  actions?: ReactNode;
}) {
  return (
    <li className="dash-row">
      <a className="dash-row-link" href={href}>
        <span className="dash-row-title">{title}</span>
        {note === undefined ? null : (
          <span className="dash-row-note">{note}</span>
        )}
      </a>
      {state === undefined ? null : (
        <span className="dash-row-state">{state}</span>
      )}
      {actions === undefined ? null : (
        <span className="dash-row-actions">{actions}</span>
      )}
    </li>
  );
}
