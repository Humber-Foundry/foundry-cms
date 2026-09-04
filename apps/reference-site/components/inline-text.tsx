"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import { registerOverlayPortal } from "@puckeditor/core";

/**
 * A piece of the page's own text, editable where it stands.
 *
 * The section's real markup renders this span in place of the plain string, so
 * the owner clicks into the sentence and types — the page is the editor. The
 * element is uncontrolled: React sets the text once and never reconciles it,
 * because re-rendering a contentEditable's children throws the caret away.
 * The value commits on blur, or on Enter for single-line fields.
 *
 * One click is enough: the text is editable before its section is selected, so
 * the click that lands here places the caret, and taking focus selects the
 * section so its controls are in reach. Clicking alone changes nothing — the
 * owner still has to type.
 */
export function InlineText({
  path,
  value,
  multiline = false,
  label,
  onCommit,
  onSelectSection,
}: {
  /** Dot path of the field inside the section's props, e.g. "principles.2.text". */
  path: string;
  value: string;
  multiline?: boolean;
  label: string;
  /** Returns false when the value is not allowed; the text reverts. */
  onCommit(next: string): boolean;
  /**
   * Selects the section this text belongs to. Called when the text takes
   * focus, so one click both puts the caret where the owner clicked and
   * selects the section its controls belong to.
   */
  onSelectSection?(): void;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const lastCommitted = useRef(value);

  // Puck treats a press on the canvas as the start of a section drag; the
  // portal makes this element interactive instead, exactly like the rich-text
  // island. Drag is off entirely rather than only once focused, so dragging
  // across the words selects them the way it does in any editor. A section is
  // still moved from its own Move up and Move down controls.
  useEffect(() => {
    if (ref.current === null) return;
    return registerOverlayPortal(ref.current, { disableDrag: true });
  }, []);

  // The DOM owns the text while it has focus; outside of that, external
  // changes to the value (undo, a recovered save) are written through so the
  // page never shows stale words.
  useLayoutEffect(() => {
    const element = ref.current;
    if (
      element !== null &&
      element.ownerDocument.activeElement !== element &&
      element.textContent !== value
    ) {
      element.textContent = value;
      lastCommitted.current = value;
    }
  }, [value]);

  // plaintext-only keeps pasted markup out. Assigning it throws where it is
  // unsupported (older Firefox); plain contentEditable is the fallback, and
  // the commit reads innerText, which strips any pasted markup anyway.
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    try {
      element.contentEditable = "plaintext-only";
    } catch {
      element.contentEditable = "true";
    }
  }, []);

  const readValue = (): string => {
    const text = ref.current?.innerText ?? "";
    // innerText represents trailing block boundaries as a newline.
    const trimmed = text.replace(/\n+$/u, "");
    return multiline ? trimmed : trimmed.replaceAll("\n", " ");
  };

  const commit = () => {
    const next = readValue();
    if (next === lastCommitted.current) return;
    if (onCommit(next)) {
      lastCommitted.current = next;
      return;
    }
    // The schema refused the value (for example, emptied text); the page
    // keeps showing what it will actually publish.
    if (ref.current !== null) {
      ref.current.textContent = lastCommitted.current;
    }
  };

  return (
    <span
      ref={ref}
      data-inline-edit={path}
      // Puck sets user-select:none on a component and everything inside it, so
      // a drag moves the component instead of selecting words. Editable text is
      // the exception: dragging across it selects it, the way it does in any
      // editor. Set here rather than in a stylesheet so the rule travels with
      // the component and cannot be lost by a specificity change elsewhere.
      style={{ userSelect: "text", WebkitUserSelect: "text" }}
      role="textbox"
      aria-label={label}
      aria-multiline={multiline}
      tabIndex={0}
      suppressContentEditableWarning
      spellCheck
      onFocus={() => onSelectSection?.()}
      onBlur={commit}
      onClick={(event) => {
        // Some of this text lives inside real links and buttons; a click here
        // places the caret and must never follow the link.
        event.preventDefault();
        event.stopPropagation();
      }}
      onKeyDown={(event) => {
        // Keystrokes belong to the text being edited: without this, Puck's
        // canvas hotkeys see them too, and undo would rewrite page history
        // instead of the sentence.
        event.stopPropagation();
        // Mid-composition input (IME) is not complete text yet.
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Enter" && !multiline) {
          event.preventDefault();
          event.currentTarget.blur();
        }
        if (event.key === "Escape") {
          if (ref.current !== null) {
            ref.current.textContent = lastCommitted.current;
          }
          event.currentTarget.blur();
        }
      }}
    />
  );
}
