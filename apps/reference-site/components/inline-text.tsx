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
 * Editing is only offered while the section is selected (the caller decides),
 * so a stray click on the page cannot change words by mistake.
 */
export function InlineText({
  path,
  value,
  multiline = false,
  label,
  onCommit,
}: {
  /** Dot path of the field inside the section's props, e.g. "principles.2.text". */
  path: string;
  value: string;
  multiline?: boolean;
  label: string;
  /** Returns false when the value is not allowed; the text reverts. */
  onCommit(next: string): boolean;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const lastCommitted = useRef(value);

  // Puck treats clicks on the canvas as selection; the portal makes this
  // element interactive instead, exactly like the rich-text island.
  useEffect(() => {
    if (ref.current === null) return;
    return registerOverlayPortal(ref.current, { disableDragOnFocus: true });
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
      role="textbox"
      aria-label={label}
      aria-multiline={multiline}
      tabIndex={0}
      suppressContentEditableWarning
      spellCheck
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
