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
  campaignRowSummary,
  refusalCodeOf,
  refusalMessage,
  readCampaignList,
  sendCampaignCommand,
  type PendingScheduleRequest,
} from "./campaign-operations";
import { ConnectionStatus } from "./connection-status";
import { DashboardActionMenu } from "./dashboard-action-menu";
import { DashboardEmptyState } from "./dashboard-empty-state";
import { DashboardList, DashboardListRow } from "./dashboard-list";
import { DashboardPageHeader } from "./dashboard-page-header";
import { DashboardStateLabel } from "./dashboard-state-label";
import { formatLocalScheduleTime } from "./schedule-time-format";
import { useCampaignReadiness } from "./use-campaign-readiness";

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
  const { senderDetails, senderDetailsMissing } = useCampaignReadiness();

  useEffect(() => {
    let current = true;
    // An app can write a send-time request at any moment, and this list is the
    // only place a person can answer one. Reading the list when the screen
    // opens keeps what the owner sees equal to what the server holds, however
    // long the browser held the copy it was sent.
    void readCampaignList().then((list) => {
      if (current) showList(list);
    });
    return () => {
      current = false;
    };
  }, []);

  /** Draw the server's answer. A list that could not be read changes nothing. */
  function showList(list: Awaited<ReturnType<typeof readCampaignList>>) {
    if (list === null) return;
    setCampaigns(list.campaigns);
    setScheduleRequests(list.scheduleRequests);
  }

  async function reloadCampaigns() {
    showList(await readCampaignList());
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
      className="dash-button dash-button-primary"
      disabled={busy || senderDetailsMissing}
      // A link cannot be turned off, and this control has to be off while the
      // sender details are missing, so it is a button that navigates.
      onClick={() => router.push(newCampaignHref(workspace))}
    >
      New email
    </button>
  );

  return (
    <>
      <DashboardPageHeader
        title="Newsletter"
        description="Every email you have written. Open one to check it, send yourself a test, then send it. Only you can authorise a send to your whole list."
        // The empty state below offers the same control, so the screen never
        // shows two "New email" buttons.
        action={campaigns.length === 0 ? undefined : newEmailButton}
      />
      <section aria-label="Emails">
        <ConnectionStatus kind="senderDetails" readiness={senderDetails} />
        {campaigns.length === 0 ? (
          <DashboardEmptyState title="No emails yet" action={newEmailButton}>
            Write your first email, send yourself a test, then send it to your
            subscribers.
          </DashboardEmptyState>
        ) : (
          <DashboardList label="Your emails">
            {campaigns.map(({ campaign, revision }) => {
              const summary = campaignRowSummary(campaign);
              const pendingRequest =
                scheduleRequests.find(
                  (request) => request.campaignId === campaign.id,
                ) ?? null;
              return (
                <DashboardListRow
                  key={campaign.id}
                  href={campaignHref(campaign.id, workspace)}
                  title={revision.subject}
                  note={
                    pendingRequest === null
                      ? summary.date
                      : `${summary.date} · ${pendingRequest.agentName} asked to send this at ${formatLocalScheduleTime(
                          pendingRequest.localDateTime,
                          pendingRequest.ianaTimeZone,
                        )}`
                  }
                  state={
                    summary.label === "" ? undefined : (
                      <DashboardStateLabel tone="draft">
                        {summary.label}
                      </DashboardStateLabel>
                    )
                  }
                  // Only a row an app has asked to send carries an action, so
                  // this list does not hold the same shape on every row the
                  // way the shared standard asks for. Declining is the one
                  // answer this screen offers, and there is nothing to offer
                  // on a row nobody has asked about: the row itself opens the
                  // email, where every other step lives. See ADR-0039.
                  actions={
                    pendingRequest === null ? undefined : (
                      <DashboardActionMenu
                        label={`Actions for ${revision.subject}`}
                        actions={[
                          {
                            id: "decline",
                            label: "Decline the app's send request",
                            onSelect: () => {
                              void declineScheduleRequest(
                                pendingRequest.proposalId,
                              );
                            },
                          },
                        ]}
                      />
                    )
                  }
                />
              );
            })}
          </DashboardList>
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
            className="dash-button dash-button-plain"
            disabled={busy || senderDetailsMissing}
          >
            Create email from post
          </button>
        </form>
      )}
        {message === "" ? null : <p role="status">{message}</p>}
      </section>
    </>
  );
}
