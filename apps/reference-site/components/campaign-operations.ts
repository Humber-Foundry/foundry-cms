/**
 * What the three Newsletter screens share.
 *
 * The campaign list, the writing box and the sending steps are separate
 * screens now (#237). They all talk to the same route,
 * `/api/foundry-cms/campaigns`, and they all have to say the same words about
 * the same server answers. Those requests and those words live here, so one
 * screen can never drift from another. The three addresses live in
 * `campaign-links.ts`, which a server page reads too.
 *
 * This module is browser-safe. It holds no binding, no secret and no adapter.
 */

import type {
  Campaign,
  CampaignBulkStateReport,
  CampaignId,
  CampaignRevision,
  CampaignLifecycleState,
  CampaignTestDeliveryApplication,
  CampaignTestDeliveryEvidence,
  RenderedCampaign,
} from "@humber-foundry/application";
import {
  mediaAssetIdFromImageAddress,
  mediaImageSrc,
  type RichTextDocument,
} from "@humber-foundry/site-definition";

import { senderDetailsNotSetSentence } from "./connection-status";
import type { SendTime } from "./schedule-send-time";
import { formatDashboardMoment } from "../src/dashboard-time";

/**
 * What one campaign row says about a campaign: the state in plain words, and
 * the date that matters while it is in that state.
 *
 * Typed by the lifecycle union rather than by string, so adding a state to
 * CampaignLifecycleState fails the build here until somebody has written its
 * label and decided which of its dates a person needs to read.
 */
const campaignStateRows: Readonly<
  Record<
    CampaignLifecycleState,
    Readonly<{ label: string; date: (campaign: Campaign) => string }>
  >
> = {
  // Nothing has been sent, so the date that matters is when the draft was
  // last changed.
  draft: {
    label: "Draft",
    date: (campaign) => `last changed ${formatDashboardMoment(campaign.updatedAt)}`,
  },
};

/** The state and the date one campaign row shows. */
export function campaignRowSummary(
  campaign: Campaign,
): Readonly<{ label: string; date: string }> {
  const row = campaignStateRows[campaign.lifecycleState];
  return { label: row.label, date: row.date(campaign) };
}

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
export type CampaignSendReport = Readonly<{
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
 * (`campaign-runtime.ts`); it also carries `providerHealth`, which these
 * screens do not read.
 */
export type DeliveryReadiness = Readonly<{
  state: "connected" | "not_configured" | "local_development";
  missingSettings: ReadonlyArray<string>;
  setupGuide: string;
}>;

/**
 * One send-time request an app made, as the server reports it: which
 * campaign, which app, and the time asked for in the zone the request itself
 * carries (see ADR-0038 §4).
 */
export type PendingScheduleRequest = Readonly<{
  proposalId: string;
  campaignId: string;
  agentName: string;
  localDateTime: string;
  ianaTimeZone: string;
}>;

/**
 * Every command the sending steps can send.
 *
 * Naming them is what keeps a step from sending a shape the route will refuse:
 * a missing or misspelt field fails the build here rather than returning a
 * refusal to the person who pressed the button.
 */
export type SendFlowCommand =
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
  | Readonly<{ action: "decline_schedule_request"; proposalId: string }>
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

/**
 * Plain words for the reason codes these screens can be refused with.
 *
 * A refusal always shows the server's own code as well, because the person
 * who has to fix it needs the exact reason and that code is the stable name
 * for it. The sentence is what the site owner reads; the code is the detail
 * underneath.
 */
const refusalSentences: Readonly<Record<string, string>> = {
  delivery_not_configured:
    "Email is not connected yet, so nothing can be sent or tested.",
  campaign_sender_details_not_configured: senderDetailsNotSetSentence,
  bulk_owner_required: "Only the site owner can do this step.",
  human_authority_required:
    "Only the site owner or an editor can answer an app's request.",
  schedule_request_not_found:
    "That request is no longer there. Reload the page.",
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

/**
 * One refusal, written the way the screens report it: the plain sentence, then
 * the server's own code so whoever has to fix it has the exact reason. An
 * answer that named no code gets the sentence alone.
 */
export function refusalMessage(code: string): string {
  const sentence =
    refusalSentences[code] ??
    "That step did not go through. Nothing was sent.";
  return code === "" ? sentence : `${sentence} Reason: ${code}.`;
}

/**
 * The address the dashboard preview draws for one campaign image. A campaign
 * stores each image as an absolute address so the sent email can load it. A
 * gallery photo's address is the site's own `/api/media/<assetId>` route made
 * absolute; the preview draws it by its same-origin path so it loads while the
 * dashboard runs on any host. An external picture is drawn as written.
 */
export function campaignPreviewSrc(url: string): string {
  const assetId = mediaAssetIdFromImageAddress(url);
  return assetId === null ? url : mediaImageSrc(assetId);
}

/** The email body with every image address drawn by its same-origin path. */
export function previewEmailContent(
  document: RichTextDocument,
): RichTextDocument {
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
 * Whether the delivered test covers exactly what the email says now.
 *
 * Two separate server facts have to agree. The test must have been delivered
 * for the fingerprint the current content renders to, and per-campaign
 * readiness must report the Owner's confirmation. Editing the email changes
 * the fingerprint, so an earlier test stops counting the moment it is saved —
 * the same rule the server applies before it will approve a send.
 */
export function testCoversCurrentEmail(report: CampaignSendReport): boolean {
  return (
    report.testEvidence !== null &&
    report.testEvidence.campaignFingerprint ===
      report.rendered.campaignFingerprint
  );
}

export function testConfirmed(report: CampaignSendReport): boolean {
  return (
    testCoversCurrentEmail(report) && report.testReadiness.state === "ready"
  );
}

/**
 * Read whether email delivery and the sender details are set.
 *
 * Readiness is a hint about the installation, not a step. When it cannot be
 * read this answers `null`, and the screens still show the server's own
 * refusals.
 */
export async function readCampaignReadiness(): Promise<Readonly<{
  delivery: DeliveryReadiness;
  senderDetails: DeliveryReadiness;
}> | null> {
  try {
    const response = await fetch(
      "/api/foundry-cms/campaigns?readiness=delivery",
      { cache: "no-store" },
    );
    if (!response.ok) return null;
    return (await response.json()) as {
      delivery: DeliveryReadiness;
      senderDetails: DeliveryReadiness;
    };
  } catch {
    return null;
  }
}

/**
 * Every campaign this site holds, with the send-time requests apps have made
 * that nobody has answered yet. Answers null when the list cannot be read, so
 * the screen keeps showing the last answer it did get.
 */
export async function readCampaignList(): Promise<Readonly<{
  campaigns: ReadonlyArray<Readonly<{ campaign: Campaign; revision: CampaignRevision }>>;
  scheduleRequests: ReadonlyArray<PendingScheduleRequest>;
}> | null> {
  const response = await fetch("/api/foundry-cms/campaigns", {
    cache: "no-store",
  });
  if (!response.ok) return null;
  const body = (await response.json()) as {
    campaigns: ReadonlyArray<
      Readonly<{ campaign: Campaign; revision: CampaignRevision }>
    >;
    scheduleRequests?: ReadonlyArray<PendingScheduleRequest>;
  };
  return {
    campaigns: body.campaigns,
    scheduleRequests: body.scheduleRequests ?? [],
  };
}

/** The server's whole report about one campaign, or null when it cannot be read. */
export async function readCampaignSendReport(
  campaignId: string,
): Promise<CampaignSendReport | null> {
  const response = await fetch(
    `/api/foundry-cms/campaigns?campaignId=${encodeURIComponent(campaignId)}`,
    { cache: "no-store" },
  );
  if (!response.ok) return null;
  return (await response.json()) as CampaignSendReport;
}

/** Send one command to the campaigns route. */
export async function sendCampaignCommand(
  csrfToken: string,
  command: unknown,
): Promise<Response> {
  return fetch("/api/foundry-cms/campaigns", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": `campaign:${crypto.randomUUID()}`,
      "x-foundry-csrf": csrfToken,
    },
    body: JSON.stringify(command),
  });
}

/** The refusal code an answered body carries, or the empty string. */
export function refusalCodeIn(
  body: Record<string, unknown> | null,
): string {
  return typeof body?.error === "string" ? body.error : "";
}

/** The refusal code a failed answer carries, or the empty string. */
export async function refusalCodeOf(response: Response): Promise<string> {
  return refusalCodeIn(
    (await response.json().catch(() => null)) as Record<
      string,
      unknown
    > | null,
  );
}
