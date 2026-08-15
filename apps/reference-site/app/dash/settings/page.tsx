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

      <section aria-labelledby="email-alerts" id="email-alerts">
        <h2 id="email-alerts">Email alerts about new messages</h2>
        <p>
          Every message people send is saved in Messages. These alerts only
          tell you one arrived, so a failed alert never loses a message.
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
          <div>
            <dt>Message storage used</dt>
            <dd>
              {emailAlerts.health.capacity.state} ·{" "}
              {emailAlerts.health.capacity.usedPercent.toFixed(1)}% of the
              limit
            </dd>
          </div>
        </dl>
        <OwnerNotificationControls
          csrfToken={mutationToken}
          failedDeliveries={emailAlerts.failedDeliveries}
        />
      </section>

      <SiteTechnicalDetail definition={definition} />
    </main>
  );
}
