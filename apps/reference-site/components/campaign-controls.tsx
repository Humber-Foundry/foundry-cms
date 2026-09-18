"use client";

import { useCallback, useEffect, useState } from "react";

import {
  type BlogPostArtifactFingerprint,
  type Campaign,
  type CampaignBulkStateReport,
  type CampaignId,
  type CampaignLifecycleState,
  type CampaignRevision,
  type CampaignTestDeliveryApplication,
  type CampaignTestDeliveryEvidence,
  type HumanRole,
  type RenderedCampaign,
} from "@humber-foundry/application";
import {
  mediaAssetIdFromImageAddress,
  mediaImageSrc,
  parseSerializedRichTextDocument,
  seoFieldHints,
  serializeRichTextDocument,
  toSeoShareImage,
  type RichTextDocument,
  type SerializedRichTextDocument,
  type BlogPost,
} from "@humber-foundry/site-definition";

import { RichTextEditor } from "./rich-text-editor";
import { RichTextRenderer } from "./rich-text-renderer";
import { ChangePhotoField, type EditorMediaContext } from "./change-photo-field";
import { ComposerActions, emptyRichTextBody } from "./composer";
import { ConnectionStatus } from "./connection-status";
import {
  browserTimeZone,
  resolveSendTime,
  type SendTime,
} from "./schedule-send-time";
// Type only — erased at compile, so the server-only module is never bundled
// into this client component.
import type { SiteImageTile } from "../src/site-used-photos";

/**
 * The address the dashboard preview draws for one campaign image. A campaign
 * stores each image as an absolute address so the sent email can load it. A
 * gallery photo's address is the site's own `/api/media/<assetId>` route made
 * absolute; the preview draws it by its same-origin path so it loads while the
 * dashboard runs on any host. An external picture is drawn as written.
 */
function campaignPreviewSrc(url: string): string {
  const assetId = mediaAssetIdFromImageAddress(url);
  return assetId === null ? url : mediaImageSrc(assetId);
}

/** The email body with every image address drawn by its same-origin path. */
function previewEmailContent(document: RichTextDocument): RichTextDocument {
  return {
    ...document,
    children: document.children.map((block) =>
      block.type === "image"
        ? { ...block, src: campaignPreviewSrc(block.src) }
        : block,
    ),
  };
}

/**
 * Plain words for a campaign's lifecycle state. Typed by the union rather
 * than by string, so adding a state to CampaignLifecycleState fails the build
 * here until it has a label, instead of falling through to a generated one.
 */
const campaignStateLabels: Readonly<Record<CampaignLifecycleState, string>> = {
  draft: "Draft",
};

/** What per-campaign test readiness reports, as the server returns it. */
type CampaignTestReadiness = Awaited<
  ReturnType<CampaignTestDeliveryApplication["queries"]["readiness"]>
>;

/**
 * Everything the server reports about one campaign's progress towards a send.
 *
 * The screen states a step from these values and nothing else. It never
 * remembers that a command succeeded and draws a step from that memory: after
 * every command the whole report is read again, so what a person sees is what
 * the server holds.
 */
type CampaignSendReport = Readonly<{
  rendered: RenderedCampaign;
  testEvidence: CampaignTestDeliveryEvidence | null;
  testReadiness: CampaignTestReadiness;
  bulkState: CampaignBulkStateReport;
  testRecipients: Readonly<{
    ids: ReadonlyArray<string>;
    yours: string | null;
  }>;
}>;

/**
 * Whether this installation has email delivery connected. This is the same
 * shape the campaigns API returns from `readCampaignDeliveryReadiness`
 * (`campaign-runtime.ts`); it also carries `providerHealth`, which this
 * screen does not read.
 */
type DeliveryReadiness = Readonly<{
  state: "connected" | "not_configured" | "local_development";
  missingSettings: ReadonlyArray<string>;
  setupGuide: string;
}>;

/**
 * Plain words for the reason codes these steps can be refused with.
 *
 * A refusal always shows the server's own code as well, because the person
 * who has to fix it needs the exact reason and that code is the stable name
 * for it. The sentence is what the site owner reads; the code is the detail
 * underneath.
 */
const refusalSentences: Readonly<Record<string, string>> = {
  delivery_not_configured:
    "Email is not connected yet, so nothing can be sent or tested.",
  bulk_owner_required: "Only the site owner can do this step.",
  not_authorized: "You do not have permission to do this step.",
  bulk_test_required: "Send a test first.",
  bulk_test_stale:
    "The email changed after that test, so the test no longer counts. " +
    "Send a new test.",
  bulk_test_not_reviewed:
    "Confirm that the test arrived and looks right first.",
  bulk_authorization_stale:
    "The approval no longer matches this email. Send a new test and " +
    "approve it again.",
  bulk_authorization_exists: "This email is already approved for sending.",
  bulk_send_already_exists: "This email has already been sent once.",
  bulk_schedule_already_exists: "This email is already set to send.",
  bulk_schedule_not_cancellable:
    "It is too late to call this send off from here.",
  bulk_schedule_time_invalid: "That time cannot be used. Pick another time.",
  bulk_schedule_time_mismatch:
    "That time did not match the calendar. Pick it again.",
  test_recipient_forbidden:
    "There is no verified test address on file for you.",
  test_delivery_rate_limited:
    "Too many tests were sent in the last hour. Wait, then try again.",
  test_delivery_in_progress: "A test is already on its way.",
  provider_unhealthy:
    "The email provider is not answering. Try again in a few minutes.",
  campaign_revision_conflict:
    "Someone else changed this email. Reload the page and look again.",
};

function refusalSentence(code: string): string {
  return (
    refusalSentences[code] ??
    "That step did not go through. Nothing was sent."
  );
}

/**
 * Whether the delivered test covers exactly what the email says now.
 *
 * Two separate server facts have to agree. The test must have been delivered
 * for the fingerprint the current content renders to, and per-campaign
 * readiness must report the Owner's confirmation. Editing the email changes
 * the fingerprint, so an earlier test stops counting the moment it is saved —
 * the same rule the server applies before it will approve a send.
 */
function testCoversCurrentEmail(report: CampaignSendReport): boolean {
  return (
    report.testEvidence !== null &&
    report.testEvidence.campaignFingerprint ===
      report.rendered.campaignFingerprint
  );
}

function testConfirmed(report: CampaignSendReport): boolean {
  return testCoversCurrentEmail(report) && report.testReadiness.state === "ready";
}

/**
 * Every command the sending steps can send.
 *
 * Naming them is what keeps a step from sending a shape the route will refuse:
 * a missing or misspelt field fails the build here rather than returning a
 * refusal to the person who pressed the button.
 */
type SendFlowCommand =
  | Readonly<{
      action: "request_test";
      campaignId: CampaignId;
      testRecipientIds: ReadonlyArray<string>;
    }>
  | Readonly<{ action: "confirm_test_receipt"; executionId: string }>
  | Readonly<{
      action: "authorize_bulk";
      campaignId: CampaignId;
      testExecutionId: string;
    }>
  | Readonly<{
      action: "activate_bulk_schedule";
      campaignId: CampaignId;
      authorizationId: string;
      resolvedTime: SendTime;
    }>
  | Readonly<{ action: "cancel_bulk_schedule"; scheduleId: string }>
  | Readonly<{
      action: "send_bulk_now";
      campaignId: CampaignId;
      authorizationId: string;
    }>
  | Readonly<{
      action: "retry_bulk_send";
      campaignId: CampaignId;
      operationId: string;
    }>;

/** One step in the list, with what it still needs and what to do about it. */
function SendStep({
  number,
  name,
  state,
  need,
  children,
}: {
  number: number;
  name: string;
  state: "done" | "now" | "later";
  need: string;
  children?: React.ReactNode;
}) {
  return (
    <li className="send-step" data-state={state}>
      <p className="send-step-name">
        {number}. {name}
      </p>
      <p className="send-step-need">{need}</p>
      {children}
    </li>
  );
}

/**
 * The form for one email: a subject, the email itself, and the inbox
 * details below it. Used both for a new email and for editing a saved one;
 * the key on the caller resets the fields when the saved revision changes.
 */
function EmailComposer({
  heading,
  initialRevision,
  media,
  busy,
  saveLabel,
  onSave,
  onCancel,
}: {
  heading: string;
  initialRevision?: CampaignRevision;
  media: EditorMediaContext;
  busy: boolean;
  saveLabel: string;
  onSave(email: {
    subject: string;
    previewText: string;
    headerImage: CampaignRevision["headerImage"];
    shareImage: CampaignRevision["shareImage"];
    callToAction: { label: string; href: string };
    emailContent: SerializedRichTextDocument;
  }): void;
  onCancel?(): void;
}) {
  const [subject, setSubject] = useState(initialRevision?.subject ?? "");
  const [previewText, setPreviewText] = useState(
    initialRevision?.previewText ?? "",
  );
  const [ctaLabel, setCtaLabel] = useState(
    initialRevision?.callToAction.label ?? "",
  );
  const [ctaHref, setCtaHref] = useState(
    initialRevision?.callToAction.href ?? "",
  );
  const [headerImageUrl, setHeaderImageUrl] = useState(
    initialRevision?.headerImage?.url ?? "",
  );
  const [headerImageAlt, setHeaderImageAlt] = useState(
    initialRevision?.headerImage?.alt ?? "",
  );
  const [shareImageUrl, setShareImageUrl] = useState(
    initialRevision?.shareImage?.url ?? "",
  );
  const [shareImageAlt, setShareImageAlt] = useState(
    initialRevision?.shareImage?.alt ?? "",
  );
  const [content, setContent] = useState<SerializedRichTextDocument>(() =>
    initialRevision === undefined
      ? emptyRichTextBody()
      : serializeRichTextDocument(initialRevision.emailContent),
  );
  const [contentInvalid, setContentInvalid] = useState(false);

  return (
    <form
      className="composer"
      aria-label={heading}
      onSubmit={(event) => {
        event.preventDefault();
        onSave({
          subject: subject.trim(),
          previewText: previewText.trim(),
          headerImage: toSeoShareImage(headerImageUrl, headerImageAlt),
          shareImage: toSeoShareImage(shareImageUrl, shareImageAlt),
          callToAction: { label: ctaLabel.trim(), href: ctaHref.trim() },
          emailContent: content,
        });
      }}
    >
      <label className="composer-title">
        <span>Subject</span>
        <input
          name="subject"
          required
          maxLength={200}
          placeholder="Email subject"
          value={subject}
          onChange={(event) => setSubject(event.target.value)}
        />
      </label>
      <div className="composer-main-image">
        <ChangePhotoField
          label="Header image — shown at the top of the email"
          value={headerImageUrl}
          onChange={setHeaderImageUrl}
          media={media}
        />
        <label>
          <span>Header image description</span>
          <small className="composer-hint">
            Describe the picture for people who cannot see it.
          </small>
          <input
            name="headerImageAlt"
            maxLength={300}
            value={headerImageAlt}
            onChange={(event) => setHeaderImageAlt(event.target.value)}
          />
        </label>
      </div>
      <RichTextEditor
        id="campaign-email-content"
        label="Email body"
        describedBy="campaign-email-content-hint"
        value={content}
        disabled={busy}
        invalid={contentInvalid}
        media={media}
        onChange={setContent}
        onValidationChange={setContentInvalid}
      />
      <p className="composer-hint" id="campaign-email-content-hint">
        Write the email here. Use the buttons above for headings, links and
        photos. Formatting is kept exactly as you set it.
      </p>
      <div className="composer-settings-open">
        {/*
          The same SEO and sharing block the page and post editors show, named
          in the words an email uses. The subject above is this campaign's
          title, so the section holds the two lines below it and the picture.
        */}
        <fieldset className="composer-section">
          <legend>SEO and sharing — how this email looks in an inbox</legend>
          <p className="composer-section-heading" aria-hidden="true">
            SEO and sharing — how this email looks in an inbox
          </p>
          <p className="composer-hint">
            The subject above is the first line an inbox shows.
          </p>
          <label>
            <span>Preview line — shown after the subject in inboxes</span>
            <textarea
              name="previewText"
              required
              maxLength={1000}
              value={previewText}
              onChange={(event) => setPreviewText(event.target.value)}
            />
          </label>
          <ChangePhotoField
            label="Share image — shown where this email is previewed or shared"
            value={shareImageUrl}
            onChange={setShareImageUrl}
            media={media}
          />
          <p className="composer-hint">
            Leave blank to use the header image.
          </p>
          <label>
            <span>Share image description</span>
            <small className="composer-hint">
              {seoFieldHints.shareImageAlt}
            </small>
            <input
              name="shareImageAlt"
              maxLength={300}
              value={shareImageAlt}
              onChange={(event) => setShareImageAlt(event.target.value)}
            />
          </label>
        </fieldset>
        <label>
          <span>Button label</span>
          <input
            name="callToActionLabel"
            required
            maxLength={200}
            placeholder="Read the post"
            value={ctaLabel}
            onChange={(event) => setCtaLabel(event.target.value)}
          />
        </label>
        <label>
          <span>Button link</span>
          <input
            name="callToActionHref"
            required
            type="url"
            placeholder="https://…"
            value={ctaHref}
            onChange={(event) => setCtaHref(event.target.value)}
          />
        </label>
      </div>
      <ComposerActions
        busy={busy}
        saveLabel={saveLabel}
        blocked={contentInvalid}
        onCancel={onCancel}
      />
    </form>
  );
}

/**
 * The four steps between a written email and a sent one.
 *
 * Every step reads its state from the server's own report. The send steps stay
 * shut until the server says a test of this exact email was delivered and the
 * Owner confirmed it arrived, which is the same rule the server applies to the
 * commands themselves. Nothing here decides that a step is done.
 *
 * Confirming a test and sending are the Owner's steps. That is not a choice
 * made here: the server grants `campaign.test.confirm` and bulk sending to an
 * Owner only, so an Editor is told plainly whose step it is.
 */
function CampaignSendFlow({
  report,
  delivery,
  role,
  busy,
  onCommand,
  onEdit,
}: {
  report: CampaignSendReport;
  delivery: DeliveryReadiness | null;
  role: HumanRole;
  busy: boolean;
  onCommand(command: SendFlowCommand): void;
  onEdit(): void;
}) {
  const [reviewed, setReviewed] = useState(false);
  const [sendAt, setSendAt] = useState("");
  const [timeProblem, setTimeProblem] = useState("");

  const campaignId = report.rendered.campaignId;
  // The one delivered test the server named. Both the confirmation and the
  // approval act on this exact execution, never on a test chosen here.
  const testEvidence = report.testEvidence;
  const notConnected = delivery?.state === "not_configured";
  const tested = testCoversCurrentEmail(report);
  const confirmed = testConfirmed(report);
  const isOwner = role === "owner";
  const { authorization, schedule, sendOperation } = report.bulkState;
  const testRecipientIds =
    report.testRecipients.yours === null
      ? report.testRecipients.ids
      : [report.testRecipients.yours];
  const testStaleAfterEdit = report.testEvidence !== null && !tested;

  function testNeed(): string {
    if (notConnected) {
      return (
        "Email is not connected yet, so no test can go out. Someone with " +
        "access to the site's settings has to finish connecting it."
      );
    }
    if (testStaleAfterEdit) {
      return (
        "You changed the email after the last test, so that test no longer " +
        "counts. Send a new one."
      );
    }
    if (tested) return "A test of this exact email was delivered.";
    if (report.testReadiness.state === "evaluation_only") {
      return "This site is not set up yet to send to a real address.";
    }
    if (report.testReadiness.state === "provider_unhealthy") {
      return "The email provider is not answering right now.";
    }
    // Only a site owner holds a verified test address, so an Editor's test
    // lands in the owner's inbox. Say so rather than promising a copy that
    // never arrives.
    return report.testRecipients.yours === null
      ? "Send a test to the site owner's verified address. They read it."
      : "Send a test to your own verified address, then read it.";
  }

  function confirmNeed(): string {
    if (confirmed) return "You confirmed the test arrived and looked right.";
    if (!isOwner) {
      return (
        "The site owner has to confirm the test arrived. Ask them to check " +
        "their inbox and confirm it."
      );
    }
    if (!tested) return "Send a test first, then read the one that arrives.";
    return "Open the test email in your inbox and read it right through.";
  }

  /**
   * What the send step is on, decided once and used for both the sentence and
   * the controls.
   *
   * A send operation or an active schedule is reported before anything else,
   * because the server still holds it. Editing the email invalidates the
   * approval, and if the screen tested the approval first, the edit would hide
   * the very controls that call a scheduled send off or retry a failed one.
   */
  function sendStage() {
    if (sendOperation !== null) {
      if (sendOperation.state === "sent") return "sent" as const;
      if (sendOperation.state === "ambiguous") return "uncertain" as const;
      return sendOperation.state === "failed" ||
        sendOperation.state === "blocked"
        ? ("failed" as const)
        : ("sending" as const);
    }
    if (schedule !== null) return "scheduled" as const;
    // Whose step it is comes after what is true. An Editor who cannot act
    // still has to read what this campaign is doing.
    if (!isOwner) return "not_yours" as const;
    if (notConnected) return "not_connected" as const;
    if (!confirmed) return "needs_test" as const;
    return authorization === null
      ? ("needs_approval" as const)
      : ("ready" as const);
  }

  const stage = sendStage();

  /**
   * The shared connection-status line: whether email is connected, which
   * settings are missing, and where the setup steps are written down.
   */
  const setupGuideNote =
    notConnected && delivery !== null ? (
      <ConnectionStatus kind="email" readiness={delivery} />
    ) : null;

  const sendNeeds: Readonly<Record<ReturnType<typeof sendStage>, string>> = {
    not_yours:
      "Only the site owner can send an email to subscribers. Ask them to " +
      "finish this step.",
    sent: `Sent to ${sendOperation?.recipientCount ?? 0} people.`,
    failed:
      "The send did not finish. Nobody else will be sent to until you try " +
      "again.",
    sending: "The send is under way.",
    // The provider gave an answer nobody can act on. Sending again could
    // deliver the email twice, so this offers no retry until the provider's
    // own record has been read back.
    uncertain:
      "The email provider's answer was uncertain, so nobody knows yet " +
      "whether this went out. Do not send it again. It is being checked " +
      "against the provider's own record.",
    scheduled: "This email is set to send at the time below.",
    not_connected:
      "Email is not connected yet, so nothing can be sent from here. Step 2 " +
      "says where the steps to connect it are written down.",
    needs_test: "Send a test and confirm it arrived first.",
    needs_approval: "Approve this email, then send it now or pick a time.",
    ready: "Send it now, or pick a time to send it.",
  };

  function sendStepState(): "done" | "now" | "later" {
    if (stage === "sent") return "done";
    return stage === "not_yours" ||
      stage === "needs_test" ||
      stage === "not_connected"
      ? "later"
      : "now";
  }

  function scheduleThisEmail() {
    if (authorization === null) return;
    const resolved = resolveSendTime({
      chosenDateTime: sendAt,
      ianaTimeZone: browserTimeZone(),
      now: new Date(),
    });
    if (resolved.outcome !== "resolved") {
      setTimeProblem(
        resolved.outcome === "already_past"
          ? "That time has already passed. Pick a later one."
          : resolved.outcome === "no_such_time"
            ? "The clocks change that morning, so that time does not exist. Pick another."
            : resolved.outcome === "unknown_time_zone"
              ? "This browser could not read your time zone."
              : "Pick a date and a time.",
      );
      return;
    }
    setTimeProblem("");
    onCommand({
      action: "activate_bulk_schedule",
      campaignId,
      authorizationId: authorization.id,
      resolvedTime: resolved.time,
    });
  }

  return (
    <section className="send-flow" aria-label="Sending steps">
      <h3>Sending steps</h3>
      <ol className="send-flow-steps">
        <SendStep
          number={1}
          name="Write the email"
          state="done"
          need="Saved. You can keep changing it until a test is confirmed."
        >
          <button
            type="button"
            className="copy-button"
            disabled={busy}
            onClick={onEdit}
          >
            Change the email
          </button>
        </SendStep>

        <SendStep
          number={2}
          name={
            report.testRecipients.yours === null
              ? "Send a test to the site owner"
              : "Send a test to yourself"
          }
          state={tested ? "done" : "now"}
          need={testNeed()}
        >
          {tested ? null : (
            <button
              type="button"
              className="copy-button"
              disabled={busy || notConnected || testRecipientIds.length === 0}
              onClick={() =>
                onCommand({
                  action: "request_test",
                  campaignId,
                  testRecipientIds,
                })
              }
            >
              Send a test email
            </button>
          )}
          {setupGuideNote}
          {notConnected || testRecipientIds.length > 0 ? null : (
            <p className="send-step-need">
              There is no verified test address on file, so a test cannot go
              out.
            </p>
          )}
        </SendStep>

        <SendStep
          number={3}
          name="Confirm the test arrived"
          state={confirmed ? "done" : tested && isOwner ? "now" : "later"}
          need={confirmNeed()}
        >
          {confirmed || !tested || !isOwner || testEvidence === null ? null : (
            <div className="send-step-confirm">
              <label className="send-step-check">
                <input
                  type="checkbox"
                  checked={reviewed}
                  disabled={busy}
                  onChange={(event) => setReviewed(event.target.checked)}
                />
                <span>I opened the test email and it reads right.</span>
              </label>
              <button
                type="button"
                className="copy-button"
                disabled={busy || !reviewed}
                onClick={() =>
                  onCommand({
                    action: "confirm_test_receipt",
                    // The server named this exact delivered test. Confirming
                    // any other one would approve content nobody read.
                    executionId: testEvidence.executionId,
                  })
                }
              >
                Confirm the test arrived
              </button>
            </div>
          )}
        </SendStep>

        <SendStep
          number={4}
          name="Send it, or pick a time"
          state={sendStepState()}
          need={sendNeeds[stage]}
        >
          {/*
            An Editor reads the state but is offered no control, because only
            an Owner may send, schedule, cancel or retry. The server refuses
            them either way; showing a button an Editor cannot use would only
            promise something this screen cannot deliver.
          */}
          {!isOwner ? (
            <p className="send-step-reason">
              Only the site owner can start, change or call off a send.
            </p>
          ) : null}
          {sendOperation !== null ? (
            <div className="send-step-outcome">
              {sendOperation.detail === null ? null : (
                <p className="send-step-reason">Reason: {sendOperation.detail}</p>
              )}
              <p className="send-step-reason">
                Attempt {sendOperation.attempt}, last changed{" "}
                {sendOperation.updatedAt.replace("T", " at ").slice(0, 19)}.
              </p>
              {stage === "failed" && isOwner ? (
                <button
                  type="button"
                  className="copy-button"
                  // Retrying reaches the provider, so it needs a connected
                  // installation. Calling a send off does not, which is why
                  // the schedule below stays cancellable either way.
                  disabled={busy || notConnected}
                  onClick={() =>
                    onCommand({
                      action: "retry_bulk_send",
                      campaignId,
                      operationId: sendOperation.id,
                    })
                  }
                >
                  Try the send again
                </button>
              ) : null}
            </div>
          ) : schedule !== null ? (
            <div className="send-step-outcome">
              <p className="send-step-need">
                Set to send on {schedule.localDateTime.replace("T", " at ")} (
                {schedule.ianaTimeZone}).
              </p>
              {confirmed ? null : (
                <p className="send-step-reason">
                  You changed the email after this send was set up. Call it off
                  if you do not want the earlier version to go out.
                </p>
              )}
              {isOwner ? (
                <button
                  type="button"
                  className="copy-button"
                  onClick={() =>
                    onCommand({
                      action: "cancel_bulk_schedule",
                      scheduleId: schedule.id,
                    })
                  }
                  disabled={busy}
                >
                  Call this send off
                </button>
              ) : null}
            </div>
          ) : stage === "not_yours" ||
            stage === "needs_test" ||
            stage === "not_connected" ? (
            setupGuideNote
          ) : stage === "needs_approval" ? (
            testEvidence === null ? null : (
              <button
                type="button"
                className="button button-primary"
                disabled={busy || notConnected}
                onClick={() =>
                  onCommand({
                    action: "authorize_bulk",
                    campaignId,
                    testExecutionId: testEvidence.executionId,
                  })
                }
              >
                Approve this email for sending
              </button>
            )
          ) : authorization === null ? null : (
            <div className="send-step-outcome">
              <button
                type="button"
                className="button button-primary"
                disabled={busy || notConnected}
                onClick={() =>
                  onCommand({
                    action: "send_bulk_now",
                    campaignId,
                    authorizationId: authorization.id,
                  })
                }
              >
                Send it now
              </button>
              <div className="send-step-time">
                <label>
                  <span>Or send it at</span>
                  <input
                    type="datetime-local"
                    name="sendAt"
                    value={sendAt}
                    disabled={busy}
                    onChange={(event) => setSendAt(event.target.value)}
                  />
                </label>
                <button
                  type="button"
                  className="copy-button"
                  disabled={busy || sendAt === ""}
                  onClick={scheduleThisEmail}
                >
                  Send it then
                </button>
              </div>
              {timeProblem === "" ? null : (
                <p className="send-step-reason">{timeProblem}</p>
              )}
            </div>
          )}
        </SendStep>
      </ol>
    </section>
  );
}

export function CampaignControls({
  csrfToken,
  workspaceId,
  siteImages,
  postSources,
  initialCampaigns,
  role,
}: {
  csrfToken: string;
  workspaceId: string;
  /**
   * What this installation's access record says the signed-in person is. The
   * screen uses it only to say whose step a step is; the server decides every
   * command on its own.
   */
  role: HumanRole;
  siteImages: ReadonlyArray<SiteImageTile>;
  postSources: ReadonlyArray<
    Readonly<{
      post: Pick<BlogPost, "id" | "title">;
      artifact: BlogPostArtifactFingerprint;
    }>
  >;
  initialCampaigns: ReadonlyArray<
    Readonly<{ campaign: Campaign; revision: CampaignRevision }>
  >;
}) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [campaigns, setCampaigns] = useState<
    ReadonlyArray<Readonly<{ campaign: Campaign; revision: CampaignRevision }>>
  >(initialCampaigns);
  const [selected, setSelected] = useState<CampaignRevision | null>(null);
  // The composer opens by itself when there is nothing to list yet.
  const [writingNew, setWritingNew] = useState(initialCampaigns.length === 0);
  const [rendered, setRendered] = useState<RenderedCampaign | null>(null);
  // The revision whose email is being previewed, so the preview can draw its
  // header and inline photos through the same-origin media route.
  const [previewRevision, setPreviewRevision] =
    useState<CampaignRevision | null>(null);
  // The campaign whose sending steps are open, and the server's report about
  // it. The report is re-read after every step, so the steps never show a
  // state the server did not just return.
  const [flowCampaignId, setFlowCampaignId] = useState<string | null>(null);
  const [report, setReport] = useState<CampaignSendReport | null>(null);
  const [delivery, setDelivery] = useState<DeliveryReadiness | null>(null);
  const media: EditorMediaContext = { csrfToken, workspaceId, siteImages };

  const loadReport = useCallback(async (campaignId: string) => {
    const response = await fetch(
      `/api/foundry-cms/campaigns?campaignId=${encodeURIComponent(campaignId)}`,
      { cache: "no-store" },
    );
    if (!response.ok) {
      setReport(null);
      return;
    }
    setReport((await response.json()) as CampaignSendReport);
  }, []);

  useEffect(() => {
    let current = true;
    void fetch("/api/foundry-cms/campaigns?readiness=delivery", {
      cache: "no-store",
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { delivery: DeliveryReadiness } | null) => {
        if (current && body !== null) setDelivery(body.delivery);
      })
      .catch(() => {
        // Readiness is a hint about the installation, not a step. When it
        // cannot be read the steps still show the server's own refusals.
      });
    return () => {
      current = false;
    };
  }, []);

  async function loadCampaigns(selectedCampaignId?: string) {
    const response = await fetch("/api/foundry-cms/campaigns", {
      cache: "no-store",
    });
    if (!response.ok) return;
    const body = (await response.json()) as {
      campaigns: ReadonlyArray<
        Readonly<{ campaign: Campaign; revision: CampaignRevision }>
      >;
    };
    setCampaigns(body.campaigns);
    if (selectedCampaignId !== undefined) {
      setSelected(
        body.campaigns.find(
          ({ campaign }) => campaign.id === selectedCampaignId,
        )?.revision ?? null,
      );
      setWritingNew(false);
    }
    return body.campaigns;
  }

  async function submit(command: unknown) {
    setBusy(true);
    try {
      const response = await fetch("/api/foundry-cms/campaigns", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": `campaign:${crypto.randomUUID()}`,
          "x-foundry-csrf": csrfToken,
        },
        body: JSON.stringify(command),
      });
      setMessage(
        response.ok
          ? "Email draft saved. Nothing is sent from here."
          : "The email could not be saved. Check the fields and retry.",
      );
      if (response.ok) {
        const body = (await response.json()) as {
          campaign: Campaign;
          revision: CampaignRevision;
        };
        await loadCampaigns(body.campaign.id);
        // An edit makes a new revision, so anything the sending steps knew
        // about the old one is out of date.
        if (flowCampaignId !== null) await loadReport(flowCampaignId);
      }
    } finally {
      setBusy(false);
    }
  }

  /**
   * Run one sending step, then read the campaign's state back.
   *
   * The report is re-read whether the step was accepted or refused, because a
   * refusal can mean the state moved underneath this screen. Nothing on the
   * steps is drawn from the fact that a request returned.
   */
  async function runStep(command: SendFlowCommand) {
    if (flowCampaignId === null) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/foundry-cms/campaigns", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": `campaign:${crypto.randomUUID()}`,
          "x-foundry-csrf": csrfToken,
        },
        body: JSON.stringify(command),
      });
      const body = (await response.json().catch(() => null)) as
        | Record<string, unknown>
        | null;
      if (!response.ok) {
        const code = typeof body?.error === "string" ? body.error : "";
        setMessage(
          code === ""
            ? refusalSentence(code)
            : `${refusalSentence(code)} Reason: ${code}.`,
        );
      } else if (
        command.action === "request_test" &&
        body?.state !== "accepted"
      ) {
        // The provider answered, but not with a delivery. Say so rather than
        // letting the step look finished.
        const failure =
          typeof body?.failureCode === "string" ? body.failureCode : "";
        setMessage(
          failure === ""
            ? "The test has not been delivered yet."
            : `The test was not delivered. Reason: ${failure}.`,
        );
      }
    } finally {
      await loadReport(flowCampaignId);
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="campaigns-heading">
      <div className="dashboard-section-heading">
        <div>
          <h2 id="campaigns-heading">Emails</h2>
          <p>
            Write an email to your subscribers. It stays a private draft here;
            subscriber identities are never shown.
          </p>
        </div>
        {writingNew || selected !== null ? null : (
          <button
            type="button"
            className="button button-primary"
            disabled={busy}
            onClick={() => {
              setSelected(null);
              setWritingNew(true);
            }}
          >
            New email
          </button>
        )}
      </div>
      {writingNew ? (
        <EmailComposer
          heading="New email"
          media={media}
          busy={busy}
          saveLabel={busy ? "Saving…" : "Save email"}
          onSave={(email) => {
            void submit({
              action: "create_standalone",
              input: {
                ...email,
                emailContent: parseSerializedRichTextDocument(
                  email.emailContent,
                ),
              },
            });
          }}
          onCancel={
            campaigns.length === 0 ? undefined : () => setWritingNew(false)
          }
        />
      ) : null}
      {selected !== null ? (
        <EmailComposer
          key={`${selected.campaignId}:${selected.revisionNumber}`}
          heading="Edit email"
          initialRevision={selected}
          media={media}
          busy={busy}
          saveLabel={busy ? "Saving…" : "Save changes"}
          onSave={(email) => {
            void submit({
              action: "edit",
              campaignId: selected.campaignId,
              expectedVersion: selected.revisionNumber,
              input: {
                ...email,
                emailContent: parseSerializedRichTextDocument(
                  email.emailContent,
                ),
              },
            });
          }}
          onCancel={() => setSelected(null)}
        />
      ) : null}
      {postSources.length === 0 ? null : (
        <form
          className="campaign-from-post"
          onSubmit={(event) => {
            event.preventDefault();
            const sourcePostRevisionId = String(
              new FormData(event.currentTarget).get("sourcePostRevisionId") ??
                "",
            );
            void submit({
              action: "create_from_post",
              sourcePostRevisionId,
            });
          }}
        >
          <label>
            <span>Start from a blog post</span>
            <select name="sourcePostRevisionId" required disabled={busy}>
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
          <button type="submit" className="copy-button" disabled={busy}>
            Create email from post
          </button>
        </form>
      )}
      <ul className="post-list">
        {campaigns.map(({ campaign, revision }) => {
          // The thumbnail shown beside a campaign is its share image, falling
          // back to the header image, so a preview surface always shows a
          // picture when the campaign has one.
          const thumbnail = revision.shareImage ?? revision.headerImage ?? null;
          return (
          <li key={campaign.id}>
            <div className="post-list-summary">
              {thumbnail === null ? null : (
                <img
                  className="campaign-thumbnail"
                  src={campaignPreviewSrc(thumbnail.url)}
                  alt={thumbnail.alt}
                />
              )}
              <strong>{revision.subject}</strong>
              <span>{campaignStateLabels[campaign.lifecycleState]}</span>
            </div>
            <div className="post-list-actions">
              <button
                type="button"
                className="copy-button"
                disabled={busy}
                onClick={() => {
                  setWritingNew(false);
                  setRendered(null);
                  setPreviewRevision(null);
                  setSelected(revision);
                }}
              >
                Edit
              </button>
              <button
                type="button"
                className="copy-button"
                disabled={busy}
                onClick={() => {
                  setPreviewRevision(revision);
                  void fetch(
                    `/api/foundry-cms/campaigns?campaignId=${encodeURIComponent(
                      campaign.id,
                    )}`,
                    { cache: "no-store" },
                  )
                    .then((response) => response.json())
                    .then((body: { rendered: RenderedCampaign }) =>
                      setRendered(body.rendered),
                    )
                    .catch(() =>
                      setMessage("The preview could not be loaded. Try again."),
                    );
                }}
              >
                Preview
              </button>
              <button
                type="button"
                className="copy-button"
                disabled={busy}
                onClick={() => {
                  setWritingNew(false);
                  setSelected(null);
                  setReport(null);
                  setFlowCampaignId(campaign.id);
                  void loadReport(campaign.id);
                }}
              >
                Sending steps
              </button>
            </div>
            {flowCampaignId === campaign.id && report !== null ? (
              <CampaignSendFlow
                report={report}
                delivery={delivery}
                role={role}
                busy={busy}
                onCommand={(sendCommand) => {
                  void runStep(sendCommand);
                }}
                onEdit={() => {
                  setWritingNew(false);
                  setRendered(null);
                  setPreviewRevision(null);
                  setSelected(revision);
                }}
              />
            ) : null}
          </li>
          );
        })}
      </ul>
      {previewRevision === null ? null : (
        <section className="email-preview" aria-label="Email preview">
          <h3>How the email looks</h3>
          <div className="email-preview-message rendered-rich-text">
            {previewRevision.headerImage == null ? null : (
              <figure className="campaign-header-image">
                <img
                  src={campaignPreviewSrc(previewRevision.headerImage.url)}
                  alt={previewRevision.headerImage.alt}
                />
              </figure>
            )}
            <p className="campaign-preview-line">
              {previewRevision.previewText}
            </p>
            <RichTextRenderer
              document={previewEmailContent(previewRevision.emailContent)}
            />
            <p>
              <a href={previewRevision.callToAction.href}>
                {previewRevision.callToAction.label}
              </a>
            </p>
          </div>
          {rendered === null ? null : (
            <details>
              <summary>How the email reads, and technical details</summary>
              <pre>{rendered.text.bytes}</pre>
              <p>
                HTML fingerprint: <code>{rendered.html.fingerprint}</code>
              </p>
            </details>
          )}
        </section>
      )}
      {message === "" ? null : <p role="status">{message}</p>}
    </section>
  );
}
