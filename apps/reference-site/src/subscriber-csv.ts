import type { Subscriber } from "@humber-foundry/application";

import {
  subscriberDisplayState,
  subscriberDisplayStateLabel,
} from "./subscriber-display";

/** RFC 4180 field escaping: quote a field that holds a comma, a quote or a
 * line break, and double any quote inside it. */
function csvField(value: string): string {
  return /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function csvRow(fields: ReadonlyArray<string>): string {
  return fields.map(csvField).join(",");
}

/**
 * The Owner-only export an Owner downloads from the Subscribers screen. One
 * row per subscriber: the address, the plain-word state and the date they
 * gave consent. Nothing here is computed from anything an Editor or an MCP
 * client can already see.
 */
export function subscribersToCsv(
  subscribers: ReadonlyArray<Subscriber>,
): string {
  const lines = [
    csvRow(["Email address", "State", "Consent date"]),
    ...subscribers.map((subscriber) =>
      csvRow([
        subscriber.email ?? "",
        subscriberDisplayStateLabel[subscriberDisplayState(subscriber.state)],
        subscriber.createdAt,
      ]),
    ),
  ];
  // CSV's registered line ending is CRLF; several spreadsheet importers only
  // split rows reliably when the file uses it.
  return lines.join("\r\n") + "\r\n";
}
