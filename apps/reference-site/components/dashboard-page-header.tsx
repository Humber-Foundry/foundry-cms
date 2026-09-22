import type { ReactNode } from "react";

/**
 * The heading at the top of a dashboard screen.
 *
 * It holds three things and nothing else: the screen's name, one sentence
 * that says what the screen is for, and at most one primary action. Every
 * dashboard screen draws its heading through this component, so no two
 * screens invent a different heading shape.
 *
 * There is no eyebrow label above the name. There are two type sizes here:
 * the name, and the sentence under it. Colour carries the difference.
 *
 * The action slot takes one control. It is the one primary button on the
 * screen (`dash-button dash-button-primary`). Every other action on the
 * screen is a plain button or an item in a `DashboardActionMenu`.
 */
export function DashboardPageHeader({
  title,
  description,
  action,
}: {
  /** The screen's name, as the owner would say it. For example "Pages". */
  title: ReactNode;
  /** One sentence that says what the owner does on this screen. */
  description: ReactNode;
  /** The one primary action for this screen. Leave it out when there is none. */
  action?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action === undefined ? null : (
        <div className="page-heading-action">{action}</div>
      )}
    </div>
  );
}
