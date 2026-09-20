"use client";

import type {
  FailedPublicFormDelivery,
  HumanMembership,
  McpConnectionSummary,
  PublicFormDeliveryHealth,
} from "@humber-foundry/application";
import type { SiteDefinition } from "@humber-foundry/site-definition";

import { ConnectionStatus, type ConnectionReadiness } from "./connection-status";
import { McpConnectionControls } from "./mcp-connection-controls";
import {
  AccessSyncRetryControls,
  MemberAccessPanel,
  useHumanAccessMutation,
} from "./member-access-controls";
import { OwnerNotificationControls } from "./owner-notification-controls";
import { SiteTechnicalDetail } from "./site-technical-detail";
import { ownerAlertSenderState } from "@/src/owner-alert-status";

/**
 * How full the message store is, in words rather than a state name. The
 * percentage is kept because it is the only number that says how much room is
 * left.
 */
const roomLeft: Readonly<
  Record<PublicFormDeliveryHealth["capacity"]["state"], string>
> = {
  normal: "There is plenty of room.",
  warning: "It is getting full, so plan what to keep.",
  critical: "There is very little left. Erase messages you no longer need.",
};

function storageSentence(capacity: PublicFormDeliveryHealth["capacity"]) {
  return `Messages are using ${capacity.usedPercent.toFixed(
    1,
  )}% of the room they have. ${roomLeft[capacity.state]}`;
}

/**
 * Settings' body below the page heading, in the order an Owner actually uses
 * it — Users, Connected agents, Connections, then Site details — with the
 * facts and recovery buttons nobody needs on an ordinary visit collapsed
 * into one "Technical detail" disclosure at the end (#150, ADR-0027).
 *
 * This is one client component, not a server page rendering separate client
 * islands, because the Users panel and the Technical detail retry buttons
 * share one human access mutation (`useHumanAccessMutation`): retrying
 * means replaying the exact same in-flight request, so the two pieces of UI
 * that show it cannot each own a separate copy of that state. A function
 * cannot cross from a Server Component into a Client Component as a prop,
 * so the page (`app/dash/settings/page.tsx`) loads the server data and
 * passes it here as plain values; this component calls the hook once and
 * lays out everything that depends on it.
 */
export function SettingsPageBody({
  members,
  mcpConnections,
  mutationToken,
  emailDelivery,
  publishing,
  senderDetails,
  definition,
  ownerNotificationHealth,
  failedDeliveries,
}: {
  members: ReadonlyArray<HumanMembership>;
  mcpConnections: ReadonlyArray<McpConnectionSummary>;
  mutationToken: string;
  emailDelivery: ConnectionReadiness | null;
  publishing: ConnectionReadiness | null;
  senderDetails: ConnectionReadiness | null;
  definition: SiteDefinition;
  ownerNotificationHealth: PublicFormDeliveryHealth;
  failedDeliveries: ReadonlyArray<FailedPublicFormDelivery>;
}) {
  const mutation = useHumanAccessMutation({ csrfToken: mutationToken });

  return (
    <>
      <section aria-labelledby="people">
        <h2 id="people">Users</h2>
        <p>
          Invites and access changes take effect the next time that person
          loads a page.
        </p>
        <MemberAccessPanel members={members} mutation={mutation} />
      </section>

      <section aria-labelledby="agents">
        <h2 id="agents">Connected agents</h2>
        <p>
          Each connection works only on this site, only with the permissions
          you approve, and you can revoke any of them on their own.
        </p>
        <p className="panel-actions">
          <a className="button button-primary" href="/dash/settings/connect-agent">
            Connect an agent
          </a>
        </p>
        <McpConnectionControls
          connections={mcpConnections}
          csrfToken={mutationToken}
        />
      </section>

      <section aria-labelledby="connections">
        <h2 id="connections">Connections</h2>
        <p>Whether email delivery and site publishing are connected.</p>
        <ConnectionStatus kind="email" readiness={emailDelivery} />
        <ConnectionStatus kind="publishing" readiness={publishing} />
      </section>

      <section aria-labelledby="sender-details">
        <h2 id="sender-details">Sender details</h2>
        <p>
          Every email must carry your name, your postal address, a way to
          contact you and a way to stop the emails. Foundry never writes these
          for you.
        </p>
        <ConnectionStatus kind="senderDetails" readiness={senderDetails} />
      </section>

      <SiteTechnicalDetail definition={definition} />

      <details className="technical-inventory">
        <summary>Technical detail</summary>
        <section aria-labelledby="email-alerts">
          <h3 id="email-alerts">Email alerts about new messages</h3>
          <p>
            Every message people send is saved in Messages. These alerts
            only tell you one arrived, so an alert that fails never loses a
            message.
          </p>
          <dl className="fact-list">
            <div>
              <dt>Can alerts be sent</dt>
              <dd>{ownerAlertSenderState(ownerNotificationHealth.adapter)}</dd>
            </div>
            <div>
              <dt>Waiting to send</dt>
              <dd>
                {ownerNotificationHealth.pending === 0 &&
                ownerNotificationHealth.processing === 0
                  ? "Nothing waiting"
                  : `${ownerNotificationHealth.pending} waiting · ${ownerNotificationHealth.processing} sending`}
              </dd>
            </div>
            <div>
              <dt>Did not arrive</dt>
              <dd>
                {ownerNotificationHealth.failed === 0
                  ? "None"
                  : `${ownerNotificationHealth.failed} after ${ownerNotificationHealth.retries} retries`}
              </dd>
            </div>
            <div>
              <dt>Longest wait</dt>
              <dd>
                {ownerNotificationHealth.oldestPendingAgeSeconds === null
                  ? "Nothing waiting"
                  : `${Math.ceil(
                      ownerNotificationHealth.oldestPendingAgeSeconds / 60,
                    )} minutes`}
              </dd>
            </div>
          </dl>
          <OwnerNotificationControls
            csrfToken={mutationToken}
            failedDeliveries={failedDeliveries}
          />
        </section>
        <section aria-labelledby="message-storage">
          <h3 id="message-storage">Room left for messages</h3>
          <p>{storageSentence(ownerNotificationHealth.capacity)}</p>
        </section>
        <AccessSyncRetryControls mutation={mutation} />
      </details>
    </>
  );
}
