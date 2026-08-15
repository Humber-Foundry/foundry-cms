import { notFound } from "next/navigation";

import { McpConnectionControls } from "@/components/mcp-connection-controls";
import { MemberAccessControls } from "@/components/member-access-controls";
import { OwnerNotificationControls } from "@/components/owner-notification-controls";
import { SiteTechnicalDetail } from "@/components/site-technical-detail";
import { loadMcpConnectionsForDashboard } from "@/src/mcp-dashboard-runtime";
import { loadOwnerNotificationStatus } from "@/src/public-form-messages-runtime";
import {
  loadMutationToken,
  loadPublishedDefinition,
  requireAuthorizedDashboardAccess,
} from "@/src/dashboard-page-context";

export const dynamic = "force-dynamic";

/**
 * How full the message store is, in words rather than a state name. The
 * percentage is kept because it is the only number that says how much room is
 * left.
 */
function storageSentence(
  capacity: Readonly<{ usedPercent: number; state: string }>,
) {
  const used = `Messages are using ${capacity.usedPercent.toFixed(1)}% of the room they have.`;
  if (capacity.state === "critical") {
    return `${used} There is very little left. Erase messages you no longer need.`;
  }
  if (capacity.state === "warning") {
    return `${used} It is getting full, so plan what to keep.`;
  }
  return `${used} There is plenty of room.`;
}

/**
 * Settings holds the jobs an owner does rarely: who can sign in, which agents
 * are connected, and the technical record of the installation. Keeping them
 * here is what lets the editing destinations stay about editing.
 */
export default async function DashboardSettingsPage() {
  const access = await requireAuthorizedDashboardAccess();
  if (access.membership.role !== "owner") {
    notFound();
  }

  const definition = await loadPublishedDefinition();
  const mutationToken = await loadMutationToken();
  const members = await access.application.queries.listMembers({
    actor: access.identity,
  });
  const mcpConnections = await loadMcpConnectionsForDashboard();
  const emailAlerts = await loadOwnerNotificationStatus(access);

  return (
    <main className="dashboard-main" id="main">
      <div className="page-heading">
        <div>
          <h1>Settings</h1>
          <p>Who can sign in, which agents are connected, and site details.</p>
        </div>
      </div>

      <section aria-labelledby="people">
        <h2 id="people">People</h2>
        <p>
          Invitations and membership changes take effect the next time that
          person loads a page.
        </p>
        <MemberAccessControls csrfToken={mutationToken} members={members} />
      </section>

      <section aria-labelledby="agents">
        <h2 id="agents">Connected agents</h2>
        <p>
          Each connection works only on this site, only with the permissions you
          approve, and you can revoke any of them on their own.
        </p>
        <McpConnectionControls
          connections={mcpConnections}
          csrfToken={mutationToken}
        />
      </section>

      <section aria-labelledby="email-alerts">
        <h2 id="email-alerts">Email alerts about new messages</h2>
        <p>
          Every message people send is saved in Messages. These alerts only
          tell you one arrived, so an alert that fails never loses a message.
        </p>
        <dl className="fact-list">
          <div>
            <dt>Waiting to send</dt>
            <dd>
              {emailAlerts.health.pending === 0 &&
              emailAlerts.health.processing === 0
                ? "Nothing waiting"
                : `${emailAlerts.health.pending} waiting · ${emailAlerts.health.processing} sending`}
            </dd>
          </div>
          <div>
            <dt>Did not arrive</dt>
            <dd>
              {emailAlerts.health.failed === 0
                ? "None"
                : `${emailAlerts.health.failed} after ${emailAlerts.health.retries} retries`}
            </dd>
          </div>
          <div>
            <dt>Longest wait</dt>
            <dd>
              {emailAlerts.health.oldestPendingAgeSeconds === null
                ? "Nothing waiting"
                : `${Math.ceil(
                    emailAlerts.health.oldestPendingAgeSeconds / 60,
                  )} minutes`}
            </dd>
          </div>
        </dl>
        <OwnerNotificationControls
          csrfToken={mutationToken}
          failedDeliveries={emailAlerts.failedDeliveries}
        />
      </section>

      <section aria-labelledby="message-storage">
        <h2 id="message-storage">Room left for messages</h2>
        <p>{storageSentence(emailAlerts.health.capacity)}</p>
      </section>

      <SiteTechnicalDetail definition={definition} />
    </main>
  );
}
