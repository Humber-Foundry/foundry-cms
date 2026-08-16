import type { PublicFormDeliveryHealth } from "@humber-foundry/application";

/**
 * What to tell the Owner about the email alerts, in one place.
 *
 * Messages shows a single line and Settings shows the detail, so both read
 * the same words from here. This module is browser-safe: it holds no binding,
 * secret or adapter.
 */

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

export function ownerAlertStopReason(errorCode: string): string {
  return stopReasons[errorCode] ?? "The email service refused it.";
}

/**
 * Whether the email service can send an alert at all, in words.
 *
 * The health record carries this apart from the queue counts: a healthy queue
 * with an unavailable sender still means nothing arrives. Messages may only
 * say the alerts are working when this says the sender is healthy.
 */
const senderStates: Readonly<
  Record<PublicFormDeliveryHealth["adapter"], string | null>
> = {
  healthy: null,
  degraded: "Email alerts about new messages are slower than usual.",
  unavailable: "Email alerts about new messages are not being sent right now.",
};

export function ownerAlertSenderState(
  adapter: PublicFormDeliveryHealth["adapter"],
): string {
  return senderStates[adapter] ?? "The email service is working.";
}

/**
 * The one line Messages shows the Owner.
 *
 * It never says the alerts are working unless the email service is healthy
 * and every alert arrived. A stopped alert is named first, because that is
 * the one an Owner can send again from Settings.
 */
export function ownerAlertSummary(health: PublicFormDeliveryHealth): string {
  if (health.failed > 0) {
    return `${health.failed} email alert${
      health.failed === 1 ? "" : "s"
    } did not reach you.`;
  }
  return (
    senderStates[health.adapter] ??
    "Email alerts about new messages are working."
  );
}
