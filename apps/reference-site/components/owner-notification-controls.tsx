"use client";

import type {
  FailedPublicFormDelivery,
  PublicFormDeliveryId,
} from "@humber-foundry/application";

import { formatDashboardMoment } from "@/src/dashboard-time";

import { useFormOperation } from "./use-form-operation";

const outcomeMessages = {
  applied: "Sending again.",
  refused: "That alert could not be sent again. Reload and try again.",
  unconfirmed: "The result is unknown. Reload the page before trying again.",
} as const;

/**
 * Why one alert stopped, in words. The stored code is a stable, non-secret
 * value meant for support, so it is named after the sentence rather than
 * shown on its own.
 */
const stopReasons: Readonly<Record<string, string>> = {
  adapter_outcome_unknown: "The email service did not answer.",
  claim_outcome_unknown: "Sending was interrupted part way.",
  retry_window_exhausted: "It was tried for a day and never went through.",
};

function stopReason(errorCode: string): string {
  return stopReasons[errorCode] ?? "The email service refused it.";
}

/**
 * The alerts that never reached the owner's email.
 *
 * This is about the alert only. The message a visitor sent is saved in
 * Messages whether or not its alert arrived, so nothing here can lose it.
 */
export function OwnerNotificationTable({
  failedDeliveries,
  pending,
  message,
  onSendAgain,
}: {
  failedDeliveries: ReadonlyArray<FailedPublicFormDelivery>;
  pending: boolean;
  message: string;
  onSendAgain: (deliveryId: PublicFormDeliveryId) => void;
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
            <span role="cell">
              {stopReason(delivery.errorCode)}
              <small>
                <code>{delivery.errorCode}</code>
              </small>
            </span>
            <div role="cell">
              <button
                className="copy-button"
                disabled={pending}
                onClick={() => onSendAgain(delivery.deliveryId)}
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
  const { message, pending, run } = useFormOperation(
    csrfToken,
    outcomeMessages,
  );

  return (
    <OwnerNotificationTable
      failedDeliveries={failedDeliveries}
      message={message}
      onSendAgain={(deliveryId) =>
        void run({ action: "replay_delivery", deliveryId })
      }
      pending={pending}
    />
  );
}
