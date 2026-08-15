"use client";

/**
 * The parts the blog composer and the email composer both need.
 *
 * A post and an email are laid out the same way: a title field, a rich-text
 * body, then their own fields, then Save and Cancel. Only the buttons and the
 * empty body are identical, so only those two live here. Each composer keeps
 * its own fields rather than merging into one component with a mode flag.
 */

import {
  createRichTextDocumentFromPlainText,
  serializeRichTextDocument,
  type SerializedRichTextDocument,
} from "@humber-foundry/site-definition";

/** A serialized rich-text document with nothing in it, for a new draft. */
export function emptyRichTextBody(): SerializedRichTextDocument {
  return serializeRichTextDocument(createRichTextDocumentFromPlainText(""));
}

/**
 * Save and cancel, in that order. Cancel is left out when the composer has
 * nothing to go back to, which is the case for a new draft.
 */
export function ComposerActions({
  busy,
  saveLabel,
  blocked,
  onCancel,
}: {
  busy: boolean;
  saveLabel: string;
  /** True when the body is invalid, so saving would store something broken. */
  blocked: boolean;
  onCancel?: () => void;
}) {
  return (
    <div className="composer-actions">
      <button
        type="submit"
        className="button button-primary"
        disabled={busy || blocked}
      >
        {saveLabel}
      </button>
      {onCancel === undefined ? null : (
        <button
          type="button"
          className="copy-button"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
      )}
    </div>
  );
}
