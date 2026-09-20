"use client";

import { useState } from "react";

import {
  resolvePostPublicationInstant,
  type ArchivedBlogPostSummary,
  type BlogPostOperationalSummary,
  type BlogPostSchedule,
  type ContentRevision,
} from "@humber-foundry/application";
import {
  formatSeoKeywords,
  parseSeoKeywords,
  parseSerializedRichTextDocument,
  seoFieldHints,
  seoKeywordLimit,
  serializeRichTextDocument,
  toSeoShareImage,
  type BlogPost,
  type BlogPostId,
  type RichTextDocument,
  type SeoMetadata,
  type SeoShareImage,
  type SerializedRichTextDocument,
} from "@humber-foundry/site-definition";

import { RichTextEditor } from "./rich-text-editor";
import { ChangePhotoField, type EditorMediaContext } from "./change-photo-field";
import { ComposerActions, emptyRichTextBody } from "./composer";
import { PublishingConnectionStatus } from "./connection-status";
import { formatLocalScheduleTime } from "./schedule-time-format";
// Type only — erased at compile, so the server-only module is never bundled
// into this client component.
import type { SiteImageTile } from "../src/site-used-photos";
import {
  sendContentRevisionAttempt,
  sendHumanMutationAttempt,
  type ContentRevisionAttempt,
} from "../src/content-revision-client";

function mutationKey(operation: string) {
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

/** The web address a title suggests: lowercase words joined with hyphens. */
function blogPostSlugFromTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/gu, "")
    .replace(/[’']/gu, "")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 120)
    .replace(/-+$/gu, "");
}

/**
 * The summary shown in the blog list. The owner can write one; left empty,
 * the opening lines of the post are used, and an empty post falls back to
 * its title so the saved draft always validates.
 */
function blogPostSummary(
  summary: string,
  body: SerializedRichTextDocument,
  title: string,
): string {
  const written = summary.trim();
  if (written !== "") return written.slice(0, 320);
  const opening = blogPostPlainText(parseSerializedRichTextDocument(body))
    .replace(/\s+/gu, " ")
    .trim();
  const source = opening === "" ? title : opening;
  if (source.length <= 200) return source;
  return `${source.slice(0, 200).replace(/\s+\S*$/u, "")}…`;
}

/**
 * The form for one post: a title, a body you write into, and the
 * details (summary and web address) folded away until they are wanted.
 */
function PostComposer({
  editorId,
  initialPost,
  media,
  busy,
  saveLabel,
  onSave,
  onCancel,
}: {
  editorId: string;
  initialPost?: Pick<
    BlogPost,
    "title" | "slug" | "excerpt" | "body" | "seo" | "mainImage"
  >;
  media: EditorMediaContext;
  busy: boolean;
  saveLabel: string;
  onSave(post: {
    title: string;
    slug: string;
    excerpt: string;
    seo: SeoMetadata;
    mainImage: SeoShareImage | null;
    body: SerializedRichTextDocument;
  }): void;
  onCancel?(): void;
}) {
  const [title, setTitle] = useState(initialPost?.title ?? "");
  const [slug, setSlug] = useState(initialPost?.slug ?? "");
  const [slugEdited, setSlugEdited] = useState(initialPost !== undefined);
  const [summary, setSummary] = useState(initialPost?.excerpt ?? "");
  const [seoTitle, setSeoTitle] = useState(initialPost?.seo.title ?? "");
  const [seoDescription, setSeoDescription] = useState(
    initialPost?.seo.description ?? "",
  );
  const [keywords, setKeywords] = useState(
    formatSeoKeywords(initialPost?.seo.keywords ?? []),
  );
  // The schema refuses a longer list. Say so here, next to the box, rather
  // than letting the save come back with a generic schema complaint.
  const tooManyKeywords = parseSeoKeywords(keywords).length > seoKeywordLimit;
  const [shareImageUrl, setShareImageUrl] = useState(
    initialPost?.seo.shareImage?.url ?? "",
  );
  const [shareImageAlt, setShareImageAlt] = useState(
    initialPost?.seo.shareImage?.alt ?? "",
  );
  const [mainImageUrl, setMainImageUrl] = useState(
    initialPost?.mainImage?.url ?? "",
  );
  const [mainImageAlt, setMainImageAlt] = useState(
    initialPost?.mainImage?.alt ?? "",
  );
  const [body, setBody] = useState<SerializedRichTextDocument>(() =>
    initialPost === undefined
      ? emptyRichTextBody()
      : serializeRichTextDocument(initialPost.body),
  );
  const [bodyInvalid, setBodyInvalid] = useState(false);
  const effectiveSlug = slugEdited ? slug : blogPostSlugFromTitle(title);

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        onSave({
          title: title.trim(),
          slug: effectiveSlug,
          excerpt: blogPostSummary(summary, body, title.trim()),
          seo: {
            title: seoTitle.trim(),
            description: seoDescription.trim(),
            keywords: parseSeoKeywords(keywords),
            shareImage: toSeoShareImage(shareImageUrl, shareImageAlt),
          },
          mainImage: toSeoShareImage(mainImageUrl, mainImageAlt),
          body,
        });
      }}
    >
      <label className="composer-title">
        <span>Title</span>
        <input
          name="title"
          required
          maxLength={160}
          placeholder="Post title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>
      <div className="composer-main-image">
        <ChangePhotoField
          label="Main image — shown large at the top of the post"
          value={mainImageUrl}
          onChange={setMainImageUrl}
          media={media}
        />
        <label>
          <span>Main image description</span>
          <small className="composer-hint">
            Describe the picture for people who cannot see it.
          </small>
          <input
            name="mainImageAlt"
            maxLength={300}
            value={mainImageAlt}
            onChange={(event) => setMainImageAlt(event.target.value)}
          />
        </label>
      </div>
      <RichTextEditor
        id={editorId}
        label="Post body"
        describedBy={`${editorId}-hint`}
        value={body}
        disabled={busy}
        invalid={bodyInvalid}
        media={media}
        onChange={setBody}
        onValidationChange={setBodyInvalid}
      />
      <p className="composer-hint" id={`${editorId}-hint`}>
        Write the post here. Use the buttons above for headings, bold text,
        lists, links and photos.
      </p>
      <details className="composer-settings">
        <summary>Post settings — summary shown in the blog list</summary>
        <div>
          <label>
            <span>Summary — shown in the blog list</span>
            <textarea
              name="excerpt"
              maxLength={320}
              placeholder="Left empty, the first lines of the post are used."
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
            />
          </label>
        </div>
      </details>
      <details className="composer-settings">
        <summary>SEO and sharing — how this post looks in search and when shared</summary>
        <div>
          {/*
            The web address leads this section because it is the owner's only
            control over the post's canonical URL. See ADR-0008.
          */}
          <label>
            <span>Web address</span>
            <span className="composer-slug">
              <span aria-hidden="true">/blog/</span>
              <input
                name="slug"
                required
                pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                maxLength={120}
                value={effectiveSlug}
                onChange={(event) => {
                  setSlugEdited(true);
                  setSlug(event.target.value);
                }}
              />
            </span>
          </label>
          <label>
            <span>SEO title</span>
            <small className="composer-hint">
              {seoFieldHints.post.title}
            </small>
            <input
              name="seoTitle"
              maxLength={300}
              value={seoTitle}
              onChange={(event) => setSeoTitle(event.target.value)}
            />
          </label>
          <label>
            <span>SEO description</span>
            <small className="composer-hint">
              {seoFieldHints.post.description}
            </small>
            <textarea
              name="seoDescription"
              maxLength={1000}
              value={seoDescription}
              onChange={(event) => setSeoDescription(event.target.value)}
            />
          </label>
          <label>
            <span>Keywords</span>
            <small className="composer-hint">{seoFieldHints.keywords}</small>
            <input
              name="seoKeywords"
              value={keywords}
              aria-invalid={tooManyKeywords}
              aria-describedby="seo-keywords-error"
              onChange={(event) => setKeywords(event.target.value)}
            />
            <small className="composer-error" id="seo-keywords-error">
              {tooManyKeywords ? seoFieldHints.tooManyKeywords : ""}
            </small>
          </label>
          <ChangePhotoField
            label="Thumbnail — shown in the blog list and when the post is shared"
            value={shareImageUrl}
            onChange={setShareImageUrl}
            media={media}
          />
          <p className="composer-hint">{seoFieldHints.shareImageUrl}</p>
          <label>
            <span>Thumbnail description</span>
            <small className="composer-hint">
              {seoFieldHints.shareImageAlt}
            </small>
            <input
              name="seoShareImageAlt"
              maxLength={300}
              value={shareImageAlt}
              onChange={(event) => setShareImageAlt(event.target.value)}
            />
          </label>
        </div>
      </details>
      <ComposerActions
        busy={busy}
        saveLabel={saveLabel}
        blocked={bodyInvalid || tooManyKeywords}
        onCancel={onCancel}
      />
    </form>
  );
}

/** A local date and time, and a submit button, for scheduling one post. */
function ScheduleForm({
  busy,
  onSchedule,
}: {
  busy: boolean;
  onSchedule(localValue: string): void;
}) {
  const [localValue, setLocalValue] = useState("");
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSchedule(localValue);
      }}
    >
      <label>
        <span>Publish date and time</span>
        <small className="composer-hint">
          In your own time zone ({Intl.DateTimeFormat().resolvedOptions().timeZone}).
        </small>
        <input
          type="datetime-local"
          required
          value={localValue}
          disabled={busy}
          onChange={(event) => setLocalValue(event.target.value)}
        />
      </label>
      <button type="submit" className="copy-button" disabled={busy}>
        {busy ? "Scheduling…" : "Schedule"}
      </button>
    </form>
  );
}

/** The plain words for where a post stands, and the one action that fits. */
function blogPostStanding(
  post: Pick<BlogPost, "id" | "targetVisibility">,
  verifiedPublicPostIds: ReadonlySet<BlogPostId>,
): Readonly<{
  label: string;
  operation: "unpublish_blog_post" | "republish_blog_post" | null;
  actionLabel: string | null;
}> {
  const operation = blogPostLifecycleAction(post, verifiedPublicPostIds);
  if (operation === "unpublish_blog_post") {
    return { label: "On your site", operation, actionLabel: "Unpublish" };
  }
  if (operation === "republish_blog_post") {
    return {
      label: "Draft — not on your site",
      operation,
      actionLabel: "Publish",
    };
  }
  return {
    label:
      post.targetVisibility === "public"
        ? "Goes live when you next publish the site"
        : "Comes off the site when you next publish",
    operation: null,
    actionLabel: null,
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

export { formatLocalScheduleTime } from "./schedule-time-format";

/**
 * The plain-words line under a post about its schedule, and whether the
 * post is eligible to show a "Schedule" control at all (it is active and
 * has no active schedule already). This does not decide whether scheduling
 * needs a preview first — that depends on what preview this browser session
 * has actually shown, which only the component (not this summary) knows.
 * See `previewedRevision` in `BlogPostControls`.
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
  const execution = summary?.latestExecution;
  if (
    execution === undefined ||
    execution === null ||
    (execution.state !== "failed" && execution.state !== "blocked")
  ) {
    return null;
  }
  return summary!.liveRevisionId !== null
    ? "Update failed; the previous version remains live."
    : "First publication failed; it is not live yet.";
}

const scheduleNeedsApprovalMessage =
  "Scheduling needs a preview of this exact version. Preview this post, " +
  "then schedule it. Editing the post after that clears its schedule, so " +
  "schedule it again after any later edit.";

const blogOperationErrorMessages: Readonly<Record<string, string>> = {
  approval_stale: scheduleNeedsApprovalMessage,
  approval_required: scheduleNeedsApprovalMessage,
  local_time_invalid: "That date and time could not be read. Try again.",
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

function blogOperationErrorMessage(code: string): string {
  return blogOperationErrorMessages[code] ??
    "The change was not accepted. Refresh and try again.";
}

function blogOperationErrorCode(body: unknown): string {
  return typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof body.error === "string"
    ? body.error
    : "";
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
 * revision — the site as it will look once this post is off it. This is
 * the honest "a human reviewed this" step: nothing here submits an
 * approval, it only finds and shows the preview so a person can actually
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
      idempotencyKey: mutationKey("recover-archive-withdrawal-access"),
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
      idempotencyKey: mutationKey("open-archive-withdrawal-preview"),
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
      message: "The preview could not be opened. Try again.",
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
      idempotencyKey: mutationKey("approve-archive-withdrawal"),
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
      idempotencyKey: mutationKey("continue-archive-withdrawal"),
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

export function BlogPostControls({
  revision,
  csrfToken,
  siteImages,
  verifiedPublicPostIds,
  postSummaries,
  archivedPosts,
  pendingScheduleRequestAgentNames,
}: {
  revision: ContentRevision;
  csrfToken: string;
  siteImages: ReadonlyArray<SiteImageTile>;
  verifiedPublicPostIds: ReadonlyArray<BlogPostId>;
  postSummaries: ReadonlyMap<BlogPostId, BlogPostOperationalSummary>;
  archivedPosts: ReadonlyArray<ArchivedBlogPostSummary>;
  /**
   * The app's own name for each post with a pending schedule request,
   * keyed by post id. A post missing from this map still shows the request
   * with the plain word "An app" — see CONTEXT.md "App / Connected app".
   */
  pendingScheduleRequestAgentNames: ReadonlyMap<BlogPostId, string>;
}) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [mutationToken, setMutationToken] = useState(csrfToken);
  const [pendingAttempt, setPendingAttempt] =
    useState<ContentRevisionAttempt | null>(null);
  const posts = revision.definition.blog.posts;
  // The composer opens by itself when there is nothing to list yet.
  const [writingNew, setWritingNew] = useState(posts.length === 0);
  const [editingPostId, setEditingPostId] = useState<string | null>(null);
  const verifiedPublicPosts = new Set(verifiedPublicPostIds);
  // The exact content revision this browser session has opened a preview
  // for. Scheduling asserts to the server that a human inspected the
  // preview (the same claim the site-wide Publish button already makes —
  // see `approveRevision` in content-editor.tsx) so that assertion has to
  // be backed by an actual preview open in this session, not just a
  // previously-approved state that might be stale or belong to someone else.
  const [previewedRevision, setPreviewedRevision] = useState<number | null>(
    null,
  );
  // The exact withdrawal revision (a separate workspace from `revision`,
  // one per stalled archive) this browser session has opened a preview
  // for, keyed by post ID. Confirming a stalled archive asserts the same
  // "a human inspected the preview" claim scheduling does, so it is only
  // enabled once this session actually opened that withdrawal's preview.
  const [withdrawalPreviews, setWithdrawalPreviews] = useState<
    ReadonlyMap<string, ArchiveWithdrawalLocation>
  >(new Map());

  async function send(body: unknown, operation: string) {
    const attempt =
      pendingAttempt ?? {
        body: JSON.stringify(body),
        idempotencyKey: mutationKey(operation),
      };
    setPendingAttempt(attempt);
    setBusy(true);
    setMessage("");
    try {
      const result = await sendContentRevisionAttempt({
        attempt,
        mutationToken,
      });
      setMutationToken(result.mutationToken);
      setPendingAttempt(null);
      if (!result.response.ok) {
        setMessage("The change was not accepted. Refresh and try again.");
        return;
      }
      // Reload the destination the owner is on — Blog — with the workspace
      // pinned. The old dashboard had one page to return to; this component
      // now renders on its own route.
      window.location.assign(
        `${window.location.pathname}?workspace=${encodeURIComponent(
          revision.workspaceId,
        )}`,
      );
    } catch {
      setMessage(
        "The result is not yet known. Retrying sends the exact same change, so nothing is duplicated.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function openPostPreview(post: BlogPost) {
    const popup = window.open("", "_blank");
    if (popup !== null) popup.opener = null;
    setBusy(true);
    setMessage("");
    try {
      const result = await sendContentRevisionAttempt({
        attempt: {
          body: JSON.stringify({
            operation: "open_preview",
            workspaceId: revision.workspaceId,
            revision: revision.revision,
          }),
          idempotencyKey: mutationKey("open-blog-preview"),
        },
        mutationToken,
      });
      setMutationToken(result.mutationToken);
      if (
        !result.response.ok ||
        typeof result.body !== "object" ||
        result.body === null ||
        !("previewUrl" in result.body) ||
        typeof result.body.previewUrl !== "string"
      ) {
        throw new Error("blog_preview_access_failed");
      }
      setPreviewedRevision(revision.revision);
      const destination = blogPostPreviewUrl(result.body.previewUrl, post.slug);
      if (popup === null) {
        window.open(destination, "_blank", "noopener,noreferrer");
      } else {
        popup.location.href = destination;
      }
    } catch {
      popup?.close();
      setMessage("The preview could not be opened. Try again.");
    } finally {
      setBusy(false);
    }
  }

  /**
   * Sends one command to the blog-operations route (schedule, cancel
   * schedule, archive, restore, retry execution). On success this reloads
   * the page, exactly like `send` does for the ordinary post edits, so the
   * reloaded server data always carries the exact current schedule/archive
   * state — there is no separate client-side cache of it to go stale.
   */
  async function sendBlogOperation(body: unknown, operation: string) {
    setBusy(true);
    setMessage("");
    try {
      const result = await sendHumanMutationAttempt({
        url: "/api/foundry-cms/blog-operations",
        attempt: {
          body: JSON.stringify(body),
          idempotencyKey: mutationKey(operation),
        },
        mutationToken,
      });
      setMutationToken(result.mutationToken);
      if (!result.response.ok) {
        setMessage(
          blogOperationErrorMessage(blogOperationErrorCode(result.body)),
        );
        return;
      }
      window.location.assign(
        `${window.location.pathname}?workspace=${encodeURIComponent(
          revision.workspaceId,
        )}`,
      );
    } catch {
      setMessage("The change could not be confirmed. Check the post, then try again.");
    } finally {
      setBusy(false);
    }
  }

  /**
   * Opens the exact preview of a stalled archive's withdrawal revision —
   * the site without this post — in a new tab, so a person can actually
   * look at it before confirming. Records the previewed withdrawal so
   * "Confirm and continue archiving" only enables for this exact one.
   */
  async function previewArchiveWithdrawal(archived: ArchivedBlogPostSummary) {
    if (archived.archiveRequestId === null) return;
    const popup = window.open("", "_blank");
    if (popup !== null) popup.opener = null;
    setBusy(true);
    setMessage("");
    try {
      const result = await openArchiveWithdrawalPreview({
        postId: archived.postId,
        archiveRequestId: archived.archiveRequestId,
        mutationToken,
      });
      setMutationToken(result.mutationToken);
      if (result.outcome === "failed") {
        popup?.close();
        setMessage(result.message);
        return;
      }
      setWithdrawalPreviews((previous) => {
        const next = new Map(previous);
        next.set(archived.postId, result.withdrawal);
        return next;
      });
      if (popup === null) {
        window.open(result.previewUrl, "_blank", "noopener,noreferrer");
      } else {
        popup.location.href = result.previewUrl;
      }
    } catch {
      popup?.close();
      setMessage("The preview could not be opened. Try again.");
    } finally {
      setBusy(false);
    }
  }

  /**
   * Confirms and continues a stalled archive's withdrawal. Only meaningful
   * once this session has previewed that exact withdrawal — the button
   * that calls this is disabled until then. Reloads on success, exactly
   * like `sendBlogOperation`, so the reloaded archived-posts list always
   * shows the server's current state.
   */
  async function confirmContinueArchive(archived: ArchivedBlogPostSummary) {
    if (archived.archiveRequestId === null) return;
    const withdrawal = withdrawalPreviews.get(archived.postId);
    if (withdrawal === undefined) return;
    setBusy(true);
    setMessage("");
    try {
      const result = await confirmArchiveWithdrawal({
        postId: archived.postId,
        archiveRequestId: archived.archiveRequestId,
        withdrawal,
        mutationToken,
      });
      setMutationToken(result.mutationToken);
      if (result.outcome === "failed") {
        setMessage(result.message);
        return;
      }
      window.location.assign(
        `${window.location.pathname}?workspace=${encodeURIComponent(
          revision.workspaceId,
        )}`,
      );
    } catch {
      setMessage(
        "The change could not be confirmed. Check the post, then try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  /**
   * Records that a human reviewed the site's current preview, so the post
   * can be scheduled. This is the same approval the site-wide Publish
   * button on Pages records — scheduling a post needs the whole site's
   * preview approved, because a post's fingerprint is bound to it.
   */
  async function approveCurrentRevisionForScheduling(): Promise<
    string | null
  > {
    const result = await sendHumanMutationAttempt({
      url: "/api/foundry-cms/publications",
      attempt: {
        body: JSON.stringify({
          operation: "approve",
          workspaceId: revision.workspaceId,
          revision: revision.revision,
          previewConfirmed: true,
        }),
        idempotencyKey: mutationKey("approve-for-schedule"),
      },
      mutationToken,
    });
    setMutationToken(result.mutationToken);
    if (
      !result.response.ok ||
      typeof result.body !== "object" ||
      result.body === null ||
      !("id" in result.body) ||
      typeof result.body.id !== "string"
    ) {
      return null;
    }
    return result.body.id;
  }

  async function schedulePost(post: BlogPost, localValue: string) {
    const instant = new Date(localValue);
    if (localValue === "" || Number.isNaN(instant.getTime())) {
      setMessage("That date and time could not be read. Try again.");
      return;
    }
    setBusy(true);
    setMessage("");
    const approvalId = await approveCurrentRevisionForScheduling();
    setBusy(false);
    if (approvalId === null) {
      setMessage(scheduleNeedsApprovalMessage);
      return;
    }
    const browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const resolvedTime = resolvePostPublicationInstant(
      instant.toISOString(),
      browserTimeZone,
    );
    await sendBlogOperation(
      {
        operation: "activate_schedule",
        postId: post.id,
        approvalId,
        resolvedTime,
      },
      "activate-blog-post-schedule",
    );
  }

  function savePost(
    post: Readonly<{
      title: string;
      slug: string;
      excerpt: string;
      seo: SeoMetadata;
      mainImage: SeoShareImage | null;
      body: SerializedRichTextDocument;
    }>,
    existingPostId?: string,
  ) {
    const shared = {
      workspaceId: revision.workspaceId,
      schemaVersion: revision.definition.schemaVersion,
      baseRevision: revision.revision,
    };
    // Blank SEO fields are saved blank on purpose. The renderer fills them
    // from the post title and summary, so a later edit to either keeps the
    // search result and the link preview in step.
    void send(
      existingPostId === undefined
        ? {
            operation: "create_blog_post",
            ...shared,
            post: { id: crypto.randomUUID(), ...post },
          }
        : {
            operation: "edit_blog_post",
            ...shared,
            postId: existingPostId,
            post,
          },
      existingPostId === undefined ? "create-blog-post" : "edit-blog-post",
    );
  }

  const sitePublishPending = blogHasPendingSitePublish(
    posts,
    verifiedPublicPosts,
  );

  return (
    <section aria-labelledby="blog-posts-heading">
      <div className="dashboard-section-heading">
        <div>
          <h2 id="blog-posts-heading">Posts</h2>
          <p>
            Write a post, preview it privately, and publish it when it is
            ready.
          </p>
        </div>
        {writingNew || editingPostId !== null ? null : (
          <button
            type="button"
            className="button button-primary"
            disabled={busy}
            onClick={() => setWritingNew(true)}
          >
            New post
          </button>
        )}
      </div>
      {sitePublishPending ? (
        <p className="composer-hint">
          A post here is marked for the next site publish and is not live
          until then.{" "}
          <a href="/dash/pages" className="button button-primary">
            Publish the site
          </a>
        </p>
      ) : null}
      <PublishingConnectionStatus />
      {writingNew ? (
        <PostComposer
          editorId="post-body"
          media={{
            csrfToken: mutationToken,
            workspaceId: revision.workspaceId,
            siteImages,
          }}
          busy={busy || pendingAttempt !== null}
          saveLabel={busy ? "Saving…" : "Save draft"}
          onSave={(post) => savePost(post)}
          onCancel={
            posts.length === 0 ? undefined : () => setWritingNew(false)
          }
        />
      ) : null}
      <ul className="post-list">
        {posts.map((post) => {
          const standing = blogPostStanding(post, verifiedPublicPosts);
          const standingOperation = standing.operation;
          const summary = postSummaries.get(post.id);
          const scheduleStanding = blogPostScheduleStanding(summary);
          const executionFailure = blogPostExecutionFailureNote(summary);
          if (editingPostId === post.id) {
            return (
              <li key={post.id} className="post-list-editing">
                <PostComposer
                  editorId="post-body"
                  initialPost={post}
                  media={{
                    csrfToken: mutationToken,
                    workspaceId: revision.workspaceId,
                    siteImages,
                  }}
                  busy={busy || pendingAttempt !== null}
                  saveLabel={busy ? "Saving…" : "Save changes"}
                  onSave={(edited) => savePost(edited, post.id)}
                  onCancel={() => setEditingPostId(null)}
                />
              </li>
            );
          }
          const pendingRequest = summary?.pendingScheduleProposal ?? null;
          const pendingRequestAgentName =
            pendingScheduleRequestAgentNames.get(post.id) ?? "An app";
          return (
            <li key={post.id} id={`blog-post-${post.id}`}>
              <div className="post-list-info">
                <div className="post-list-summary">
                  <strong>{post.title}</strong>
                  <span>{standing.label}</span>
                </div>
                {scheduleStanding.line === null ? null : (
                  <p className="composer-hint">{scheduleStanding.line}</p>
                )}
                {executionFailure === null ? null : (
                  <p className="composer-hint" role="alert">
                    {executionFailure}
                  </p>
                )}
                {pendingRequest === null ? null : (
                  <p className="composer-hint" role="alert">
                    {pendingRequestAgentName} asked to publish this at{" "}
                    {formatLocalScheduleTime(
                      pendingRequest.localDateTime,
                      pendingRequest.ianaTimeZone,
                    )}
                    . Use "Schedule this post" below to publish it then, or
                    decline the request.{" "}
                    <button
                      type="button"
                      className="copy-button"
                      disabled={busy}
                      onClick={() => {
                        void sendBlogOperation(
                          {
                            operation: "decline_schedule_proposal",
                            postId: post.id,
                            proposalId: pendingRequest.id,
                          },
                          "decline-blog-post-schedule-proposal",
                        );
                      }}
                    >
                      Decline
                    </button>
                  </p>
                )}
              </div>
              <div className="post-list-actions">
                <button
                  type="button"
                  className="copy-button"
                  disabled={busy}
                  onClick={() => {
                    setWritingNew(false);
                    setEditingPostId(post.id);
                  }}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="copy-button"
                  disabled={busy}
                  onClick={() => void openPostPreview(post)}
                >
                  Preview ↗
                </button>
                {standingOperation === null ? null : (
                  <button
                    type="button"
                    className="copy-button"
                    disabled={busy || pendingAttempt !== null}
                    onClick={() => {
                      void send(
                        {
                          operation: standingOperation,
                          workspaceId: revision.workspaceId,
                          schemaVersion: revision.definition.schemaVersion,
                          baseRevision: revision.revision,
                          postId: post.id,
                        },
                        standingOperation,
                      );
                    }}
                  >
                    {standing.actionLabel}
                  </button>
                )}
                {summary?.activeSchedule !== null &&
                summary?.activeSchedule !== undefined ? (
                  <button
                    type="button"
                    className="copy-button"
                    disabled={busy}
                    onClick={() => {
                      void sendBlogOperation(
                        {
                          operation: "cancel_schedule",
                          postId: post.id,
                          scheduleId: summary.activeSchedule!.id,
                        },
                        "cancel-blog-post-schedule",
                      );
                    }}
                  >
                    Cancel schedule
                  </button>
                ) : null}
                {executionFailure !== null && summary !== undefined ? (
                  <button
                    type="button"
                    className="copy-button"
                    disabled={busy}
                    onClick={() => {
                      void sendBlogOperation(
                        {
                          operation: "retry_execution",
                          postId: post.id,
                          executionId: summary.latestExecution!.executionId,
                        },
                        "retry-blog-post-execution",
                      );
                    }}
                  >
                    Retry
                  </button>
                ) : null}
                <button
                  type="button"
                  className="copy-button"
                  disabled={busy || summary === undefined}
                  onClick={() => {
                    if (summary === undefined) return;
                    const liveNotice = standing.label === "On your site"
                      ? " This post is on the site now; archiving takes it off the site first."
                      : "";
                    if (
                      !window.confirm(
                        `Archive "${post.title}"?${liveNotice} It moves to Archived posts and can be restored as a draft later.`,
                      )
                    ) {
                      return;
                    }
                    void sendBlogOperation(
                      {
                        operation: "archive",
                        postId: post.id,
                        selectedPostRevisionId: summary.postRevisionId,
                      },
                      "archive-blog-post",
                    );
                  }}
                >
                  Archive
                </button>
              </div>
              {!scheduleStanding.canSchedule ? null : (
                <div className="post-list-full-row">
                  {previewedRevision === revision.revision ? (
                    <details className="composer-settings">
                      <summary>Schedule this post</summary>
                      <ScheduleForm
                        busy={busy}
                        onSchedule={(localValue) =>
                          void schedulePost(post, localValue)}
                      />
                    </details>
                  ) : (
                    <p className="composer-hint">
                      {scheduleNeedsApprovalMessage}
                    </p>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {archivedPosts.length === 0 ? null : (
        <section aria-labelledby="archived-blog-posts-heading">
          <div className="dashboard-section-heading">
            <div>
              <h2 id="archived-blog-posts-heading">Archived posts</h2>
              <p>
                Archived posts are off the site. Restore one to bring it back
                as a new draft.
              </p>
            </div>
          </div>
          <ul className="post-list">
            {archivedPosts.map((archived) => (
              <li key={archived.postId}>
                <div className="post-list-summary">
                  <strong>
                    {archived.title === "" ? "Untitled post" : archived.title}
                  </strong>
                  <span>
                    {archived.collectionState === "archiving"
                      ? "Archiving — coming off the site"
                      : "Archived"}
                  </span>
                </div>
                {archived.collectionState === "archiving" ? (
                  <p className="composer-hint">
                    Archive pending; the post remains live until this
                    finishes. This can take a few minutes. Preview the site
                    without this post, then confirm to finish taking it off
                    the site.
                  </p>
                ) : null}
                {archived.collectionState === "archiving" &&
                withdrawalPreviews.get(archived.postId) === undefined ? (
                  <p className="composer-hint">
                    Preview the site without this post before you can
                    confirm. This shows what visitors will see once the
                    post is fully off the site.
                  </p>
                ) : null}
                <div className="post-list-actions">
                  {archived.collectionState === "archiving" &&
                  archived.archiveRequestId !== null ? (
                    <>
                      <button
                        type="button"
                        className="copy-button"
                        disabled={busy}
                        onClick={() => {
                          void previewArchiveWithdrawal(archived);
                        }}
                      >
                        Preview the site without this post ↗
                      </button>
                      <button
                        type="button"
                        className="copy-button"
                        disabled={
                          busy ||
                          withdrawalPreviews.get(archived.postId) ===
                            undefined
                        }
                        onClick={() => {
                          void confirmContinueArchive(archived);
                        }}
                      >
                        Confirm and continue archiving
                      </button>
                      <button
                        type="button"
                        className="copy-button"
                        disabled={busy}
                        onClick={() => {
                          void sendBlogOperation(
                            {
                              operation: "recover_archive_withdrawal_access",
                              postId: archived.postId,
                              archiveRequestId: archived.archiveRequestId,
                            },
                            "recover-archive-withdrawal-access",
                          );
                        }}
                      >
                        Recover access
                      </button>
                    </>
                  ) : null}
                  <button
                    type="button"
                    className="copy-button"
                    disabled={busy || archived.collectionState !== "archived"}
                    onClick={() => {
                      void sendBlogOperation(
                        {
                          operation: "restore",
                          postId: archived.postId,
                          selectedPostRevisionId: archived.postRevisionId,
                        },
                        "restore-blog-post",
                      );
                    }}
                  >
                    Restore as draft
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      {pendingAttempt === null ? null : (
        <button
          type="button"
          className="copy-button"
          disabled={busy}
          onClick={() => {
            void send(JSON.parse(pendingAttempt.body), "retry-blog-post");
          }}
        >
          Retry the last change
        </button>
      )}
      {message === "" ? null : <p role="alert">{message}</p>}
    </section>
  );
}
