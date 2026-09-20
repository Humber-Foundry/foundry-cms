import {
  latestConsentDateBySubscriber,
  type Subscriber,
  type SubscriberEvent,
} from "@humber-foundry/application";

import {
  subscriberDisplayState,
  subscriberDisplayStateLabel,
} from "./subscriber-display";

/**
 * The first character of a cell a spreadsheet application (Excel, Google
 * Sheets, LibreOffice) opens as a formula rather than text. An email's local
 * part may legally start with `=`, `+` or `-` — `normalizeEmailAddress`
 * forbids only whitespace and `@` — and the address in this column comes
 * straight from the public signup form, so an Owner opening this file in a
 * spreadsheet must never run somebody else's formula. `@`, tab and CR are
 * neutralized too, defensively, in case a column here ever carries a value
 * `normalizeEmailAddress` does not police.
 */
const formulaTriggerFirstChars = new Set(["=", "+", "-", "@", "\t", "\r"]);

/** A leading formula-trigger character, given a plain quote mark in front of
 * it. A spreadsheet application reads a cell that starts with a quote mark
 * as text, never as a formula, and the quote mark itself is never shown. */
function neutralizeFormulaInjection(value: string): string {
  return value.length > 0 && formulaTriggerFirstChars.has(value[0]!)
    ? `'${value}`
    : value;
}

/** RFC 4180 field escaping: quote a field that holds a comma, a quote or a
 * line break, and double any quote inside it. */
function csvField(value: string): string {
  const neutralized = neutralizeFormulaInjection(value);
  return /[",\r\n]/u.test(neutralized)
    ? `"${neutralized.replaceAll('"', '""')}"`
    : neutralized;
}

function csvRow(fields: ReadonlyArray<string>): string {
  return fields.map(csvField).join(",");
}

/**
 * The Owner-only export an Owner downloads from the Subscribers screen. One
 * row per subscriber: the address, the plain-word state and the date
 * consent was last given. The consent date comes from the ledger's event
 * history (the same history `exportLedger` already returns, unchanged), not
 * from the subscriber record's own creation date, which never moves even
 * when somebody unsubscribes and later resubscribes.
 *
 * This function is called only from the CSV branch of the Owner-only,
 * audited `exportLedger` route handler. It never reads the store on its own
 * and takes no actor, so it cannot become a second, unaudited way to reach a
 * subscriber's address.
 */
export function subscribersToCsv(ledger: {
  subscribers: ReadonlyArray<Subscriber>;
  events: ReadonlyArray<SubscriberEvent>;
}): string {
  const latestConsent = latestConsentDateBySubscriber(ledger.events);
  const lines = [
    csvRow(["Email address", "State", "Consent date"]),
    ...ledger.subscribers.map((subscriber) =>
      csvRow([
        subscriber.email ?? "",
        subscriberDisplayStateLabel[subscriberDisplayState(subscriber.state)],
        latestConsent.get(subscriber.id) ?? "",
      ]),
    ),
  ];
  // CSV's registered line ending is CRLF; several spreadsheet importers only
  // split rows reliably when the file uses it.
  return lines.join("\r\n") + "\r\n";
}
