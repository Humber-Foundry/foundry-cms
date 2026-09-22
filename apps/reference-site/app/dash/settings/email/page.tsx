import { headers } from "next/headers";

import { ConnectionStatus } from "@/components/connection-status";
import { DashboardPageHeader } from "@/components/dashboard-page-header";
import { OwnerNotificationControls } from "@/components/owner-notification-controls";
import { SenderDetailsForm } from "@/components/sender-details-form";
import { SettingsTabs, settingsTab } from "@/components/settings-tabs";
import {
  loadCampaignRequestContext,
  readCampaignDeliveryReadiness,
} from "@/src/campaign-runtime";
import { ownerAlertSenderState } from "@/src/owner-alert-status";
import { loadOwnerNotificationStatus } from "@/src/public-form-messages-runtime";
import { loadSenderDetailsForEditing } from "@/src/sender-details-runtime";
import { requireAuthorizedSettingsAccess } from "@/src/settings-page-context";
import { senderDetailsStateSentence } from "@/src/site-sender-details";
import { loadMutationToken } from "@/src/dashboard-page-context";

export const dynamic = "force-dynamic";

/**
 * Settings' Email tab: whether email can be sent, what every email says at the
 * bottom, and the alerts that tell the owner a message arrived.
 *
 * The sender details are edited here rather than read here. They used to be
 * settings only whoever installed the site could change, which left an owner
 * reading that they were missing with nothing he could do about it (#240,
 * ADR-0048).
 */
export default async function DashboardSettingsEmailPage() {
  const access = await requireAuthorizedSettingsAccess();
  const mutationToken = await loadMutationToken();
  const ownerNotifications = await loadOwnerNotificationStatus(access);
  const campaignContext = await loadCampaignRequestContext(await headers());
  const emailDelivery = await readCampaignDeliveryReadiness(campaignContext);
  const senderDetails = await loadSenderDetailsForEditing();
  const tab = settingsTab.email;
  const health = ownerNotifications.health;
  // What the send itself answers. It covers the two settings the Owner does
  // not edit here, so the state line below never says the details are set
  // while a campaign would still be refused.
  const sendGateOpen = campaignContext.senderDetails.state !== "not_configured";
  const senderDetailsReady =
    senderDetails.problems.length === 0 && sendGateOpen;

  return (
    <main className="dashboard-main" id="main">
      <DashboardPageHeader title="Settings" description={tab.description} />
      <SettingsTabs current="email" />

      <section aria-labelledby="email-connection">
        <h2 id="email-connection">Sending email</h2>
        <p>Whether Foundry can reach the service that sends your email.</p>
        <ConnectionStatus kind="email" readiness={emailDelivery} />
      </section>

      <section aria-labelledby="sender-details">
        <h2 id="sender-details">What every email says at the bottom</h2>
        <p>
          Every email must carry your name, your postal address, a way to
          contact you and a way to stop the emails. Foundry never writes these
          for you. A campaign cannot be written or sent until the name and the
          postal address are here.
        </p>
        <p
          className={
            senderDetailsReady
              ? "connection-status connection-status-connected"
              : "connection-status connection-status-missing"
          }
          role={senderDetailsReady ? undefined : "alert"}
        >
          {senderDetailsStateSentence(senderDetails.problems, sendGateOpen)}
        </p>
        <SenderDetailsForm
          values={senderDetails.values}
          stored={senderDetails.stored}
          editable={senderDetails.editable}
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
            <dt>Can alerts be sent</dt>
            <dd>{ownerAlertSenderState(health.adapter)}</dd>
          </div>
          <div>
            <dt>Waiting to send</dt>
            <dd>
              {health.pending === 0 && health.processing === 0
                ? "Nothing waiting"
                : `${health.pending} waiting · ${health.processing} sending`}
            </dd>
          </div>
          <div>
            <dt>Did not arrive</dt>
            <dd>
              {health.failed === 0
                ? "None"
                : `${health.failed} after ${health.retries} retries`}
            </dd>
          </div>
          <div>
            <dt>Longest wait</dt>
            <dd>
              {health.oldestPendingAgeSeconds === null
                ? "Nothing waiting"
                : `${Math.ceil(health.oldestPendingAgeSeconds / 60)} minutes`}
            </dd>
          </div>
        </dl>
        <OwnerNotificationControls
          csrfToken={mutationToken}
          failedDeliveries={ownerNotifications.failedDeliveries}
        />
      </section>
    </main>
  );
}
