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

/**
 * The state and the date one campaign row shows.
 *
 * A server that answers with a state this screen has not been taught yet gets
 * no label rather than a guess, and the row still shows when the email was
 * last changed. The list must keep drawing either way.
 */
export function campaignRowSummary(
  campaign: Campaign,
): Readonly<{ label: string; date: string }> {
  const row: (typeof campaignStateRows)[CampaignLifecycleState] | undefined =
    campaignStateRows[campaign.lifecycleState];
  return row === undefined
    ? {
        label: "",
        date: `last changed ${formatDashboardMoment(campaign.updatedAt)}`,
      }
    : { label: row.label, date: row.date(campaign) };
}

/** What per-campaign test readiness reports, as the server returns it. */
type CampaignTestReadiness = Awaited<
  ReturnType<CampaignTestDeliveryApplication["queries"]["readiness"]>
>;

/**
 * What a person has to read before an email goes to the whole list: who it
 * goes to, what it says it is, who it comes from, and the two addresses at
 * the bottom of it.
 *
 * Every value is read from the one campaign revision the rendered bytes came
 * from, so the review can never describe a different email from the one that
 * would go out. `campaignRevisionId` is that revision, and the screen shows
 * the review only while the revision it is holding is the same one.
 *
 * `senderName`, `senderAddress` and `replyAddress` are the installation's own
 * sending identity — the name and address every recipient already reads in
 * their inbox. They are never a subscriber's address. They are null while this
 * installation holds no sender under the revision's sender identity, which is
 * what local development does.
 */
export type CampaignSendSummary = Readonly<{
  campaignRevisionId: string;
  recipientCount: number;
  subject: string;
  senderName: string | null;
  senderAddress: string | null;
  replyAddress: string | null;
  /**
   * The whole footer line stored on the revision. It holds the legal name, the
   * postal address and the contact address, joined the way the installation's
   * settings build them.
   */
  footer: string;
  /**
   * The unsubscribe address with its one-off token marker still in it, exactly
   * as the revision stores it. `unsubscribeAddressShown` takes the marker out
   * for the screen.
   */
  unsubscribeAddress: string;
}>;

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
  /** What the review before a send shows. */
  sendSummary: CampaignSendSummary;
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
 * One answer from the server, written the way every screen reports it: the
 * plain sentence a person reads, then the server's own code, because whoever
 * has to fix it needs the exact reason and that code is the stable name for
 * it. An answer that named no code gets the sentence alone.
 */
function plainReason(
  sentences: Readonly<Record<string, string>>,
  fallback: string,
  code: string,
): string {
  const sentence = sentences[code] ?? fallback;
  return code === "" ? sentence : `${sentence} Reason: ${code}.`;
}

/** One refusal, in the words a site owner reads. */
export function refusalMessage(code: string): string {
  return plainReason(
    refusalSentences,
    "That step did not go through. Nothing was sent.",
    code,
  );
}

/**
 * Plain words for why the email provider did not take a test.
 *
 * A test can be refused after the server has accepted the request, so this is
 * a separate list from the refusals above. Every sentence says what happened
 * and what to do, because a bare code reads as a fault in the dashboard when
 * the answer is usually somewhere else.
 */
const emailChangedMidTest =
  "The email changed while the test was going out. Send a new test.";

const testFailureSentences: Readonly<Record<string, string>> = {
  provider_unavailable:
    "The email provider could not be reached, so no test went out.",
  provider_rate_limited:
    "The email provider is taking too many requests right now. Wait a few " +
    "minutes, then send the test again.",
  provider_sender_unmapped:
    "This site's sending address is not set up with the email provider yet.",
  provider_test_rejected: "The email provider refused the test.",
  provider_test_definitively_not_delivered:
    "The email provider tried and could not deliver the test.",
  provider_test_daily_recipient_limit:
    "This address has had all the tests the email provider allows today. " +
    "Try again tomorrow.",
  provider_campaign_create_rejected:
    "The email provider would not take this email.",
  provider_campaign_not_found:
    "The email provider no longer holds this email. Send the test again.",
  provider_campaign_fingerprint_mismatch: emailChangedMidTest,
  campaign_revision_changed: emailChangedMidTest,
  foundry_send_proof_invalid:
    "The test could not be proved to belong to this site, so it was stopped.",
  test_recipient_binding_changed:
    "The verified test address for this site changed, so the test was " +
    "stopped.",
  test_recipient_forbidden:
    "There is no verified test address on file for you.",
};

/** One undelivered test, in the words a site owner reads. */
export function testFailureMessage(code: string): string {
  return plainReason(
    testFailureSentences,
    "The test has not been delivered yet.",
    code,
  );
}

/**
 * What the frame that draws the email may load.
 *
 * `default-src 'none'` stops the frame reaching any address at all: no script,
 * no style sheet, no font, no other frame, no tracking picture from somebody
 * else's server. `img-src 'self'` then allows back exactly one thing, a
 * picture this site serves, because showing the email with its pictures is the
 * point of the preview. `style-src 'unsafe-inline'` covers a style written on
 * a tag, which several mail clients need; a style attribute is not code, and
 * nothing may run in the frame either way.
 *
 * Email text is written by whoever wrote the campaign, so the frame must never
 * become a way to fetch something.
 */
export const campaignPreviewContentSecurityPolicy =
  "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'";

/**
 * The two lines put at the top of the preview document's head.
 *
 * The policy above, and a base target that sends every link in the email to a
 * new browsing context. The frame is sandboxed without `allow-popups`, so a
 * new context is refused and a press on a link does nothing. That is what
 * keeps a press inside the preview from navigating the frame away to the
 * address the link names.
 */
const campaignPreviewHead =
  `<meta http-equiv="Content-Security-Policy" content="${campaignPreviewContentSecurityPolicy}">` +
  '<base target="_blank">';

/** Matches the `src` of one `<img>` tag in the renderer's own output. */
const renderedImageSource = /(<img\b[^>]*?\bsrc=")([^"]*)(")/giu;

/** The opening `<head>` tag, and the document type that comes before it. */
const openingHeadTag = /<head\b[^>]*>/iu;
const documentType = /^<!doctype\b[^>]*>/iu;

/**
 * The two lines above, put where a browser will read them: straight after the
 * opening `<head>` tag, or after the document type when a document has no head
 * of its own. Never before the document type, which would put the browser into
 * quirks mode and draw the email in a layout no inbox uses.
 */
function withPreviewHead(html: string): string {
  const head = openingHeadTag.exec(html);
  if (head !== null) {
    const after = head.index + head[0].length;
    return html.slice(0, after) + campaignPreviewHead + html.slice(after);
  }
  const type = documentType.exec(html);
  const after = type === null ? 0 : type[0].length;
  return html.slice(0, after) + campaignPreviewHead + html.slice(after);
}

/**
 * The exact bytes the campaign renderer produces, made safe to draw inside the
 * dashboard.
 *
 * Two changes are made, and no others:
 *
 * 1. The head gains the content security policy and the base target above, so
 *    the frame can load nothing off this site and can run nothing.
 * 2. Every gallery picture is drawn by its same-origin `/api/media/<assetId>`
 *    path. A campaign stores each picture as an absolute address so the
 *    sent email can load it; that address names the site's public origin,
 *    which the dashboard may not be running on. A picture from anywhere else
 *    is left exactly as written, and the policy above then refuses it.
 *
 * Nothing is removed, reworded or reordered, so what the frame draws is the
 * email the delivery provider will send, with the one exception the policy
 * makes: a picture from another website does not draw. The screen counts those
 * with `picturesFromAnotherWebsite` and says so. The Content ID beside the
 * frame is the fingerprint of the exact bytes.
 */
export function campaignPreviewDocument(html: string): string {
  const sameOriginPictures = html.replace(
    renderedImageSource,
    (whole, opening: string, address: string, closing: string) => {
      // The renderer escapes every address it writes, so an ampersand reads as
      // `&amp;` here. Read the address back before asking whether it names a
      // gallery photo; a photo path carries no character that escaping
      // changes, so the replacement needs no escaping of its own.
      const assetId = mediaAssetIdFromImageAddress(
        address.replaceAll("&amp;", "&"),
      );
      return assetId === null
        ? whole
        : `${opening}${mediaImageSrc(assetId)}${closing}`;
    },
  );
  return withPreviewHead(sameOriginPictures);
}

/**
 * How many pictures in this email are loaded from another website.
 *
 * The preview refuses them, so the screen has to say one is missing rather
 * than draw a gap the owner cannot explain. Read the preview document, not the
 * renderer's bytes, because by then every gallery photo is already a path on
 * this site and anything left is somewhere else.
 */
export function picturesFromAnotherWebsite(previewDocument: string): number {
  return Array.from(previewDocument.matchAll(renderedImageSource)).filter(
    ([, , address]) => !address!.startsWith("/"),
  ).length;
}

/**
 * The unsubscribe address as a person can read it.
 *
 * Every email carries this address with that one reader's own token added to
 * it, so the stored address holds a marker where the token goes. The marker is
 * a machine's word, so the review shows the address without it.
 */
export function unsubscribeAddressShown(address: string): string {
  try {
    const parsed = new URL(address);
    // Whichever parameter carries the marker, it is the token's. Matching the
    // marker rather than the parameter's name means renaming the parameter
    // where the address is built cannot leave a machine's word on screen.
    for (const [name, value] of Array.from(parsed.searchParams)) {
      if (value.includes("{{")) parsed.searchParams.delete(name);
    }
    return parsed.toString();
  } catch {
    return address;
  }
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
  }).catch(() => null);
  if (response === null || !response.ok) return null;
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
