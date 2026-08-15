"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import type { FailedPublicFormDelivery } from "@humber-foundry/application";

import { formatDashboardMoment } from "@/src/dashboard-time";

import { applyFormOperation } from "./form-operation-request";

const outcomeMessages = {
  applied: "Sending again.",
  refused: "That alert could not be sent again. Reload and try again.",
  unconfirmed: "The result is unknown. Reload the page before trying again.",
} as const;

/**
 * The alerts that never reached the owner's email.
 *
 * This is about the alert only. The message a visitor sent is saved in
 * Messages whether or not its alert arrived, so nothing here can lose it.
 */
export function OwnerNotificationTable({
  failedDeliveries,
  pending = false,
  message = "",
  onSendAgain,
}: {
  failedDeliveries: ReadonlyArray<FailedPublicFormDelivery>;
  pending?: boolean;
  message?: string;
  onSendAgain?: (deliveryId: string) => void;
}) {
  if (failedDeliveries.length === 0) {
    return (
      <p className="empty-state">
        Every alert about a new message reached your email.
      </p>
    );
  }

  return (
    <>
      <p role="status" aria-live="polite">
        {message}
      </p>
      <div
        className="inventory-table"
        role="table"
        aria-label="Alerts that did not arrive"
      >
        <div className="inventory-row inventory-head" role="row">
          <span role="columnheader">Message</span>
          <span role="columnheader">Why it stopped</span>
          <span role="columnheader">Action</span>
        </div>
        {failedDeliveries.map((delivery) => (
          <div className="inventory-row" role="row" key={delivery.deliveryId}>
            <strong role="cell">
              <a href={`/dash/forms/${encodeURIComponent(delivery.receiptId)}`}>
                {delivery.formId} form
              </a>
              <small>
                {formatDashboardMoment(delivery.updatedAt)} ·{" "}
                {delivery.attempts} attempt
                {delivery.attempts === 1 ? "" : "s"}
              </small>
            </strong>
            <code role="cell">{delivery.errorCode}</code>
            <div role="cell">
              <button
                className="copy-button"
                disabled={pending}
                onClick={() => onSendAgain?.(delivery.deliveryId)}
                type="button"
              >
                Send the alert again
              </button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

export function OwnerNotificationControls({
  csrfToken,
  failedDeliveries,
}: {
  csrfToken: string;
  failedDeliveries: ReadonlyArray<FailedPublicFormDelivery>;
}) {
  const router = useRouter();
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);

  async function sendAgain(deliveryId: string) {
    setPending(true);
    setMessage("");
    const outcome = await applyFormOperation(
      { action: "replay_delivery", deliveryId },
      csrfToken,
    );
    setMessage(outcomeMessages[outcome]);
    setPending(false);
    if (outcome === "applied") router.refresh();
  }

  return (
    <OwnerNotificationTable
      failedDeliveries={failedDeliveries}
      message={message}
      onSendAgain={sendAgain}
      pending={pending}
    />
  );
}
