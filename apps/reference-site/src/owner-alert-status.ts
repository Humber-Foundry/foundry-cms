import type { PublicFormDeliveryHealth } from "@humber-foundry/application";

/**
 * What to tell the Owner about the email alerts, in one place.
 *
 * Messages shows a single line and Settings shows the detail, so both read
 * the same words from here. This module is browser-safe: it holds no binding,
 * secret or adapter.
 *
 * Every sentence here says only what the CMS checked. Two things are known:
 * how many alerts stopped for good, which the store counted, and what the
 * sender reports about its own ability to send. Nothing here measures how
 * fast an alert travels or whether the provider is up, so nothing here says
 * so.
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
 * Whether alerts can be sent at all, in the sender's own words.
 *
 * This is a separate fact from the queue counts: a queue with nothing in it
 * and a sender that cannot send still means nothing arrives. The map covers
 * the whole state union, so a new state fails to compile rather than reading
 * as good news.
 */
const senderStates: Readonly<
  Record<PublicFormDeliveryHealth["adapter"], string>
> = {
  healthy: "Alerts can be sent.",
  degraded: "Alerts can be sent, but not everything is going through.",
  unavailable:
    "Alerts cannot be sent. Check this site's email settings with whoever set it up.",
};

export function ownerAlertSenderState(
  adapter: PublicFormDeliveryHealth["adapter"],
): string {
  return senderStates[adapter];
}

/**
 * The one line Messages shows the Owner.
 *
 * It says the alerts are working only when no alert stopped and the sender
 * reports it can send. A stopped alert is named first, because that is the
 * one an Owner can send again from Settings.
 */
export function ownerAlertSummary(health: PublicFormDeliveryHealth): string {
  if (health.failed > 0) {
    return `${health.failed} email alert${
      health.failed === 1 ? "" : "s"
    } did not reach you.`;
  }
  if (health.adapter === "unavailable") {
    return "Email alerts about new messages cannot be sent at the moment.";
  }
  if (health.adapter === "degraded") {
    return "Email alerts about new messages are not all going through.";
  }
  return "Email alerts about new messages are working.";
}
