import type { ReactNode } from "react";

/**
 * What a list shows when it holds nothing yet.
 *
 * An empty list never shows a bare sentence on its own. It shows a short
 * heading, one sentence that says what to do next, and — where there is one
 * obvious next step — the control that does it.
 *
 * Write the sentence as an instruction, not as a report. "Write your first
 * post to start your blog", rather than "No posts found".
 */
export function DashboardEmptyState({
  title,
  children,
  action,
}: {
  /** A short heading. For example "No posts yet". */
  title: ReactNode;
  /** One sentence that says what to do next. */
  children: ReactNode;
  /** The control that does the next step. Leave it out when there is none. */
  action?: ReactNode;
}) {
  return (
    <div className="dash-empty">
      <h3 className="dash-empty-title">{title}</h3>
      <p className="dash-empty-text">{children}</p>
      {action === undefined ? null : (
        <div className="dash-empty-action">{action}</div>
      )}
    </div>
  );
}
