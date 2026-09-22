"use client";

import { useState } from "react";

import {
  resolvePostPublicationInstant,
  type BlogPostOperationalSummary,
  type ContentRevision,
} from "@humber-foundry/application";
import type { BlogPost } from "@humber-foundry/site-definition";

import { BlogCommandFeedback } from "./blog-command-feedback";
import { blogListHref, blogPostHref } from "./blog-links";
import {
  blogMutationKey,
  blogPostExecutionFailureNote,
  blogPostPreviewUrl,
  blogPostScheduleStanding,
  blogPostStanding,
  formatLocalScheduleTime,
  scheduleNeedsApprovalMessage,
} from "./blog-operations";
import { BlogPostComposer } from "./blog-post-composer";
import { DashboardStateLabel } from "./dashboard-state-label";
import { PublishingConnectionStatus } from "./connection-status";
import type { SiteImageTile } from "../src/site-used-photos";
import type { BlogPostId } from "@humber-foundry/site-definition";
import {
  sendContentRevisionAttempt,
  sendHumanMutationAttempt,
} from "../src/content-revision-client";
import { useBlogCommands } from "./use-blog-commands";

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
      <button type="submit" className="dash-button dash-button-plain" disabled={busy}>
        {busy ? "Scheduling…" : "Schedule"}
      </button>
    </form>
  );
}

/**
 * One saved post, on its own screen (#230): where it stands, the preview of
 * this exact draft, the schedule that preview unlocks, and the writing box.
 *
 * Nothing here remembers that a change was accepted. Every accepted change
 * loads this screen again from the server, so what the owner reads is what the
 * server holds.
 */
export function BlogPostScreen({
  revision,
  post,
  csrfToken,
  siteImages,
  verifiedPublicPostIds,
  summary,
  pendingScheduleRequestAgentName,
}: {
  revision: ContentRevision;
  post: BlogPost;
  csrfToken: string;
  siteImages: ReadonlyArray<SiteImageTile>;
  verifiedPublicPostIds: ReadonlyArray<BlogPostId>;
  summary: BlogPostOperationalSummary | undefined;
  /**
   * The app's own name, when an app has asked to publish this post and nobody
   * has answered yet. `null` when no app has asked. A request nobody has named
   * still reads as the plain word "An app" — see CONTEXT.md "App / Connected
   * app".
   */
  pendingScheduleRequestAgentName: string | null;
}) {
  const commands = useBlogCommands({
    csrfToken,
    returnTo: blogPostHref(post.id, revision.workspaceId),
  });
  // The exact content revision this browser session has opened a preview
  // for. Scheduling asserts to the server that a human inspected the
  // preview (the same claim the site-wide Publish button already makes —
  // see `approveRevision` in content-editor.tsx) so that assertion has to
  // be backed by an actual preview open in this session, not just a
  // previously-approved state that might be stale or belong to someone else.
  const [previewedRevision, setPreviewedRevision] = useState<number | null>(
    null,
  );
  const standing = blogPostStanding(post, new Set(verifiedPublicPostIds));
  const scheduleStanding = blogPostScheduleStanding(summary);
  const executionFailure = blogPostExecutionFailureNote(summary);
  const pendingRequest = summary?.pendingScheduleProposal ?? null;
  const listHref = blogListHref(revision.workspaceId);

  async function openPostPreview() {
    const popup = window.open("", "_blank");
    if (popup !== null) popup.opener = null;
    commands.setMessage("");
    try {
      const result = await sendContentRevisionAttempt({
        attempt: {
          body: JSON.stringify({
            operation: "open_preview",
            workspaceId: revision.workspaceId,
            revision: revision.revision,
          }),
          idempotencyKey: blogMutationKey("open-blog-preview"),
        },
        mutationToken: commands.mutationToken,
      });
      commands.setMutationToken(result.mutationToken);
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
      commands.setMessage("The preview could not be opened. Try again.");
    }
  }

  /**
   * Records that a human reviewed the site's current preview, so the post
   * can be scheduled. This is the same approval the site-wide Publish
   * button on Pages records — scheduling a post needs the whole site's
   * preview approved, because a post's fingerprint is bound to it.
   */
  async function approveCurrentRevisionForScheduling(): Promise<string | null> {
    const result = await sendHumanMutationAttempt({
      url: "/api/foundry-cms/publications",
      attempt: {
        body: JSON.stringify({
          operation: "approve",
          workspaceId: revision.workspaceId,
          revision: revision.revision,
          previewConfirmed: true,
        }),
        idempotencyKey: blogMutationKey("approve-for-schedule"),
      },
      mutationToken: commands.mutationToken,
    });
    commands.setMutationToken(result.mutationToken);
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

  async function schedulePost(localValue: string) {
    const instant = new Date(localValue);
    if (localValue === "" || Number.isNaN(instant.getTime())) {
      commands.setMessage("That date and time could not be read. Try again.");
      return;
    }
    commands.setMessage("");
    const approvalId = await approveCurrentRevisionForScheduling();
    if (approvalId === null) {
      commands.setMessage(scheduleNeedsApprovalMessage);
      return;
    }
    const browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    await commands.sendBlogOperation(
      {
        operation: "activate_schedule",
        postId: post.id,
        approvalId,
        resolvedTime: resolvePostPublicationInstant(
          instant.toISOString(),
          browserTimeZone,
        ),
      },
      "activate-blog-post-schedule",
    );
  }

  return (
    <section aria-label="This post">
      <PublishingConnectionStatus />
      <div className="dash-post-standing">
        <DashboardStateLabel tone={standing.tone}>
          {standing.label}
        </DashboardStateLabel>
        <button
          type="button"
          className="dash-button dash-button-plain"
          disabled={commands.busy}
          onClick={() => void openPostPreview()}
        >
          Preview ↗
        </button>
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
        <p className="composer-hint">
          {pendingScheduleRequestAgentName ?? "An app"} asked to publish this
          at{" "}
          {formatLocalScheduleTime(
            pendingRequest.localDateTime,
            pendingRequest.ianaTimeZone,
          )}
          . Use "Schedule this post" below to publish it then, or decline the
          request on the posts list.
        </p>
      )}
      {!scheduleStanding.canSchedule ? null : (
        <div className="dash-post-schedule">
          {previewedRevision === revision.revision ? (
            <details className="composer-settings">
              <summary>Schedule this post</summary>
              <ScheduleForm
                busy={commands.busy}
                onSchedule={(localValue) => void schedulePost(localValue)}
              />
            </details>
          ) : (
            <p className="composer-hint">{scheduleNeedsApprovalMessage}</p>
          )}
        </div>
      )}
      <BlogPostComposer
        editorId="post-body"
        initialPost={post}
        media={{
          csrfToken: commands.mutationToken,
          workspaceId: revision.workspaceId,
          siteImages,
        }}
        busy={commands.busy || commands.pendingAttempt !== null}
        saveLabel={commands.busy ? "Saving…" : "Save changes"}
        onSave={(edited) => {
          void commands.sendRevisionCommand(
            {
              operation: "edit_blog_post",
              workspaceId: revision.workspaceId,
              schemaVersion: revision.definition.schemaVersion,
              baseRevision: revision.revision,
              postId: post.id,
              post: edited,
            },
            "edit-blog-post",
          );
        }}
        onCancel={() => window.location.assign(listHref)}
      />
      <BlogCommandFeedback commands={commands} />
    </section>
  );
}
