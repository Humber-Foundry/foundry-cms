import { headers } from "next/headers";

import { HelpTip } from "@/components/help-tip";
import { SubscriberTable } from "@/components/subscriber-table";
import { requireAuthorizedDashboardAccess } from "@/src/dashboard-page-context";
import { loadPendingSignupCount } from "@/src/newsletter-signup-runtime";
import {
  countSubscribersByDisplayState,
  toSubscriberDisplayRow,
  type SubscriberDisplayRow,
  type SubscriberStateCounts,
} from "@/src/subscriber-display";
import {
  loadSubscriberLedgerRequestContext,
  loadSubscriberStateCounts,
} from "@/src/subscriber-ledger-runtime";

export const dynamic = "force-dynamic";

function StateCounts({
  waitingToConfirm,
  counts,
}: {
  waitingToConfirm: number;
  counts: SubscriberStateCounts;
}) {
  return (
    <dl className="status-grid subscriber-counts">
      <div>
        <dt>
          Waiting to confirm{" "}
          <HelpTip label="What does waiting to confirm mean?">
            Foundry sent these people a confirmation email. They have not
            opened the link in it yet, so they have not joined your list.
          </HelpTip>
        </dt>
        <dd>{waitingToConfirm}</dd>
      </div>
      <div>
        <dt>Confirmed</dt>
        <dd>{counts.confirmed}</dd>
      </div>
      <div>
        <dt>Unsubscribed</dt>
        <dd>{counts.unsubscribed}</dd>
      </div>
      <div>
        <dt>
          Suppressed{" "}
          <HelpTip label="What does suppressed mean?">
            A suppressed address stopped receiving mail because it reported
            your mail as spam, could not be delivered, or asked to be
            erased. Foundry never sends to it again on its own.
          </HelpTip>
        </dt>
        <dd>{counts.suppressed}</dd>
      </div>
    </dl>
  );
}

/**
 * Subscribers is where an Owner sees who is on the newsletter list and
 * exports it. An Editor and an MCP client see the same four counts and
 * nothing else — no address ever reaches either of them from this screen.
 */
export default async function DashboardSubscribersPage() {
  const access = await requireAuthorizedDashboardAccess();
  const isOwner = access.membership.role === "owner";

  const waitingToConfirm = await loadPendingSignupCount();

  let counts: SubscriberStateCounts;
  let rows: ReadonlyArray<SubscriberDisplayRow> = [];

  if (isOwner) {
    const context = await loadSubscriberLedgerRequestContext(await headers());
    const subscribers = await context.application.queries.listIdentities({
      actor: context.identity,
    });
    rows = subscribers.map(toSubscriberDisplayRow);
    counts = countSubscribersByDisplayState(subscribers);
  } else {
    counts = await loadSubscriberStateCounts(access);
  }

  return (
    <main className="dashboard-main" id="main">
      <div className="page-heading">
        <div>
          <h1>Subscribers</h1>
          <p>
            Everyone connected to your newsletter list, and the state of
            each one.
          </p>
        </div>
      </div>

      <section aria-labelledby="subscriber-counts">
        <h2 id="subscriber-counts">Counts</h2>
        <StateCounts waitingToConfirm={waitingToConfirm} counts={counts} />
      </section>

      {isOwner ? (
        <section aria-labelledby="subscriber-list">
          <div className="dashboard-section-heading">
            <div>
              <h2 id="subscriber-list">Everyone on your list</h2>
              <p>Their address, their state, and the date they gave consent.</p>
            </div>
            <a
              className="button button-primary"
              href="/api/foundry-cms/subscribers?format=csv"
            >
              Download as CSV
            </a>
          </div>
          <SubscriberTable rows={rows} labelledBy="subscriber-list" />
        </section>
      ) : (
        <p className="dashboard-note">
          Only an Owner can see an email address or download this list. You
          see the counts above.
        </p>
      )}
    </main>
  );
}
