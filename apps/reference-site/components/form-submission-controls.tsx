"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function FormSubmissionControls({
  csrfToken,
  receiptId,
  classification,
}: {
  csrfToken: string;
  receiptId: string;
  classification: "accepted" | "suspected_spam";
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");

  async function apply(command: unknown) {
    setPending(true);
    setMessage("");
    try {
      const response = await fetch("/api/foundry-cms/forms", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
          "x-foundry-csrf": csrfToken,
        },
        body: JSON.stringify(command),
      });
      setMessage(
        response.ok
          ? "Form data operation applied."
          : "The form data operation could not be applied.",
      );
      if (response.ok) router.refresh();
    } catch {
      setMessage("The result is unknown. Refresh before trying again.");
    } finally {
      setPending(false);
    }
  }

  async function exportSubmission() {
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
        setMessage("The form data export could not be created.");
        return;
      }
      const objectUrl = URL.createObjectURL(await response.blob());
      const download = document.createElement("a");
      download.href = objectUrl;
      download.download = `form-${receiptId}.json`;
      download.click();
      URL.revokeObjectURL(objectUrl);
      setMessage("The audited form data export was created.");
    } catch {
      setMessage("The form data export result is unknown. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section aria-labelledby="form-data-actions">
      <h2 id="form-data-actions">Owner data actions</h2>
      <p role="status" aria-live="polite">{message}</p>
      <p>
        <button
          className="copy-button"
          disabled={pending}
          onClick={() => void exportSubmission()}
          type="button"
        >
          Export audited JSON
        </button>{" "}
        <button
          className="copy-button"
          disabled={pending}
          onClick={() =>
            apply({
              action: "classify_submission",
              receiptId,
              classification:
                classification === "accepted"
                  ? "suspected_spam"
                  : "accepted",
            })
          }
          type="button"
        >
          Mark as{" "}
          {classification === "accepted" ? "suspected spam" : "accepted"}
        </button>{" "}
        <button
          className="copy-button"
          disabled={pending}
          onClick={() => {
            if (
              window.confirm(
                "Erase this submission payload? The receipt and minimal audit evidence will remain.",
              )
            ) {
              void apply({ action: "erase_submission", receiptId });
            }
          }}
          type="button"
        >
          Erase payload
        </button>
      </p>
    </section>
  );
}
