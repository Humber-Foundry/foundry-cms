import type { ReactNode } from "react";

/**
 * How a row's state is drawn. The word on screen is always written by the
 * caller; the tone only picks the colour.
 *
 * - `live` — the thing is on the site now. For example "Published".
 * - `draft` — the thing is not on the site yet, or it has unpublished
 *   changes. For example "Draft changes".
 * - `plain` — a state that needs no colour of its own. For example "Saved".
 * - `problem` — something needs the owner's attention before it can work.
 *   For example "Did not send".
 */
export type DashboardStateTone = "live" | "draft" | "plain" | "problem";

/**
 * The one short word, or two, that says the state of a row.
 *
 * Colour carries the meaning, so the label stays at the small text size and
 * never becomes a third type size in the row. Write the state in the words
 * the dashboard already uses — see `editorPagePublishedStateLabels` in
 * `src/editor-page-selection.ts` and the Owner-facing words section of
 * `CONTEXT.md`. Never put an internal state name on screen.
 */
export function DashboardStateLabel({
  tone,
  children,
}: {
  /** Which colour the word takes. See `DashboardStateTone`. */
  tone: DashboardStateTone;
  /** The word on screen, in the owner's language. */
  children: ReactNode;
}) {
  return (
    <span className={`dash-state dash-state-${tone}`}>{children}</span>
  );
}
