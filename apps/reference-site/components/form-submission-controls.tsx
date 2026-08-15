"use client";

import { useFormOperation } from "./use-form-operation";

const outcomeMessages = {
  applied: "Done.",
  refused: "That did not work. Reload the page and try again.",
  unconfirmed: "The result is unknown. Reload the page before trying again.",
} as const;

/**
 * What an Owner can do with one message: keep a copy, move it to or out of
 * spam, or erase what it says. Erasing keeps the receipt and the record of
 * what happened, so the site can still prove the message arrived.
 */
export function FormSubmissionActions({
  classification,
  pending,
  message,
  onDownload,
  onReclassify,
  onErase,
}: {
  classification: "accepted" | "suspected_spam";
  pending: boolean;
  message: string;
  onDownload: () => void;
  onReclassify: () => void;
  onErase: () => void;
}) {
  return (
    <section aria-labelledby="message-actions">
      <h2 id="message-actions">What you can do with this message</h2>
      <p role="status" aria-live="polite">
        {message}
      </p>
      <p>
        <button
          className="copy-button"
          disabled={pending}
          onClick={onDownload}
          type="button"
        >
          Download a copy
        </button>{" "}
        <button
          className="copy-button"
          disabled={pending}
          onClick={onReclassify}
          type="button"
        >
          {classification === "accepted"
            ? "Move it to spam"
            : "Not spam — accept it"}
        </button>{" "}
        <button
          className="copy-button"
          disabled={pending}
          onClick={onErase}
          type="button"
        >
          Erase what it says
        </button>
      </p>
    </section>
  );
}

export function FormSubmissionControls({
  csrfToken,
  receiptId,
  classification,
}: {
  csrfToken: string;
  receiptId: string;
  classification: "accepted" | "suspected_spam";
}) {
  const { message, pending, run, setMessage, setPending } = useFormOperation(
    csrfToken,
    outcomeMessages,
  );

  /**
   * The copy is a file, not a state change, so it does not go through the
   * shared command path: it needs the response body rather than its status.
   */
  async function download() {
    setPending(true);
    setMessage("");
    try {
      const response = await fetch("/api/foundry-cms/forms", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-foundry-csrf": csrfToken,
        },
        body: JSON.stringify({ action: "export_submission", receiptId }),
      });
      if (!response.ok) {
        setMessage("The copy could not be made.");
        return;
      }
      const objectUrl = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = `message-${receiptId}.json`;
      link.click();
      URL.revokeObjectURL(objectUrl);
      setMessage("The copy was downloaded. Taking it is recorded.");
    } catch {
      setMessage("The result is unknown. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <FormSubmissionActions
      classification={classification}
      message={message}
      onDownload={() => void download()}
      onErase={() => {
        if (
          window.confirm(
            "Erase what this message says? The receipt and the record of what happened to it stay.",
          )
        ) {
          void run({ action: "erase_submission", receiptId });
        }
      }}
      onReclassify={() =>
        void run({
          action: "classify_submission",
          receiptId,
          classification:
            classification === "accepted" ? "suspected_spam" : "accepted",
        })
      }
      pending={pending}
    />
  );
}
