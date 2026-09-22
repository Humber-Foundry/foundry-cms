import { DashboardPageHeader } from "@/components/dashboard-page-header";
import { McpConnectionControls } from "@/components/mcp-connection-controls";
import { SettingsTabs, settingsTab } from "@/components/settings-tabs";
import { loadMcpConnectionsForDashboard } from "@/src/mcp-dashboard-runtime";
import { loadMutationToken } from "@/src/dashboard-page-context";
import { requireAuthorizedSettingsAccess } from "@/src/settings-page-context";

export const dynamic = "force-dynamic";

/**
 * Settings' Connected agents tab: the agents that may work on this site.
 *
 * This section says "agent", not "app". Everywhere else the dashboard calls
 * the same thing an app; here and on the Connect an agent screen the owner's
 * own word for the thing they connect is "agent" (CONTEXT.md).
 */
export default async function DashboardSettingsAgentsPage() {
  await requireAuthorizedSettingsAccess();
  const mutationToken = await loadMutationToken();
  const mcpConnections = await loadMcpConnectionsForDashboard();
  const tab = settingsTab.agents;

  return (
    <main className="dashboard-main" id="main">
      <DashboardPageHeader title="Settings" description={tab.description} />
      <SettingsTabs current="agents" />

      <section aria-labelledby="agents">
        <h2 id="agents">Connected agents</h2>
        <p>
          Each connection works only on this site, only with the permissions
          you approve, and you can revoke any of them on their own.
        </p>
        <p className="panel-actions">
          <a
            className="dash-button dash-button-primary"
            href="/dash/settings/connect-agent"
          >
            Connect an agent
          </a>
        </p>
        <McpConnectionControls
          connections={mcpConnections}
          csrfToken={mutationToken}
        />
      </section>
    </main>
  );
}
