"use client";

import { useState } from "react";

import type {
  ArchivedBlogPostSummary,
  BlogPostOperationalSummary,
  ContentRevision,
} from "@humber-foundry/application";
import type { BlogPostId } from "@humber-foundry/site-definition";

import { BlogCommandFeedback } from "./blog-command-feedback";
import { blogListHref, blogPostHref, newBlogPostHref } from "./blog-links";
import { withWorkspace } from "./dashboard-links";
import {
  blogHasPendingSitePublish,
  blogPostExecutionFailureNote,
  blogPostName,
  blogPostScheduleStanding,
  blogPostStanding,
  blogScreenDescription,
  changeNotConfirmedMessage,
  confirmArchiveWithdrawal,
  formatLocalScheduleTime,
  openArchiveWithdrawalPreview,
  openInNewTab,
  previewNotOpenedMessage,
  type ArchiveWithdrawalLocation,
} from "./blog-operations";
import { PublishingConnectionStatus } from "./connection-status";
import {
  DashboardActionMenu,
  type DashboardAction,
} from "./dashboard-action-menu";
import { DashboardEmptyState } from "./dashboard-empty-state";
import { DashboardList, DashboardListRow } from "./dashboard-list";
import { DashboardPageHeader } from "./dashboard-page-header";
import { DashboardStateLabel } from "./dashboard-state-label";
import { formatDashboardMoment } from "../src/dashboard-time";
import { useBlogCommands } from "./use-blog-commands";

/**
 * Every post this site holds, newest work first.
 *
 * This is where Blog opens, even on a site with no posts (#230). Before, the
 * writing box opened by itself on an empty site and hid the list, the "New
 * post" control and the per-post preview, so a site owner never saw that they
 * were there. Writing one post now lives on its own screen; this one lists
 * what exists and offers the way in.
 *
 * Every action on a post row goes through the row's "…" menu. Which actions a
 * row carries depends on where that post stands — a post with no schedule has
 * nothing to cancel — so the menus are not all the same length. An action the
 * owner may not take is left out rather than shown turned off.
 *
 * Archived posts keep a plain row of buttons under their own heading. An
 * archived post has left the draft, so it has no screen of its own to open and
 * `DashboardListRow` does not fit it. Its "Confirm and continue archiving" is
 * also the one control the dashboard shows turned off on purpose: the sentence
 * beside it says a preview has to be opened first, which is the reason
 * `DashboardActionMenu` asks for and cannot carry.
 */
export function BlogPostList({
  revision,
  csrfToken,
  verifiedPublicPostIds,
  postSummaries,
  archivedPosts,
  pendingScheduleRequestAgentNames,
}: {
  revision: ContentRevision;
  csrfToken: string;
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
  const commands = useBlogCommands({
    csrfToken,
    returnTo: blogListHref(revision.workspaceId),
  });
  // The exact withdrawal revision (a separate workspace from `revision`,
  // one per stalled archive) this browser session has opened a preview
  // for, keyed by post ID. Confirming a stalled archive asserts the same
  // "a human inspected the preview" claim scheduling does, so it is only
  // enabled once this session actually opened that withdrawal's preview.
  const [withdrawalPreviews, setWithdrawalPreviews] = useState<
    ReadonlyMap<string, ArchiveWithdrawalLocation>
  >(new Map());

  const posts = revision.definition.blog.posts;
  const verifiedPublicPosts = new Set(verifiedPublicPostIds);
  const sitePublishPending = blogHasPendingSitePublish(
    posts,
    verifiedPublicPosts,
  );
  const draftSaved = formatDashboardMoment(revision.createdAt);
  // A change is on its way to the server. The old screen turned every row
  // button off while that was true, so a second command could not start on
  // top of the first. `DashboardActionMenu` never draws an action turned off,
  // so the menu is left out until the answer arrives instead.
  const changeInFlight = commands.busy || commands.pendingAttempt !== null;

  /**
   * Opens the exact preview of a stalled archive's withdrawal revision —
   * the site without this post — in a new tab, so a person can actually
   * look at it before confirming. Records the previewed withdrawal so
   * "Confirm and continue archiving" only enables for this exact one.
   */
  async function previewArchiveWithdrawal(archived: ArchivedBlogPostSummary) {
    if (archived.archiveRequestId === null) return;
    const requestId = archived.archiveRequestId;
    // Whether the server's own reason has already been shown. A refusal says
    // why; anything else has no answer to read, so it gets the plain sentence.
    let reasonShown = false;
    commands.setBusy(true);
    commands.setMessage("");
    try {
      await openInNewTab(async () => {
        const result = await openArchiveWithdrawalPreview({
          postId: archived.postId,
          archiveRequestId: requestId,
          mutationToken: commands.mutationToken,
        });
        commands.setMutationToken(result.mutationToken);
        if (result.outcome === "failed") {
          commands.setMessage(result.message);
          reasonShown = true;
          throw new Error("archive_withdrawal_preview_refused");
        }
        setWithdrawalPreviews((previous) => {
          const next = new Map(previous);
          next.set(archived.postId, result.withdrawal);
          return next;
        });
        return result.previewUrl;
      });
    } catch {
      if (!reasonShown) commands.setMessage(previewNotOpenedMessage);
    } finally {
      commands.setBusy(false);
    }
  }

  /**
   * Confirms and continues a stalled archive's withdrawal. Only meaningful
   * once this session has previewed that exact withdrawal — the button
   * that calls this is disabled until then. Loads the list again on success,
   * exactly like every other command here, so the archived posts always show
   * the server's current state.
   */
  async function confirmContinueArchive(archived: ArchivedBlogPostSummary) {
    if (archived.archiveRequestId === null) return;
    const withdrawal = withdrawalPreviews.get(archived.postId);
    if (withdrawal === undefined) return;
    commands.setBusy(true);
    commands.setMessage("");
    try {
      const result = await confirmArchiveWithdrawal({
        postId: archived.postId,
        archiveRequestId: archived.archiveRequestId,
        withdrawal,
        mutationToken: commands.mutationToken,
      });
      commands.setMutationToken(result.mutationToken);
      if (result.outcome === "failed") {
        commands.setMessage(result.message);
        return;
      }
      window.location.assign(blogListHref(revision.workspaceId));
    } catch {
      commands.setMessage(changeNotConfirmedMessage);
    } finally {
      commands.setBusy(false);
    }
  }

  const newPostButton = (
    <a
      className="dash-button dash-button-primary"
      href={newBlogPostHref(revision.workspaceId)}
    >
      New post
    </a>
  );

  return (
    <>
      <DashboardPageHeader
        title="Blog"
        description={blogScreenDescription}
        // The empty state below offers the same control, so the screen never
        // shows two "New post" buttons.
        action={posts.length === 0 ? undefined : newPostButton}
      />
      <section aria-label="Posts">
        {sitePublishPending ? (
          <>
            <p className="composer-hint">
              A post here is marked for the next site publish and is not live
              until then.
            </p>
            <div className="panel-actions">
              {/*
                "New post" in the page heading is this screen's one primary
                button, so this one is plain. It also carries the workspace
                the person is editing, like every other dashboard link.
              */}
              <a
                href={withWorkspace("/dash/pages", revision.workspaceId)}
                className="dash-button dash-button-plain"
              >
                Publish the site
              </a>
            </div>
          </>
        ) : null}
        <PublishingConnectionStatus />
        {posts.length === 0 ? (
          <DashboardEmptyState
            title={
              archivedPosts.length === 0
                ? "No posts yet"
                : "No posts in your draft"
            }
            action={newPostButton}
          >
            {archivedPosts.length === 0
              ? "Write your first post. It stays a private draft until you publish it."
              : "Write a new post, or restore an archived one below."}
          </DashboardEmptyState>
        ) : (
          <>
            <DashboardList label="Your posts">
              {posts.map((post) => {
                const standing = blogPostStanding(post, verifiedPublicPosts);
                const postName = blogPostName(post.title);
                const summary = postSummaries.get(post.id);
                const scheduleStanding = blogPostScheduleStanding(summary);
                const executionFailure = blogPostExecutionFailureNote(summary);
                const pendingRequest = summary?.pendingScheduleProposal ?? null;
                const pendingRequestAgentName =
                  pendingScheduleRequestAgentNames.get(post.id) ?? "An app";
                const actions: DashboardAction[] = [];
                if (pendingRequest !== null) {
                  actions.push({
                    id: "decline",
                    label: "Decline the app's publish request",
                    onSelect: () => {
                      void commands.sendBlogOperation(
                        {
                          operation: "decline_schedule_proposal",
                          postId: post.id,
                          proposalId: pendingRequest.id,
                        },
                        "decline-blog-post-schedule-proposal",
                      );
                    },
                  });
                }
                if (standing.action !== null) {
                  const { operation, label } = standing.action;
                  actions.push({
                    id: operation,
                    label,
                    onSelect: () => {
                      void commands.sendRevisionCommand(
                        {
                          operation,
                          workspaceId: revision.workspaceId,
                          schemaVersion: revision.definition.schemaVersion,
                          baseRevision: revision.revision,
                          postId: post.id,
                        },
                        operation,
                      );
                    },
                  });
                }
                if (summary?.activeSchedule != null) {
                  const scheduleId = summary.activeSchedule.id;
                  actions.push({
                    id: "cancel-schedule",
                    label: "Cancel schedule",
                    onSelect: () => {
                      void commands.sendBlogOperation(
                        {
                          operation: "cancel_schedule",
                          postId: post.id,
                          scheduleId,
                        },
                        "cancel-blog-post-schedule",
                      );
                    },
                  });
                }
                if (
                  executionFailure !== null &&
                  summary?.latestExecution != null
                ) {
                  const executionId = summary.latestExecution.executionId;
                  actions.push({
                    id: "retry",
                    label: "Try publishing again",
                    onSelect: () => {
                      void commands.sendBlogOperation(
                        {
                          operation: "retry_execution",
                          postId: post.id,
                          executionId,
                        },
                        "retry-blog-post-execution",
                      );
                    },
                  });
                }
                if (summary !== undefined) {
                  const postRevisionId = summary.postRevisionId;
                  actions.push({
                    id: "archive",
                    label: "Archive",
                    tone: "destructive",
                    onSelect: () => {
                      const liveNotice =
                        standing.label === "On your site"
                          ? " This post is on the site now; archiving takes it off the site first."
                          : "";
                      if (
                        !window.confirm(
                          `Archive "${postName}"?${liveNotice} It moves to Archived posts and can be restored as a draft later.`,
                        )
                      ) {
                        return;
                      }
                      void commands.sendBlogOperation(
                        {
                          operation: "archive",
                          postId: post.id,
                          selectedPostRevisionId: postRevisionId,
                        },
                        "archive-blog-post",
                      );
                    },
                  });
                }
                const noteParts = [
                  scheduleStanding.line ?? `Last saved ${draftSaved}`,
                  executionFailure,
                  pendingRequest === null
                    ? null
                    : `${pendingRequestAgentName} asked to publish this at ${formatLocalScheduleTime(
                        pendingRequest.localDateTime,
                        pendingRequest.ianaTimeZone,
                      )}`,
                ].filter((part): part is string => part !== null);
                return (
                  <DashboardListRow
                    key={post.id}
                    href={blogPostHref(post.id, revision.workspaceId)}
                    title={postName}
                    note={noteParts.join(" · ")}
                    state={
                      <DashboardStateLabel tone={standing.tone}>
                        {standing.label}
                      </DashboardStateLabel>
                    }
                    // A row carries a menu when there is something to take on
                    // that post. The shared standard asks every row in one
                    // list to hold the same shape; here every active post has
                    // the same actions offered except the ones its own state
                    // rules out — a post with no schedule has nothing to
                    // cancel. A row carries no menu at all only when this
                    // installation has no blog-operations store to read, and
                    // then no row does.
                    actions={
                      actions.length === 0 || changeInFlight ? undefined : (
                        <DashboardActionMenu
                          label={`Actions for ${postName}`}
                          actions={actions}
                        />
                      )
                    }
                  />
                );
              })}
            </DashboardList>
            {/*
              The CMS holds one save time for the whole draft, not one per
              post: a save writes every post together. Pages says the same of
              its own rows (#229). Saying so here keeps the date on each row
              from reading as that post's own.
            */}
            <p className="dash-list-note">
              You last saved this draft on {draftSaved}. A save writes every
              post together, so the CMS holds no separate time for one post.
            </p>
          </>
        )}
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
                    <strong>{blogPostName(archived.title)}</strong>
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
                      Preview the site without this post before you can confirm.
                      This shows what visitors will see once the post is fully
                      off the site.
                    </p>
                  ) : null}
                  <div className="post-list-actions">
                    {archived.collectionState === "archiving" &&
                    archived.archiveRequestId !== null ? (
                      <>
                        <button
                          type="button"
                          className="dash-button dash-button-plain"
                          disabled={changeInFlight}
                          onClick={() => {
                            void previewArchiveWithdrawal(archived);
                          }}
                        >
                          Preview the site without this post ↗
                        </button>
                        <button
                          type="button"
                          className="dash-button dash-button-plain"
                          disabled={
                            changeInFlight ||
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
                          className="dash-button dash-button-plain"
                          disabled={changeInFlight}
                          onClick={() => {
                            void commands.sendBlogOperation(
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
                    {archived.collectionState !== "archived" ? null : (
                      <button
                        type="button"
                        className="dash-button dash-button-plain"
                        disabled={changeInFlight}
                        onClick={() => {
                          void commands.sendBlogOperation(
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
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}
        <BlogCommandFeedback commands={commands} />
      </section>
    </>
  );
}
