"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import type {
  FailedPublicFormDelivery,
  SuspectedSpamSubmission,
} from "@foundry/application";

export function FormOperationsControls({
  csrfToken,
  failedDeliveries,
  suspectedSpam,
}: {
  csrfToken: string;
  failedDeliveries: ReadonlyArray<FailedPublicFormDelivery>;
  suspectedSpam: ReadonlyArray<SuspectedSpamSubmission>;
}) {
  const router = useRouter();
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);

  async function apply(command: unknown) {
    setPending(true);
    setMessage("");
    const request = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
        "x-foundry-csrf": csrfToken,
      },
      body: JSON.stringify(command),
    };
    try {
      const response = await fetch("/api/foundry-cms/forms", request);
      setMessage(
        response.ok
          ? "Form operation applied."
          : "The form operation could not be applied.",
      );
      if (response.ok) router.refresh();
    } catch {
      setMessage(
        "The result could not be confirmed. Refresh before trying again.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <p role="status" aria-live="polite">{message}</p>
      <div className="inventory-table" role="table" aria-label="Failed form deliveries">
        <div className="inventory-row inventory-head" role="row">
          <span role="columnheader">Failed delivery</span>
          <span role="columnheader">Error</span>
          <span role="columnheader">Action</span>
        </div>
        {failedDeliveries.length === 0 ? (
          <div className="inventory-row" role="row">
            <strong role="cell">No failed deliveries</strong>
            <span role="cell">—</span>
            <span role="cell">—</span>
          </div>
        ) : failedDeliveries.map((delivery) => (
          <div className="inventory-row" role="row" key={delivery.deliveryId}>
            <strong role="cell">
              {delivery.formId}
              <small>{delivery.receiptId} · {delivery.attempts} attempts</small>
            </strong>
            <code role="cell">{delivery.errorCode}</code>
            <div role="cell">
              <button
                className="copy-button"
                disabled={pending}
                onClick={() => apply({
                  action: "replay_delivery",
                  deliveryId: delivery.deliveryId,
                })}
                type="button"
              >
                Replay
              </button>
            </div>
          </div>
        ))}
      </div>
      <div className="inventory-table" role="table" aria-label="Suspected spam">
        <div className="inventory-row inventory-head" role="row">
          <span role="columnheader">Held submission</span>
          <span role="columnheader">Accepted</span>
          <span role="columnheader">Action</span>
        </div>
        {suspectedSpam.length === 0 ? (
          <div className="inventory-row" role="row">
            <strong role="cell">No submissions awaiting review</strong>
            <span role="cell">—</span>
            <span role="cell">—</span>
          </div>
        ) : suspectedSpam.map((submission) => (
          <div className="inventory-row" role="row" key={submission.receiptId}>
            <strong role="cell">
              {submission.formId}
              <small>{submission.receiptId}</small>
            </strong>
            <span role="cell">{submission.acceptedAt}</span>
            <div role="cell">
              <button
                className="copy-button"
                disabled={pending}
                onClick={() => apply({
                  action: "release_spam",
                  receiptId: submission.receiptId,
                })}
                type="button"
              >
                Release and notify
              </button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
