import { describe, expect, it, vi } from "vitest";

import type { BlogPostOperationalSummary } from "@humber-foundry/application";
import {
  createBlogPostId,
  type BlogPost,
  type BlogPostId,
} from "@humber-foundry/site-definition";

import {
  blogHasPendingSitePublish,
  blogPostExecutionFailureNote,
  blogPostLifecycleAction,
  blogPostScheduleStanding,
  continueArchiveWithdrawal,
  formatLocalScheduleTime,
} from "./blog-post-controls";

describe("blog post lifecycle controls", () => {
  const postId = createBlogPostId(
    "00000000-0000-4000-8000-00000000000f",
  );
  const verified = new Set<BlogPostId>([postId]);
  const absent = new Set<BlogPostId>();

  function post(targetVisibility: BlogPost["targetVisibility"]) {
    return { id: postId, targetVisibility };
  }

  it("offers unpublish only for a post verified public", () => {
    expect(blogPostLifecycleAction(post("public"), verified)).toBe(
      "unpublish_blog_post",
    );
    expect(blogPostLifecycleAction(post("public"), absent)).toBeNull();
  });

  it("offers republish only after public absence is verified", () => {
    expect(blogPostLifecycleAction(post("unpublished"), absent)).toBe(
      "republish_blog_post",
    );
    expect(
      blogPostLifecycleAction(post("unpublished"), verified),
    ).toBeNull();
  });
});

describe("blog site-publish nudge", () => {
  const postId = createBlogPostId(
    "00000000-0000-4000-8000-00000000000a",
  );

  it("is pending when a public post has not been verified live", () => {
    expect(
      blogHasPendingSitePublish(
        [{ id: postId, targetVisibility: "public" }],
        new Set(),
      ),
    ).toBe(true);
  });

  it("is not pending once every post matches its verified state", () => {
    expect(
      blogHasPendingSitePublish(
        [{ id: postId, targetVisibility: "public" }],
        new Set([postId]),
      ),
    ).toBe(false);
  });
});

describe("blog schedule standing", () => {
  const postId = createBlogPostId(
    "00000000-0000-4000-8000-00000000000b",
  );

  function summary(
    overrides: Partial<BlogPostOperationalSummary>,
  ): BlogPostOperationalSummary {
    return {
      siteId: "site_test",
      postId,
      workspaceId: "workspace_test" as BlogPostOperationalSummary["workspaceId"],
      contentRevision: 1,
      postRevision: 1,
      postRevisionId: "revision-1",
      collectionState: "active",
      workflowState: "editing",
      liveRevisionId: null,
      version: 1,
      archiveRequestId: null,
      activeSchedule: null,
      latestExecution: null,
      ...overrides,
    };
  }

  it("is eligible to schedule regardless of the cached workflow state", () => {
    // Whether a preview has actually been inspected this session is a
    // session fact the component tracks itself (`previewedRevision`), not
    // something this summary-only function can see — it only rules out a
    // post that is archived or already scheduled.
    expect(blogPostScheduleStanding(summary({ workflowState: "editing" })))
      .toEqual({ line: null, canSchedule: true });
    expect(blogPostScheduleStanding(summary({ workflowState: "approved" })))
      .toEqual({ line: null, canSchedule: true });
  });

  it("shows the active schedule's local time instead of the schedule control", () => {
    const standing = blogPostScheduleStanding(
      summary({
        workflowState: "scheduled",
        activeSchedule: {
          id: "schedule-1",
          siteId: "site_test",
          postId,
          workspaceId: "workspace_test" as BlogPostOperationalSummary["workspaceId"],
          contentRevision: 1,
          postRevisionId: "revision-1",
          approvalId: "approval-1" as never,
          approvalFingerprint: "fingerprint",
          authorityPostRevisionId: "revision-1",
          authorityVersion: 1,
          localDateTime: "2026-11-01T01:30:00",
          ianaTimeZone: "America/Vancouver",
          utcOffsetChoice: "-07:00",
          executeAtUtc: "2026-11-01T08:30:00.000Z",
          timeZoneDatabaseVersion: "2026a",
          createdBy: "membership-owner" as never,
          activatedBy: "membership-owner" as never,
          activationAuditId: "audit-1",
          activatedAt: "2026-10-01T00:00:00.000Z",
          state: "active",
          detail: null,
        },
      }),
    );
    expect(standing.canSchedule).toBe(false);
    expect(standing.line).toContain(
      formatLocalScheduleTime("2026-11-01T01:30:00", "America/Vancouver"),
    );
  });

  it("returns no note for an archived post", () => {
    expect(
      blogPostScheduleStanding(summary({ collectionState: "archived" })),
    ).toEqual({ line: null, canSchedule: false });
  });

  it("returns no note when the post has no summary yet", () => {
    expect(blogPostScheduleStanding(undefined)).toEqual({
      line: null,
      canSchedule: false,
    });
  });
});

describe("blog execution failure note", () => {
  const postId = createBlogPostId(
    "00000000-0000-4000-8000-00000000000c",
  );

  function summary(
    overrides: Partial<BlogPostOperationalSummary>,
  ): BlogPostOperationalSummary {
    return {
      siteId: "site_test",
      postId,
      workspaceId: "workspace_test" as BlogPostOperationalSummary["workspaceId"],
      contentRevision: 1,
      postRevision: 1,
      postRevisionId: "revision-1",
      collectionState: "active",
      workflowState: "failed",
      liveRevisionId: null,
      version: 1,
      archiveRequestId: null,
      activeSchedule: null,
      latestExecution: null,
      ...overrides,
    };
  }

  function execution(
    state: "failed" | "blocked" | "completed",
  ): NonNullable<BlogPostOperationalSummary["latestExecution"]> {
    return {
      executionId: "execution-1",
      scheduleId: "schedule-1",
      publicationIdempotencyKey: "key-1",
      scheduledInstant: "2026-11-01T08:30:00.000Z",
      attempt: 1,
      attemptActorId: "membership-owner",
      attemptRequestId: "request-1",
      leaseExpiresAt: "2026-11-01T08:35:00.000Z",
      state,
      detail: null,
      claimedAt: "2026-11-01T08:30:00.000Z",
      updatedAt: "2026-11-01T08:31:00.000Z",
    };
  }

  it("says the previous version remains live when a live post's update fails", () => {
    expect(
      blogPostExecutionFailureNote(
        summary({
          liveRevisionId: "revision-0",
          latestExecution: execution("failed"),
        }),
      ),
    ).toBe("Update failed; the previous version remains live.");
  });

  it("says the first publication is not live when a never-published post fails", () => {
    expect(
      blogPostExecutionFailureNote(
        summary({ liveRevisionId: null, latestExecution: execution("blocked") }),
      ),
    ).toBe("First publication failed; it is not live yet.");
  });

  it("is null when the latest execution has not failed", () => {
    expect(
      blogPostExecutionFailureNote(
        summary({ latestExecution: execution("completed") }),
      ),
    ).toBeNull();
  });

  it("is null when there is no summary yet", () => {
    expect(blogPostExecutionFailureNote(undefined)).toBeNull();
  });
});

describe("continueArchiveWithdrawal", () => {
  function jsonBody(call: unknown[]): Record<string, unknown> {
    const init = call[1] as { body: string };
    return JSON.parse(init.body) as Record<string, unknown>;
  }

  it("recovers access, confirms the withdrawal draft, and continues it", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          archiveRequestId: "archive-0001",
          withdrawal: { workspaceId: "workspace_withdrawal", revision: 3 },
        }),
      )
      .mockResolvedValueOnce(Response.json({ id: "approval-withdrawal-1" }))
      .mockResolvedValueOnce(
        Response.json({ archiveRequestId: "archive-0001" }, { status: 202 }),
      );

    const result = await continueArchiveWithdrawal({
      postId: "post-0001",
      archiveRequestId: "archive-0001",
      mutationToken: "csrf-token",
      fetcher,
    });

    expect(result).toEqual({
      outcome: "continued",
      mutationToken: "csrf-token",
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
    const [recoverUrl] = fetcher.mock.calls[0]!;
    expect(recoverUrl).toBe("/api/foundry-cms/blog-operations");
    expect(jsonBody(fetcher.mock.calls[0]!)).toMatchObject({
      operation: "recover_archive_withdrawal_access",
      postId: "post-0001",
      archiveRequestId: "archive-0001",
    });
    const [approveUrl] = fetcher.mock.calls[1]!;
    expect(approveUrl).toBe("/api/foundry-cms/publications");
    expect(jsonBody(fetcher.mock.calls[1]!)).toMatchObject({
      operation: "approve",
      workspaceId: "workspace_withdrawal",
      revision: 3,
      previewConfirmed: true,
    });
    expect(jsonBody(fetcher.mock.calls[2]!)).toMatchObject({
      operation: "continue_archive_withdrawal",
      postId: "post-0001",
      archiveRequestId: "archive-0001",
      withdrawalApprovalId: "approval-withdrawal-1",
    });
  });

  it("reports a plain-words failure when access cannot be recovered", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ error: "human_authority_required" }, { status: 422 }),
      );

    const result = await continueArchiveWithdrawal({
      postId: "post-0001",
      archiveRequestId: "archive-0001",
      mutationToken: "csrf-token",
      fetcher,
    });

    expect(result).toEqual({
      outcome: "failed",
      message:
        "You do not have access to finish this. Ask an owner or editor to help.",
      mutationToken: "csrf-token",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("reports a failure and stops when the withdrawal cannot be confirmed", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          archiveRequestId: "archive-0001",
          withdrawal: { workspaceId: "workspace_withdrawal", revision: 3 },
        }),
      )
      .mockResolvedValueOnce(
        Response.json(
          { error: "preview_confirmation_required" },
          { status: 422 },
        ),
      );

    const result = await continueArchiveWithdrawal({
      postId: "post-0001",
      archiveRequestId: "archive-0001",
      mutationToken: "csrf-token",
      fetcher,
    });

    expect(result).toEqual({
      outcome: "failed",
      message:
        "The site could not confirm this archive step. Refresh the page and try again.",
      mutationToken: "csrf-token",
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("reports the server's exact reason when continuing the withdrawal is rejected", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          archiveRequestId: "archive-0001",
          withdrawal: { workspaceId: "workspace_withdrawal", revision: 3 },
        }),
      )
      .mockResolvedValueOnce(Response.json({ id: "approval-withdrawal-1" }))
      .mockResolvedValueOnce(
        Response.json(
          { error: "archive_publication_mismatch" },
          { status: 422 },
        ),
      );

    const result = await continueArchiveWithdrawal({
      postId: "post-0001",
      archiveRequestId: "archive-0001",
      mutationToken: "csrf-token",
      fetcher,
    });

    expect(result).toEqual({
      outcome: "failed",
      message:
        "The site changed since this archive started. Refresh the page and try again.",
      mutationToken: "csrf-token",
    });
  });
});

describe("formatLocalScheduleTime", () => {
  it("renders the exact civil time with its time zone name", () => {
    const formatted = formatLocalScheduleTime(
      "2026-11-01T01:30:00",
      "America/Vancouver",
    );
    expect(formatted).toContain("November 1, 2026");
    expect(formatted).toContain("1:30 AM");
    expect(formatted).toContain("(America/Vancouver)");
  });
});
