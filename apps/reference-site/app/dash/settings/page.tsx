import { headers } from "next/headers";
import { notFound } from "next/navigation";

import { SettingsPageBody } from "@/components/settings-page-body";
import {
  loadCampaignRequestContext,
  readCampaignDeliveryReadiness,
} from "@/src/campaign-runtime";
import { readContentPublicationReadiness } from "@/src/content-publication-runtime";
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
 *
 * This page only loads the server data; `SettingsPageBody` (a Client
 * Component) lays it out. See that component's doc comment for why: the
 * Users panel and the Technical detail retry buttons share one human access
 * mutation, and a hook can only run inside one client component (#150,
 * ADR-0027).
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
  const ownerNotifications = await loadOwnerNotificationStatus(access);
  const campaignContext = await loadCampaignRequestContext(await headers());
  const emailDelivery = await readCampaignDeliveryReadiness(campaignContext);
  const publishing = await readContentPublicationReadiness();

  return (
    <main className="dashboard-main" id="main">
      <div className="page-heading">
        <div>
          <h1>Settings</h1>
          <p>Who can sign in, which agents are connected, and site details.</p>
        </div>
      </div>

      <SettingsPageBody
        members={members}
        mcpConnections={mcpConnections}
        mutationToken={mutationToken}
        emailDelivery={emailDelivery}
        publishing={publishing}
        senderDetails={campaignContext.senderDetails}
        definition={definition}
        ownerNotificationHealth={ownerNotifications.health}
        failedDeliveries={ownerNotifications.failedDeliveries}
      />
    </main>
  );
}
