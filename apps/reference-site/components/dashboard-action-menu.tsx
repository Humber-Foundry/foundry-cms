"use client";

import { useEffect, useId, useRef, useState } from "react";

/** One action in a `DashboardActionMenu`. */
export type DashboardAction = Readonly<{
  /** A value that tells this action apart from the others in the list. */
  id: string;
  /** What the action does, in the owner's words. For example "Rename". */
  label: string;
  /**
   * `destructive` for an action that removes something. It is drawn in the
   * warning colour and always sits last. Everything else is `plain`.
   */
  tone?: "plain" | "destructive";
  /** What to run when the owner chooses the action. */
  onSelect: () => void;
}>;

/**
 * The "..." button on a row, and the menu of actions it opens.
 *
 * A row shows one menu instead of a line of buttons, so the row stays
 * readable and the title is the thing the eye lands on.
 *
 * Leave out an action the person may not take. Never pass a disabled
 * action: a control the owner cannot press, with no reason given, is the
 * fault this component exists to remove. Where the reason matters, say it
 * on the screen the action leads to.
 *
 * Keyboard:
 * - Tab reaches the button. Enter, Space, Down arrow or Up arrow opens it.
 * - Up and Down arrows move between the actions, and the ends wrap round.
 *   Home goes to the first action, End to the last.
 * - Enter or Space runs the action under the cursor and closes the menu.
 * - Escape closes the menu and puts focus back on the button.
 * - Tab closes the menu, and a press outside it closes it too.
 *
 * Every action carries an `onSelect` function, and a function cannot cross
 * from a Server Component into a Client Component as a prop. So the piece
 * that builds the action list must itself be a Client Component. A server
 * page loads the data and hands it to one client component, which then
 * draws the rows and their menus.
 */
export function DashboardActionMenu({
  label,
  actions,
}: {
  /**
   * The button's name for a screen reader. Name the row, because a screen
   * may hold many of these buttons. For example "Actions for About us".
   */
  label: string;
  /** The actions the owner may take. An empty list draws no button at all. */
  actions: ReadonlyArray<DashboardAction>;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const menuId = useId();
  const rootRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // The item the arrow keys moved to takes focus after the menu has
  // rendered, so a screen reader announces it and Enter runs the right one.
  useEffect(() => {
    if (!open) return;
    itemRefs.current[activeIndex]?.focus();
  }, [open, activeIndex]);

  useEffect(() => {
    if (!open) return;
    function closeOnOutsidePress(event: PointerEvent) {
      const root = rootRef.current;
      if (root !== null && !root.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("pointerdown", closeOnOutsidePress);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePress);
    };
  }, [open]);

  if (actions.length === 0) return null;

  /** Shut the menu and put focus back where the owner opened it. */
  function closeAndReturnFocus() {
    setOpen(false);
    buttonRef.current?.focus();
  }

  function openAt(index: number) {
    setActiveIndex(index);
    setOpen(true);
  }

  function onButtonKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      openAt(0);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      openAt(actions.length - 1);
    }
  }

  function onMenuKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeAndReturnFocus();
      return;
    }
    if (event.key === "Tab") {
      // The menu closes, so React would take the focused action out of the
      // page before the browser moves focus, and focus would fall to the
      // body — the next Tab would then start again at the top of the page.
      // Putting focus on the button first means Tab carries on from the
      // button, which is where the owner was.
      closeAndReturnFocus();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % actions.length);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => (index - 1 + actions.length) % actions.length);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(actions.length - 1);
    }
  }

  return (
    <span className="dash-action-menu" ref={rootRef}>
      <button
        type="button"
        className="dash-action-menu-button"
        ref={buttonRef}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onKeyDown={onButtonKeyDown}
        onClick={() => {
          if (open) setOpen(false);
          else openAt(0);
        }}
      >
        <span aria-hidden="true">…</span>
      </button>
      {open ? (
        <div
          className="dash-action-menu-list"
          id={menuId}
          role="menu"
          aria-label={label}
          onKeyDown={onMenuKeyDown}
        >
          {actions.map((action, index) => (
            <button
              key={action.id}
              type="button"
              role="menuitem"
              className={
                action.tone === "destructive"
                  ? "dash-action-menu-item dash-action-menu-item-destructive"
                  : "dash-action-menu-item"
              }
              ref={(element) => {
                itemRefs.current[index] = element;
              }}
              tabIndex={index === activeIndex ? 0 : -1}
              onClick={() => {
                closeAndReturnFocus();
                action.onSelect();
              }}
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
    </span>
  );
}
