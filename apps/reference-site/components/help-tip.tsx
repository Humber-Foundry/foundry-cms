"use client";

import { useEffect, useId, useRef, useState } from "react";

/**
 * "What does this mean?" — the one help control for a technical term the
 * dashboard cannot avoid showing.
 *
 * Rewrite the term in plain words first. Reach for `HelpTip` only when the
 * exact word or number must stay on screen — a revision number a person
 * quotes to support, a fingerprint that proves which draft was approved, and
 * so on.
 *
 * `HelpTip` is a small button next to the term. Activating it opens a short
 * explanation next to the button:
 * - Keyboard: Tab reaches the button; Enter or Space opens or closes it;
 *   Escape closes it; Tab past it closes it.
 * - Touch: a tap opens or closes it, the same as a click.
 * - Screen reader: the button announces its name and its open state through
 *   `aria-expanded`; once open, the explanation is read through
 *   `aria-describedby`.
 *
 * This is a toggle a person opens on purpose, not a hover card. A term that
 * only reveals its meaning on mouse hover is unreachable by keyboard and by
 * touch, so the dashboard never uses one.
 */
export function HelpTip({
  label,
  children,
}: {
  /** The button's accessible name, e.g. "What's a revision?" */
  label: string;
  /** The explanation, in plain words. Kept short — a sentence or two. */
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const rootRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    function closeOnOutsidePress(event: PointerEvent) {
      const root = rootRef.current;
      if (root !== null && !root.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    document.addEventListener("keydown", closeOnEscape);
    document.addEventListener("pointerdown", closeOnOutsidePress);
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      document.removeEventListener("pointerdown", closeOnOutsidePress);
    };
  }, [open]);

  return (
    <span
      className="help-tip"
      ref={rootRef}
      onBlur={(event) => {
        // Tabbing away from the button, or from inside the open panel,
        // closes it — the same as clicking outside.
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        className="help-tip-trigger"
        aria-expanded={open}
        aria-describedby={open ? panelId : undefined}
        aria-label={label}
        onClick={() => setOpen((value) => !value)}
      >
        <span aria-hidden="true">?</span>
      </button>
      {open ? (
        <span className="help-tip-panel" id={panelId} role="status">
          {children}
        </span>
      ) : null}
    </span>
  );
}
