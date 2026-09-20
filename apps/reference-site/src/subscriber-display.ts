import type {
  Subscriber,
  SubscriberIdentity,
  SubscriberState,
} from "@humber-foundry/application";

/**
 * What an Owner reads on screen, instead of the ledger's five internal
 * states. The ledger tells apart three ways an address stops receiving mail
 * (`complained`, `hard_bounced`, `erased`) because each one is proved and
 * reversed differently. An Owner reading a list only needs to know the
 * address will not receive mail, so all three read as one word: Suppressed.
 */
export type SubscriberDisplayState = "confirmed" | "unsubscribed" | "suppressed";

const displayStateByState: Readonly<Record<SubscriberState, SubscriberDisplayState>> =
  {
    active: "confirmed",
    unsubscribed: "unsubscribed",
    complained: "suppressed",
    hard_bounced: "suppressed",
    erased: "suppressed",
  };

export const subscriberDisplayStateLabel: Readonly<
  Record<SubscriberDisplayState, string>
> = {
  confirmed: "Confirmed",
  unsubscribed: "Unsubscribed",
  suppressed: "Suppressed",
};

export function subscriberDisplayState(
  state: SubscriberState,
): SubscriberDisplayState {
  return displayStateByState[state];
}

export type SubscriberDisplayRow = Readonly<{
  id: string;
  /** Null once an address is erased; the ledger clears it and keeps no copy. */
  email: string | null;
  displayState: SubscriberDisplayState;
  /**
   * The date consent was last given — the latest `consent_recorded` or
   * `resubscribed` event, not the record's own creation date, which never
   * moves even when somebody unsubscribes and later resubscribes. Null for
   * a record that never went through consent at all (for example one a
   * provider suppression created for an address that never signed up); the
   * table shows a dash rather than a date nobody gave.
   */
  consentDate: string | null;
}>;

export function toSubscriberDisplayRow(
  subscriber: SubscriberIdentity,
): SubscriberDisplayRow {
  return {
    id: subscriber.id,
    email: subscriber.email,
    displayState: subscriberDisplayState(subscriber.state),
    consentDate: subscriber.latestConsentAt,
  };
}

export type SubscriberStateCounts = Readonly<
  Record<SubscriberDisplayState, number>
>;

/**
 * Counts only. This is what an Editor or an MCP client is allowed to see —
 * how many subscribers are in each state, never who they are. It never takes
 * an actor and never touches the audit trail, because it never reveals an
 * identity.
 */
export function countSubscribersByDisplayState(
  subscribers: ReadonlyArray<Subscriber>,
): SubscriberStateCounts {
  const counts = { confirmed: 0, unsubscribed: 0, suppressed: 0 };
  for (const subscriber of subscribers) {
    counts[subscriberDisplayState(subscriber.state)] += 1;
  }
  return counts;
}
