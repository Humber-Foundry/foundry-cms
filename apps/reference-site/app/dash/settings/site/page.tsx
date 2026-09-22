import { ConnectionStatus } from "@/components/connection-status";
import { DashboardPageHeader } from "@/components/dashboard-page-header";
import { AccessSyncReconcileControls } from "@/components/member-access-controls";
import { SettingsTabs, settingsTab } from "@/components/settings-tabs";
import { SiteTechnicalDetail } from "@/components/site-technical-detail";
import { readContentPublicationReadiness } from "@/src/content-publication-runtime";
import { loadOwnerNotificationStatus } from "@/src/public-form-messages-runtime";
import { messageRoomSentence } from "@/src/message-room";
import {
  loadMutationToken,
  loadPublishedDefinition,
  requireAuthorizedSettingsAccess,
} from "@/src/settings-page-context";

export const dynamic = "force-dynamic";

/**
 * Settings' Site tab: publishing, room left for messages, how access reaches
 * Cloudflare, and the reference details about this installation.
 *
 * These are the facts an owner reads once and then leaves alone, so they are
 * the last tab rather than the long tail of one page (#240). The version
 * numbers and record identifiers stay inside a closed disclosure, as they
 * were.
 */
export default async function DashboardSettingsSitePage() {
  const access = await requireAuthorizedSettingsAccess();
  const definition = await loadPublishedDefinition();
  const mutationToken = await loadMutationToken();
  const publishing = await readContentPublicationReadiness();
  const ownerNotifications = await loadOwnerNotificationStatus(access);
  const tab = settingsTab("site");

  return (
    <main className="dashboard-main" id="main">
      <DashboardPageHeader title="Settings" description={tab.description} />
      <SettingsTabs current="site" />

      <section aria-labelledby="publishing">
        <h2 id="publishing">Publishing</h2>
        <p>Whether Foundry can put your changes on the live site.</p>
        <ConnectionStatus kind="publishing" readiness={publishing} />
      </section>

      <section aria-labelledby="message-storage">
        <h2 id="message-storage">Room left for messages</h2>
        <p>{messageRoomSentence(ownerNotifications.health.capacity)}</p>
      </section>

      <section aria-labelledby="access-sync">
        <h2 id="access-sync">Signing in</h2>
        <AccessSyncReconcileControls csrfToken={mutationToken} />
      </section>

      <SiteTechnicalDetail definition={definition} />
    </main>
  );
}
