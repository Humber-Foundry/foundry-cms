/**
 * What the three Blog screens share.
 *
 * The posts list, the writing box and one post's own screen are separate
 * screens now (#230). They all talk to the same two routes,
 * `/api/foundry-cms/content-revisions` and
 * `/api/foundry-cms/blog-operations`, and they all have to say the same words
 * about the same server answers. Those words, and the reads that go with
 * them, live here, so no two screens say different things. The three
 * addresses live in `blog-links.ts`, which a server page reads too.
 *
 * This module is browser-safe. It holds no binding, no secret and no adapter.
 */

import type {
  BlogPostOperationalSummary,
  ContentRevision,
} from "@humber-foundry/application";
import type {
  BlogPost,
  BlogPostId,
  RichTextDocument,
} from "@humber-foundry/site-definition";

import { formatLocalScheduleTime } from "./schedule-time-format";
import { formatDashboardMoment } from "../src/dashboard-time";
import {
  sendContentRevisionAttempt,
  sendHumanMutationAttempt,
} from "../src/content-revision-client";

export { formatLocalScheduleTime } from "./schedule-time-format";

/** A value that tells one attempt at a change apart from every other. */
export function blogMutationKey(operation: string) {
  return `${operation}:${crypto.randomUUID()}`;
}

export function blogPostPlainText(document: RichTextDocument): string {
  const lines: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value !== "object" || value === null) return;
    if ("text" in value && typeof value.text === "string") {
      lines.push(value.text);
      return;
    }
    if ("children" in value && Array.isArray(value.children)) {
      const before = lines.length;
      value.children.forEach(visit);
      if (before !== lines.length) lines.push("\n");
    }
  };
  visit(document);
  return lines.join("").replace(/\n{2,}/gu, "\n").trim();
}

export function blogPostPreviewUrl(previewUrl: string, slug: string): string {
  const url = new URL(
    previewUrl,
    typeof window === "undefined" ? "http://localhost" : window.location.origin,
  );
  url.pathname = `${url.pathname.replace(/\/$/u, "")}/blog/${encodeURIComponent(slug)}`;
  return url.toString();
}

export function blogPostLifecycleAction(
  post: Pick<BlogPost, "id" | "targetVisibility">,
  verifiedPublicPostIds: ReadonlySet<BlogPostId>,
): "unpublish_blog_post" | "republish_blog_post" | null {
  if (
    post.targetVisibility === "public" &&
    verifiedPublicPostIds.has(post.id)
  ) {
    return "unpublish_blog_post";
  }
  if (
    post.targetVisibility === "unpublished" &&
    !verifiedPublicPostIds.has(post.id)
  ) {
    return "republish_blog_post";
  }
  return null;
}

/**
 * The name a post is shown under. A post saved with no title still needs a
 * name: the title is the only thing an owner can read on a row or press.
 */
export function blogPostName(title: string): string {
  return title.trim() === "" ? "Untitled post" : title;
}

/** How a post's state is coloured on its row. See `DashboardStateLabel`. */
export type BlogPostStateTone = "live" | "draft" | "plain";

/** The plain words for where a post stands, and the one action that fits. */
export function blogPostStanding(
  post: Pick<BlogPost, "id" | "targetVisibility">,
  verifiedPublicPostIds: ReadonlySet<BlogPostId>,
): Readonly<{
  label: string;
  tone: BlogPostStateTone;
  /**
   * The one lifecycle change this post can take now, with the words for it.
   * `null` when the post is waiting on the next site publish and there is
   * nothing to offer. The operation and its words travel together, so a
   * screen can never draw a control with no command behind it.
   */
  action: Readonly<{
    operation: "unpublish_blog_post" | "republish_blog_post";
    label: string;
  }> | null;
}> {
  const operation = blogPostLifecycleAction(post, verifiedPublicPostIds);
  if (operation === "unpublish_blog_post") {
    return {
      label: "On your site",
      tone: "live",
      action: { operation, label: "Unpublish" },
    };
  }
  if (operation === "republish_blog_post") {
    return {
      label: "Draft — not on your site",
      tone: "draft",
      action: { operation, label: "Publish" },
    };
  }
  return {
    label:
      post.targetVisibility === "public"
        ? "Goes live when you next publish the site"
        : "Comes off the site when you next publish",
    tone: "plain",
    action: null,
  };
}

/**
 * Whether any post's target visibility ("public" or "unpublished") does not
 * yet match what the live site verifies. `blogPostLifecycleAction` returns
 * `null` for exactly this mismatch — a post waiting to go live, or waiting
 * to come off the site, at the next site publish.
 */
export function blogHasPendingSitePublish(
  posts: ReadonlyArray<Pick<BlogPost, "id" | "targetVisibility">>,
  verifiedPublicPostIds: ReadonlySet<BlogPostId>,
): boolean {
  return posts.some(
    (post) => blogPostLifecycleAction(post, verifiedPublicPostIds) === null,
  );
}

/**
 * The plain-words line under a post about its schedule, and whether the
 * post is eligible to show a "Schedule" control at all (it is active and
 * has no active schedule already). This does not decide whether scheduling
 * needs a preview first — that depends on what preview this browser session
 * has actually shown, which only the post's own screen knows. See
 * `previewedRevision` in `blog-post-screen.tsx`.
 */
export function blogPostScheduleStanding(
  summary: BlogPostOperationalSummary | undefined,
): Readonly<{ line: string | null; canSchedule: boolean }> {
  if (summary === undefined || summary.collectionState !== "active") {
    return { line: null, canSchedule: false };
  }
  if (summary.activeSchedule !== null) {
    return {
      line: `Scheduled to publish ${
        formatLocalScheduleTime(
          summary.activeSchedule.localDateTime,
          summary.activeSchedule.ianaTimeZone,
        )
      }.`,
      canSchedule: false,
    };
  }
  return { line: null, canSchedule: true };
}

/**
 * The truthful failure line for a post's most recent scheduled execution,
 * matched to the domain's "User-visible failures" wording, or `null` when
 * the last execution did not fail.
 */
export function blogPostExecutionFailureNote(
  summary: BlogPostOperationalSummary | undefined,
): string | null {
  const execution = summary?.latestExecution ?? null;
  if (
    summary === undefined ||
    execution === null ||
    (execution.state !== "failed" && execution.state !== "blocked")
  ) {
    return null;
  }
  return summary.liveRevisionId !== null
    ? "Update failed; the previous version remains live."
    : "First publication failed; it is not live yet.";
}

/**
 * When a scheduled publish put this post on the site, in the owner's words.
 *
 * The CMS holds no published time for a post: `BlogPost` has none, and a
 * publish through the site-wide Publish button leaves no record. A scheduled
 * publish that finished does leave one, so that time is named while the post
 * is on the site. Once the post comes off the site again the record no longer
 * says when it went live, so nothing is said. `null` in every other case.
 */
export function blogPostPublishedLine(
  standing: Readonly<{ tone: BlogPostStateTone }>,
  summary: BlogPostOperationalSummary | undefined,
): string | null {
  const execution = summary?.latestExecution ?? null;
  if (standing.tone !== "live" || execution?.state !== "completed") {
    return null;
  }
  return `Published ${formatDashboardMoment(execution.updatedAt)}.`;
}

/** The fields of a pending schedule request the two Blog screens read. */
export type PendingScheduleRequest = Readonly<{
  id: string;
  localDateTime: string;
  ianaTimeZone: string;
}>;

/**
 * The one sentence that says an app asked to publish a post, and when. A
 * request nobody has named reads as the plain word "An app" — see
 * CONTEXT.md "App / Connected app".
 */
export function pendingScheduleRequestNote(
  agentName: string | null,
  request: PendingScheduleRequest,
): string {
  return `${agentName ?? "An app"} asked to publish this at ${formatLocalScheduleTime(
    request.localDateTime,
    request.ianaTimeZone,
  )}.`;
}

/**
 * The command that declines an app's schedule request, as both Blog screens
 * send it: the body for the blog-operations route, and the name its
 * idempotency key is built from. See ADR-0038.
 */
export function declineScheduleRequestCommand(
  postId: BlogPostId,
  request: PendingScheduleRequest,
): Readonly<{
  body: Readonly<{
    operation: "decline_schedule_proposal";
    postId: BlogPostId;
    proposalId: string;
  }>;
  operation: "decline-blog-post-schedule-proposal";
}> {
  return {
    body: {
      operation: "decline_schedule_proposal",
      postId,
      proposalId: request.id,
    },
    operation: "decline-blog-post-schedule-proposal",
  };
}

/** What a screen says when a date and time it was given cannot be read. */
export const dateNotReadMessage =
  "That date and time could not be read. Try again.";

/** What a screen says when the server refused a change and gave no reason. */
export const changeNotAcceptedMessage =
  "The change was not accepted. Refresh and try again.";

/** What a screen says when a preview could not be opened. */
export const previewNotOpenedMessage =
  "The preview could not be opened. Try again.";

/** What a screen says when a change's result never arrived. */
export const changeNotConfirmedMessage =
  "The change could not be confirmed. Check the post, then try again.";

/** The one sentence the Blog screen reads under its name. */
export const blogScreenDescription =
  "Open a post to change it, preview it privately, then publish it.";

/**
 * The three fields every content-revision command carries: which draft it
 * changes, which schema that draft uses, and which revision it was written
 * against. Every Blog screen spreads this into its command, so no screen
 * types the three by hand.
 */
export function revisionCommandBase(
  revision: Pick<ContentRevision, "workspaceId" | "revision" | "definition">,
): Readonly<{
  workspaceId: ContentRevision["workspaceId"];
  schemaVersion: string;
  baseRevision: number;
}> {
  return {
    workspaceId: revision.workspaceId,
    schemaVersion: revision.definition.schemaVersion,
    baseRevision: revision.revision,
  };
}

export const scheduleNeedsApprovalMessage =
  "Scheduling needs a preview of this exact version. Preview this post, " +
  "then schedule it. Editing the post after that clears its schedule, so " +
  "schedule it again after any later edit.";

const blogOperationErrorMessages: Readonly<Record<string, string>> = {
  approval_stale: scheduleNeedsApprovalMessage,
  approval_required: scheduleNeedsApprovalMessage,
  local_time_invalid: dateNotReadMessage,
  civil_time_resolution_mismatch:
    "That local time does not exist or is ambiguous in this time zone. Pick a different time.",
  production_operation_in_progress:
    "The site is already publishing. Try again once it finishes.",
  post_already_archived: "This post is already archived.",
  post_not_archived: "This post is not archived, so it cannot be restored.",
  archive_request_not_found:
    "This archive could not be found. Refresh the page and try again.",
  human_authority_required:
    "You do not have access to finish this. Ask an owner or editor to help.",
  archive_publication_mismatch:
    "The site changed since this archive started. Refresh the page and try again.",
  archive_withdrawal_draft_conflict:
    "Another change to this post is in progress. Refresh the page and try again.",
};

export function blogOperationErrorMessage(code: string): string {
  return blogOperationErrorMessages[code] ?? changeNotAcceptedMessage;
}

export function blogOperationErrorCode(body: unknown): string {
  return typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof body.error === "string"
    ? body.error
    : "";
}

/**
 * Opens one new tab and sends it to the address `resolveAddress` returns.
 *
 * The tab is opened by the press itself, because a browser blocks a tab
 * opened later, once the request has answered. A `resolveAddress` that throws
 * closes the tab again, so a refusal never leaves an empty window behind. Both
 * previews on the Blog screens go through this.
 */
export async function openInNewTab(
  resolveAddress: () => Promise<string>,
): Promise<void> {
  const popup = window.open("", "_blank");
  if (popup !== null) popup.opener = null;
  try {
    const destination = await resolveAddress();
    if (popup === null) {
      window.open(destination, "_blank", "noopener,noreferrer");
    } else {
      popup.location.href = destination;
    }
  } catch (error) {
    popup?.close();
    throw error;
  }
}

export type ArchiveWithdrawalLocation = Readonly<{
  workspaceId: string;
  revision: number;
}>;

export type ArchiveWithdrawalPreviewResult =
  | Readonly<{
      outcome: "opened";
      withdrawal: ArchiveWithdrawalLocation;
      previewUrl: string;
      mutationToken: string;
    }>
  | Readonly<{ outcome: "failed"; message: string; mutationToken: string }>;

export type ArchiveWithdrawalContinuationResult =
  | Readonly<{ outcome: "continued"; mutationToken: string }>
  | Readonly<{ outcome: "failed"; message: string; mutationToken: string }>;

/**
 * Recovers this person's access to the withdrawal that was started when a
 * live post was archived, then opens the exact preview of that withdrawal
 * revision — the site as it will look once this post is off it. Nothing here
 * submits an approval. It only finds and shows the preview, so a person can
 * look at it before confirming.
 */
export async function openArchiveWithdrawalPreview({
  postId,
  archiveRequestId,
  mutationToken,
  fetcher = fetch,
}: {
  postId: string;
  archiveRequestId: string;
  mutationToken: string;
  fetcher?: typeof fetch;
}): Promise<ArchiveWithdrawalPreviewResult> {
  const recovered = await sendHumanMutationAttempt({
    url: "/api/foundry-cms/blog-operations",
    attempt: {
      body: JSON.stringify({
        operation: "recover_archive_withdrawal_access",
        postId,
        archiveRequestId,
      }),
      idempotencyKey: blogMutationKey("recover-archive-withdrawal-access"),
    },
    mutationToken,
    fetcher,
  });
  const withdrawal: ArchiveWithdrawalLocation | null =
    typeof recovered.body === "object" &&
    recovered.body !== null &&
    "withdrawal" in recovered.body &&
    typeof recovered.body.withdrawal === "object" &&
    recovered.body.withdrawal !== null &&
    "workspaceId" in recovered.body.withdrawal &&
    "revision" in recovered.body.withdrawal &&
    typeof recovered.body.withdrawal.workspaceId === "string" &&
    typeof recovered.body.withdrawal.revision === "number"
      ? {
          workspaceId: recovered.body.withdrawal.workspaceId,
          revision: recovered.body.withdrawal.revision,
        }
      : null;
  if (!recovered.response.ok || withdrawal === null) {
    return {
      outcome: "failed",
      message: blogOperationErrorMessage(
        blogOperationErrorCode(recovered.body),
      ),
      mutationToken: recovered.mutationToken,
    };
  }

  const opened = await sendContentRevisionAttempt({
    attempt: {
      body: JSON.stringify({
        operation: "open_preview",
        workspaceId: withdrawal.workspaceId,
        revision: withdrawal.revision,
      }),
      idempotencyKey: blogMutationKey("open-archive-withdrawal-preview"),
    },
    mutationToken: recovered.mutationToken,
    fetcher,
  });
  const previewUrl =
    typeof opened.body === "object" &&
    opened.body !== null &&
    "previewUrl" in opened.body &&
    typeof opened.body.previewUrl === "string"
      ? opened.body.previewUrl
      : null;
  if (!opened.response.ok || previewUrl === null) {
    return {
      outcome: "failed",
      message: previewNotOpenedMessage,
      mutationToken: opened.mutationToken,
    };
  }
  return {
    outcome: "opened",
    withdrawal,
    previewUrl,
    mutationToken: opened.mutationToken,
  };
}

/**
 * Confirms the withdrawal revision a person already previewed in this
 * session (the same "a human reviewed this" record every publish needs),
 * then asks the server to continue the stalled withdrawal. Only call this
 * with a `withdrawal` location `openArchiveWithdrawalPreview` actually
 * returned in this session — the caller is responsible for that gate, this
 * function does not re-check that a preview happened.
 */
export async function confirmArchiveWithdrawal({
  postId,
  archiveRequestId,
  withdrawal,
  mutationToken,
  fetcher = fetch,
}: {
  postId: string;
  archiveRequestId: string;
  withdrawal: ArchiveWithdrawalLocation;
  mutationToken: string;
  fetcher?: typeof fetch;
}): Promise<ArchiveWithdrawalContinuationResult> {
  const approved = await sendHumanMutationAttempt({
    url: "/api/foundry-cms/publications",
    attempt: {
      body: JSON.stringify({
        operation: "approve",
        workspaceId: withdrawal.workspaceId,
        revision: withdrawal.revision,
        previewConfirmed: true,
      }),
      idempotencyKey: blogMutationKey("approve-archive-withdrawal"),
    },
    mutationToken,
    fetcher,
  });
  const approvalId =
    typeof approved.body === "object" &&
    approved.body !== null &&
    "id" in approved.body &&
    typeof approved.body.id === "string"
      ? approved.body.id
      : null;
  if (!approved.response.ok || approvalId === null) {
    return {
      outcome: "failed",
      message:
        "The site could not confirm this archive step. Refresh the page and try again.",
      mutationToken: approved.mutationToken,
    };
  }

  const continued = await sendHumanMutationAttempt({
    url: "/api/foundry-cms/blog-operations",
    attempt: {
      body: JSON.stringify({
        operation: "continue_archive_withdrawal",
        postId,
        archiveRequestId,
        withdrawalApprovalId: approvalId,
      }),
      idempotencyKey: blogMutationKey("continue-archive-withdrawal"),
    },
    mutationToken: approved.mutationToken,
    fetcher,
  });
  if (!continued.response.ok) {
    return {
      outcome: "failed",
      message: blogOperationErrorMessage(
        blogOperationErrorCode(continued.body),
      ),
      mutationToken: continued.mutationToken,
    };
  }
  return { outcome: "continued", mutationToken: continued.mutationToken };
}
