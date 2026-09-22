"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import type {
  BlogPostArtifactFingerprint,
  Campaign,
  CampaignRevision,
} from "@humber-foundry/application";
import type { BlogPost } from "@humber-foundry/site-definition";

import {
  campaignHref,
  newCampaignHref,
} from "./campaign-links";
import {
  campaignPreviewSrc,
  campaignStateLabels,
  refusalCodeOf,
  refusalMessage,
  readCampaignReadiness,
  sendCampaignCommand,
  type DeliveryReadiness,
  type PendingScheduleRequest,
} from "./campaign-operations";
import { ConnectionStatus } from "./connection-status";
import { formatLocalScheduleTime } from "./schedule-time-format";
import { formatDashboardMoment } from "../src/dashboard-time";

type CampaignListEntry = Readonly<{
  campaign: Campaign;
  revision: CampaignRevision;
}>;

/**
 * Every email this site has written, newest work first.
 *
 * This is where Newsletter opens, even on a site with no emails yet (#237).
 * Before, the writing box opened by itself on an empty site and hid the list,
 * the preview and the sending steps, so a site owner never saw that they were
 * there. Writing and sending now live on their own screens; this one lists
 * what exists and offers the way in.
 */
export function CampaignList({
  csrfToken,
  workspace,
  postSources,
  initialCampaigns,
  initialScheduleRequests,
}: {
  csrfToken: string;
  /** The workspace in the address, carried onto every link out of this screen. */
  workspace: string | null;
  postSources: ReadonlyArray<
    Readonly<{
      post: Pick<BlogPost, "id" | "title">;
      artifact: BlogPostArtifactFingerprint;
    }>
  >;
  initialCampaigns: ReadonlyArray<CampaignListEntry>;
  /**
   * The send-time requests an app has made that nobody has answered yet. The
   * screen shows each one on its own campaign row and offers a Decline. Only a
   * person answers a request: sending and scheduling stay the Owner's steps on
   * the campaign's own screen, and declining is this button. See ADR-0039.
   */
  initialScheduleRequests: ReadonlyArray<PendingScheduleRequest>;
}) {
  const router = useRouter();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [campaigns, setCampaigns] =
    useState<ReadonlyArray<CampaignListEntry>>(initialCampaigns);
  const [scheduleRequests, setScheduleRequests] =
    useState<ReadonlyArray<PendingScheduleRequest>>(initialScheduleRequests);
  // Whether the name and postal address for the bottom of every email are
  // set. Reported separately from the delivery secrets, because without them
  // an email cannot even be written.
  const [senderDetails, setSenderDetails] = useState<DeliveryReadiness | null>(
    null,
  );

  useEffect(() => {
    let current = true;
    void readCampaignReadiness().then((readiness) => {
      if (current && readiness !== null) setSenderDetails(readiness.senderDetails);
    });
    return () => {
      current = false;
    };
  }, []);

  // Every email carries a compliance footer built from the installation's own
  // name and postal address. Foundry never invents one, so while they are
  // absent the server refuses to write an email and the screen says so
  // instead of offering a step that always fails.
  const senderDetailsMissing = senderDetails?.state === "not_configured";

  async function reloadCampaigns() {
    const response = await fetch("/api/foundry-cms/campaigns", {
      cache: "no-store",
    });
    if (!response.ok) return;
    const body = (await response.json()) as {
      campaigns: ReadonlyArray<CampaignListEntry>;
      scheduleRequests?: ReadonlyArray<PendingScheduleRequest>;
    };
    setCampaigns(body.campaigns);
    setScheduleRequests(body.scheduleRequests ?? []);
  }

  /**
   * Say no to one send-time request an app made.
   *
   * Declining touches nothing else: no campaign, no approval and no send. It
   * only stops the request asking. The list is read back afterwards, so what
   * the screen shows is what the server holds. See ADR-0039.
   */
  async function declineScheduleRequest(proposalId: string) {
    setBusy(true);
    setMessage("");
    try {
      const response = await sendCampaignCommand(csrfToken, {
        action: "decline_schedule_request",
        proposalId,
      });
      if (!response.ok) {
        setMessage(refusalMessage(await refusalCodeOf(response)));
      }
      await reloadCampaigns();
    } finally {
      setBusy(false);
    }
  }

  /** Copy one blog post into a new email, then open that email's screen. */
  async function createFromPost(sourcePostRevisionId: string) {
    setBusy(true);
    setMessage("");
    try {
      const response = await sendCampaignCommand(csrfToken, {
        action: "create_from_post",
        sourcePostRevisionId,
      });
      if (!response.ok) {
        setMessage(refusalMessage(await refusalCodeOf(response)));
        return;
      }
      const body = (await response.json()) as { campaign: Campaign };
      router.push(campaignHref(body.campaign.id, workspace));
    } finally {
      setBusy(false);
    }
  }

  const newEmailButton = (
    <button
      type="button"
      className="button button-primary"
      disabled={busy || senderDetailsMissing}
      // A link cannot be turned off, and this control has to be off while the
      // sender details are missing, so it is a button that navigates.
      onClick={() => router.push(newCampaignHref(workspace))}
    >
      New email
    </button>
  );

  return (
    <section aria-labelledby="campaigns-heading">
      <div className="dashboard-section-heading">
        <div>
          <h2 id="campaigns-heading">Emails</h2>
          <p>
            Write an email to your subscribers. It stays a private draft here;
            subscriber identities are never shown.
          </p>
          <ConnectionStatus kind="senderDetails" readiness={senderDetails} />
        </div>
        {campaigns.length === 0 ? null : newEmailButton}
      </div>
      {campaigns.length === 0 ? (
        <div className="empty-state">
          <p>
            You have not written any emails yet. Write one, send yourself a
            test, then send it to your subscribers.
          </p>
          {newEmailButton}
        </div>
      ) : (
        <ul className="post-list">
          {campaigns.map(({ campaign, revision }) => {
            // The thumbnail shown beside a campaign is its share image,
            // falling back to the header image, so a preview surface always
            // shows a picture when the campaign has one.
            const thumbnail =
              revision.shareImage ?? revision.headerImage ?? null;
            const pendingRequest =
              scheduleRequests.find(
                (request) => request.campaignId === campaign.id,
              ) ?? null;
            return (
              <li key={campaign.id} id={`campaign-${campaign.id}`}>
                <div className="post-list-info">
                  <div className="post-list-summary">
                    {thumbnail === null ? null : (
                      <img
                        className="campaign-thumbnail"
                        src={campaignPreviewSrc(thumbnail.url)}
                        alt={thumbnail.alt}
                      />
                    )}
                    <strong>{revision.subject}</strong>
                    <span>
                      {campaignStateLabels[campaign.lifecycleState]} · last
                      changed {formatDashboardMoment(campaign.updatedAt)}
                    </span>
                  </div>
                  {pendingRequest === null ? null : (
                    <p className="composer-hint">
                      {pendingRequest.agentName} asked to send this at{" "}
                      {formatLocalScheduleTime(
                        pendingRequest.localDateTime,
                        pendingRequest.ianaTimeZone,
                      )}
                      . Open the email to send it then, or decline the request.
                    </p>
                  )}
                </div>
                <div className="post-list-actions">
                  {pendingRequest === null ? null : (
                    <button
                      type="button"
                      className="copy-button"
                      disabled={busy}
                      onClick={() => {
                        void declineScheduleRequest(pendingRequest.proposalId);
                      }}
                    >
                      Decline
                    </button>
                  )}
                  <a
                    className="copy-button"
                    href={campaignHref(campaign.id, workspace)}
                    aria-label={`Open ${revision.subject}`}
                  >
                    Open
                  </a>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {postSources.length === 0 ? null : (
        <form
          className="campaign-from-post"
          onSubmit={(event) => {
            event.preventDefault();
            const sourcePostRevisionId = String(
              new FormData(event.currentTarget).get("sourcePostRevisionId") ??
                "",
            );
            void createFromPost(sourcePostRevisionId);
          }}
        >
          <label>
            <span>Start from a blog post</span>
            <select
              name="sourcePostRevisionId"
              required
              disabled={busy || senderDetailsMissing}
            >
              {postSources.map(({ post, artifact }) => (
                <option
                  key={artifact.postRevisionId}
                  value={artifact.postRevisionId}
                >
                  {post.title}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            className="copy-button"
            disabled={busy || senderDetailsMissing}
          >
            Create email from post
          </button>
        </form>
      )}
      {message === "" ? null : <p role="status">{message}</p>}
    </section>
  );
}
