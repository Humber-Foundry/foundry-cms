import {
  subscriberDisplayStateLabel,
  type SubscriberDisplayRow,
} from "@/src/subscriber-display";
import { formatDashboardMoment } from "@/src/dashboard-time";

/**
 * Every subscriber, one row each: the address, the state and the date they
 * gave consent. Owner-only — the caller must never pass this component rows
 * built from a count, and must never render it for an Editor.
 *
 * `labelledBy` should point at the visible heading of the section this
 * table sits in, so a screen reader announces what the table is a table of.
 */
export function SubscriberTable({
  rows,
  labelledBy,
}: {
  rows: ReadonlyArray<SubscriberDisplayRow>;
  labelledBy: string;
}) {
  if (rows.length === 0) {
    return (
      <p className="empty-state">
        Nobody has joined your list yet. An address appears here once
        somebody confirms it from the signup email.
      </p>
    );
  }

  return (
    <table className="subscriber-table" aria-labelledby={labelledBy}>
      <thead>
        <tr>
          <th scope="col">Email address</th>
          <th scope="col">State</th>
          <th scope="col">Consent date</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id}>
            <td>{row.email ?? "Address removed"}</td>
            <td>
              <span
                className={`state-label state-label-${row.displayState}`}
              >
                {subscriberDisplayStateLabel[row.displayState]}
              </span>
            </td>
            <td>
              {row.consentDate === null
                ? "—"
                : formatDashboardMoment(row.consentDate)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
