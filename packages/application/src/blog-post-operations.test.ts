import { describe, expect, it } from "vitest";

import {
  BlogPostOperationError,
  createBlogPostOperationsApplication,
  createInMemoryBlogPostOperationsStore,
  type BlogPostOperationalState,
} from "./blog-post-operations";
import {
  createContentActorId,
  createContentApprovalId,
  createContentWorkspaceId,
} from "./index";

const actorId = createContentActorId("membership_editor");
const mcpActorId = createContentActorId("mcp-agent");
const workspaceId = createContentWorkspaceId("workspace_blog_schedule");
const approvalId = createContentApprovalId(
  "approval_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
);
const now = "2026-11-01T08:00:00.000Z";
const beforeNow = "2026-11-01T07:59:59.000Z";
const resolvedTime = (
  localDateTime: string,
  utcOffsetChoice: string,
  executeAtUtc: string,
) => ({
  localDateTime,
  ianaTimeZone: "America/Vancouver",
  utcOffsetChoice,
  executeAtUtc,
});

function activePost(
  overrides: Partial<BlogPostOperationalState> = {},
): BlogPostOperationalState {
  return {
    siteId: "foundry-site",
    postId: "post-scheduled-release",
    workspaceId,
    contentRevision: 7,
    postRevision: 7,
    postRevisionId: "post-revision-7",
    collectionState: "active",
    workflowState: "editing",
    liveRevisionId: null,
    version: 1,
    ...overrides,
  };
}

function application(
  post = activePost(),
  approvedPostRevisionId = post.postRevisionId,
  approvedPostId = post.postId,
) {
  let observedAt = beforeNow;
  const store = createInMemoryBlogPostOperationsStore({
    humanActorIds: [actorId],
    mcpScheduleProposalAccess: [{
      actorId: mcpActorId,
      siteId: post.siteId,
      postId: post.postId,
    }],
    mcpScheduleAccess: [{
      connectionId: "connection-56",
      actorId: "agent-56",
      siteId: post.siteId,
    }],
    posts: [post],
    approvals: [
      {
        id: approvalId,
        siteId: post.siteId,
        workspaceId,
        contentRevision: 7,
        fingerprint: "approved-fingerprint-7",
        postArtifacts: [
          {
            postId: approvedPostId,
            postRevisionId: approvedPostRevisionId,
          },
        ],
        invalidatedAt: null,
      },
    ],
  });
  return {
    store,
    app: createBlogPostOperationsApplication({
      store,
      now: () => observedAt,
      createId: (kind) => `${kind}_deterministic`,
      timeZoneDatabaseVersion: () => "2026a",
    }),
    advanceToNow() {
      observedAt = now;
    },
  };
}

describe("blog post operations", () => {
  it("activates the canonical schedule for an exact current MCP grant", async () => {
    const { app } = application();

    const schedule = await app.commands.activateSchedule({
      actorId: mcpActorId,
      siteId: "foundry-site",
      postId: "post-scheduled-release",
      approvalId,
      resolvedTime: resolvedTime(
        "2026-11-01T01:30:00",
        "-07:00",
        "2026-11-01T08:30:00.000Z",
      ),
      idempotencyKey: "mcp-activate-schedule-0001",
      authority: {
        kind: "mcp",
        connectionId: "connection-56",
        actorId: "agent-56",
        operation: "foundry.publication.schedule",
        requiredScopes: ["publication.schedule"],
      },
    });

    expect(schedule).toMatchObject({
      state: "active",
      approvalId,
      createdBy: mcpActorId,
      activatedBy: mcpActorId,
    });
  });

  it("rejects MCP scheduling when the connection lacks a required scope", async () => {
    // The connection is the right one, but it was never granted the draft
    // scope the approved revision needs, so activation must be refused
    // rather than admitted on connection identity alone.
    const post = activePost();
    const store = createInMemoryBlogPostOperationsStore({
      humanActorIds: [actorId],
      mcpScheduleAccess: [{
        connectionId: "connection-56",
        actorId: "agent-56",
        siteId: post.siteId,
        scopes: ["publication.schedule"],
      }],
      posts: [post],
      approvals: [
        {
          id: approvalId,
          siteId: post.siteId,
          workspaceId,
          contentRevision: 7,
          fingerprint: "approved-fingerprint-7",
          postArtifacts: [
            {
              postId: post.postId,
              postRevisionId: post.postRevisionId,
            },
          ],
          invalidatedAt: null,
        },
      ],
    });
    const app = createBlogPostOperationsApplication({
      store,
      now: () => beforeNow,
      createId: (kind) => `${kind}_deterministic`,
      timeZoneDatabaseVersion: () => "2026a",
    });

    await expect(
      app.commands.activateSchedule({
        actorId: mcpActorId,
        siteId: "foundry-site",
        postId: "post-scheduled-release",
        approvalId,
        resolvedTime: resolvedTime(
          "2026-11-01T01:30:00",
          "-07:00",
          "2026-11-01T08:30:00.000Z",
        ),
        idempotencyKey: "mcp-activate-missing-draft-scope",
        authority: {
          kind: "mcp",
          connectionId: "connection-56",
          actorId: "agent-56",
          operation: "foundry.publication.schedule",
          requiredScopes: ["publication.schedule", "content.draft"],
        },
      }),
    ).rejects.toEqual(
      new BlogPostOperationError("mcp_schedule_authority_required"),
    );
    await expect(
      store.findScheduleByRequest({
        siteId: "foundry-site",
        postId: "post-scheduled-release",
        idempotencyKey: "mcp-activate-missing-draft-scope",
      }),
    ).resolves.toBeNull();
  });

  it("rejects a cancellation after the schedule leaves its active state", async () => {
    const { app } = application();
    const activated = await app.commands.activateSchedule({
      actorId,
      siteId: "foundry-site",
      postId: "post-scheduled-release",
      approvalId,
      resolvedTime: resolvedTime(
        "2026-11-01T01:30:00",
        "-07:00",
        "2026-11-01T08:30:00.000Z",
      ),
      idempotencyKey: "cancel-after-inactive-activate",
    });
    await app.commands.cancelSchedule({
      actorId,
      siteId: "foundry-site",
      postId: "post-scheduled-release",
      scheduleId: activated.id,
      idempotencyKey: "cancel-after-inactive-first",
    });

    // The schedule is already cancelled, so a second cancellation is a
    // terminal rejection and changes nothing.
    await expect(
      app.commands.cancelSchedule({
        actorId,
        siteId: "foundry-site",
        postId: "post-scheduled-release",
        scheduleId: activated.id,
        idempotencyKey: "cancel-after-inactive-second",
      }),
    ).rejects.toEqual(
      new BlogPostOperationError("too_late_to_cancel"),
    );
    await expect(
      app.queries.getSchedule("foundry-site", activated.id),
    ).resolves.toMatchObject({ state: "cancelled" });
  });

  it("rejects MCP scheduling without a current exact connection grant", async () => {
    const { app, store } = application();

    await expect(
      app.commands.activateSchedule({
        actorId: mcpActorId,
        siteId: "foundry-site",
        postId: "post-scheduled-release",
        approvalId,
        resolvedTime: resolvedTime(
          "2026-11-01T01:30:00",
          "-07:00",
          "2026-11-01T08:30:00.000Z",
        ),
        idempotencyKey: "mcp-activate-without-grant",
        authority: {
          kind: "mcp",
          connectionId: "connection-revoked",
          actorId: "agent-56",
          operation: "foundry.publication.schedule",
          requiredScopes: ["publication.schedule"],
        },
      }),
    ).rejects.toEqual(
      new BlogPostOperationError("mcp_schedule_authority_required"),
    );
    await expect(
      store.findScheduleByRequest({
        siteId: "foundry-site",
        postId: "post-scheduled-release",
        idempotencyKey: "mcp-activate-without-grant",
      }),
    ).resolves.toBeNull();
  });

  it("stores an exact UTC instant and reporting zone bound to the approval", async () => {
    const { app } = application();

    const schedule = await app.commands.activateSchedule({
      actorId,
      siteId: "foundry-site",
      postId: "post-scheduled-release",
      approvalId,
      resolvedTime: resolvedTime("2026-11-01T01:30:00", "-07:00", "2026-11-01T08:30:00.000Z"),
      idempotencyKey: "activate-schedule-0001",
    });

    expect(schedule).toMatchObject({
      state: "active",
      approvalId,
      approvalFingerprint: "approved-fingerprint-7",
      executeAtUtc: "2026-11-01T08:30:00.000Z",
      ianaTimeZone: "America/Vancouver",
      utcOffsetChoice: "-07:00",
      localDateTime: "2026-11-01T01:30:00",
    });
  });

  it("requires an activation instant strictly after the observed time", async () => {
    const { store } = application();
    const app = createBlogPostOperationsApplication({
      store,
      now: () => now,
      timeZoneDatabaseVersion: () => "2026a",
    });

    await expect(app.commands.activateSchedule({
      actorId,
      siteId: "foundry-site",
      postId: "post-scheduled-release",
      approvalId,
      resolvedTime: resolvedTime(
        "2026-11-01T01:00:00",
        "-07:00",
        now,
      ),
      idempotencyKey: "activate-at-observed-time",
    })).rejects.toMatchObject({ code: "schedule_in_past" });
  });

  it("uses one observed timestamp for strict-future validation and activation", async () => {
    const { store } = application();
    let clockReads = 0;
    const app = createBlogPostOperationsApplication({
      store,
      now: () => {
        clockReads += 1;
        return clockReads === 1 ? beforeNow : now;
      },
      createId: (kind) => `${kind}_single_clock_sample`,
      timeZoneDatabaseVersion: () => "2026a",
    });

    const schedule = await app.commands.activateSchedule({
      actorId,
      siteId: "foundry-site",
      postId: "post-scheduled-release",
      approvalId,
      resolvedTime: resolvedTime(
        "2026-11-01T01:00:00",
        "-07:00",
        now,
      ),
      idempotencyKey: "single-activation-clock-sample",
    });

    expect(schedule.activatedAt).toBe(beforeNow);
    expect(clockReads).toBe(1);
  });

  it("re-observes time after delayed authority validation", async () => {
    const { store } = application();
    let observedAt = beforeNow;
    const app = createBlogPostOperationsApplication({
      store,
      now: () => observedAt,
      createId: (kind) => `${kind}_delayed_validation`,
      timeZoneDatabaseVersion: () => "2026a",
      validateApprovalAuthority: async () => {
        observedAt = now;
        return true;
      },
    });

    await expect(app.commands.activateSchedule({
      actorId,
      siteId: "foundry-site",
      postId: "post-scheduled-release",
      approvalId,
      resolvedTime: resolvedTime(
        "2026-11-01T01:00:00",
        "-07:00",
        now,
      ),
      idempotencyKey: "activation-elapsed-during-validation",
    })).rejects.toMatchObject({ code: "schedule_in_past" });
    expect(
      await store.findScheduleByRequest({
        siteId: "foundry-site",
        postId: "post-scheduled-release",
        idempotencyKey: "activation-elapsed-during-validation",
      }),
    ).toBeNull();
  });

  it("keeps schedule proposals non-executable until a human activates one", async () => {
    const { app, store } = application();

    const proposal = await app.commands.proposeSchedule({
      actorId,
      siteId: "foundry-site",
      postId: "post-scheduled-release",
      resolvedTime: resolvedTime(
        "2026-11-01T01:30:00",
        "-07:00",
        "2026-11-01T08:30:00.000Z",
      ),
      idempotencyKey: "propose-schedule-0001",
    });
    expect(proposal.proposalAuditId).toBe(
      `blog.post.schedule.proposal:${proposal.id}`,
    );
    await app.commands.archive({
      actorId,
      siteId: "foundry-site",
      postId: "post-scheduled-release",
      selectedPostRevisionId: "post-revision-7",
      idempotencyKey: "archive-after-proposal-response-loss",
    });
    const replay = await createBlogPostOperationsApplication({
      store,
      now: () => "2027-01-01T00:00:00.000Z",
      createId: (kind) => `${kind}_must_not_be_used`,
      timeZoneDatabaseVersion: () => "2027b",
    }).commands.proposeSchedule({
      actorId,
      siteId: "foundry-site",
      postId: "post-scheduled-release",
      resolvedTime: resolvedTime(
        "2026-11-01T01:30:00",
        "-07:00",
        "2026-11-01T08:30:00.000Z",
      ),
      idempotencyKey: "propose-schedule-0001",
    });

    expect(replay).toEqual(proposal);
    expect(await store.listDueSchedules(
      "2026-11-01T09:00:00.000Z",
      10,
    )).toEqual([]);
    expect(
      await store.findPost("foundry-site", "post-scheduled-release"),
    ).toMatchObject({ workflowState: "editing" });
  });

  it("keeps the issue 56 proposal seam separate from human mutations", async () => {
    const { app } = application();
    const mcpActor = mcpActorId;
    const publicationTime = resolvedTime(
      "2026-11-01T01:30:00",
      "-07:00",
      "2026-11-01T08:30:00.000Z",
    );

    await expect(app.commands.proposeSchedule({
      actorId: mcpActor,
      siteId: "foundry-site",
      postId: "post-scheduled-release",
      resolvedTime: publicationTime,
      idempotencyKey: "mcp-proposal-request",
    })).resolves.toMatchObject({ createdBy: mcpActor });

    await expect(app.commands.proposeSchedule({
      actorId: createContentActorId("integration-adapter"),
      siteId: "foundry-site",
      postId: "post-scheduled-release",
      resolvedTime: publicationTime,
      idempotencyKey: "integration-proposal-request",
    })).rejects.toMatchObject({
      code: "schedule_proposal_authority_required",
    });

    for (const command of [
      app.commands.activateSchedule({
        actorId: mcpActor,
        siteId: "foundry-site",
        postId: "post-scheduled-release",
        approvalId,
        resolvedTime: publicationTime,
        idempotencyKey: "mcp-activation-request",
      }),
      app.commands.cancelSchedule({
        actorId: mcpActor,
        siteId: "foundry-site",
        postId: "post-scheduled-release",
        scheduleId: "missing-schedule",
        idempotencyKey: "mcp-cancellation-request",
      }),
      app.commands.archive({
        actorId: mcpActor,
        siteId: "foundry-site",
        postId: "post-scheduled-release",
        selectedPostRevisionId: "post-revision-7",
        idempotencyKey: "mcp-archive-request",
      }),
      app.commands.restore({
        actorId: mcpActor,
        siteId: "foundry-site",
        postId: "post-scheduled-release",
        selectedPostRevisionId: "post-revision-7",
        idempotencyKey: "mcp-restore-request",
      }),
    ]) {
      await expect(command).rejects.toMatchObject({
        code: "human_authority_required",
      });
    }
  });

  it("projects successor edits after a human-cancelled schedule", async () => {
    const { app, store } = application();
    const schedule = await app.commands.activateSchedule({
      actorId,
      siteId: "foundry-site",
      postId: "post-scheduled-release",
      approvalId,
      resolvedTime: resolvedTime(
        "2026-11-01T01:30:00",
        "-07:00",
        "2026-11-01T08:30:00.000Z",
      ),
      idempotencyKey: "activate-before-human-cancel",
    });
    const input = {
      actorId,
      siteId: "foundry-site",
      postId: "post-scheduled-release",
      scheduleId: schedule.id,
      idempotencyKey: "cancel-active-schedule-0001",
    };

    const cancelled = await app.commands.cancelSchedule(input);

    await expect(app.commands.cancelSchedule(input)).resolves.toEqual(
      cancelled,
    );
    expect(cancelled).toMatchObject({
      state: "cancelled",
      detail: "human_cancelled",
    });
    await expect(
      app.commands.claimDueSchedule(schedule.siteId, schedule.id),
    ).rejects.toMatchObject({ code: "schedule_inactive" });
    await app.commands.invalidateForSuccessorRevision({
      siteId: "foundry-site",
      postId: "post-scheduled-release",
      workspaceId,
      contentRevision: 8,
      occurredAt: "2026-11-01T08:05:00.000Z",
    });
    await expect(
      app.queries.getSchedule("foundry-site", schedule.id),
    ).resolves.toMatchObject({
      state: "cancelled",
      detail: "human_cancelled",
    });
    await expect(
      store.findPost("foundry-site", "post-scheduled-release"),
    ).resolves.toMatchObject({ workflowState: "editing" });
  });

  it("refuses schedule authority when the approved production base is no longer live", async () => {
    const { store } = application();
    const app = createBlogPostOperationsApplication({
      store,
      now: () => now,
      createId: (kind) => `${kind}_production_drift`,
      timeZoneDatabaseVersion: () => "2026a",
      validateApprovalAuthority: async () => false,
    });

    await expect(app.commands.activateSchedule({
      actorId,
      siteId: "foundry-site",
      postId: "post-scheduled-release",
      approvalId,
      resolvedTime: resolvedTime(
        "2026-11-01T01:30:00",
        "-07:00",
        "2026-11-01T08:30:00.000Z",
      ),
      idempotencyKey: "activate-production-drift",
    })).rejects.toMatchObject({ code: "approval_stale" });
    expect(await store.findSchedule("schedule_production_drift")).toBeNull();
  });

  it("claims a due schedule once and replays one logical publication", async () => {
    const { app, advanceToNow } = application();
    const schedule = await app.commands.activateSchedule({
      actorId,
      siteId: "foundry-site",
      postId: "post-scheduled-release",
      approvalId,
      resolvedTime: resolvedTime("2026-11-01T01:00:00", "-07:00", "2026-11-01T08:00:00.000Z"),
      idempotencyKey: "activate-schedule-0002",
    });
    advanceToNow();

    const [first, second] = await Promise.all([
      app.commands.claimDueSchedule(schedule.siteId, schedule.id),
      app.commands.claimDueSchedule(schedule.siteId, schedule.id),
    ]);

    expect(first.execution.executionId).toBe(second.execution.executionId);
    expect(first.execution.publicationIdempotencyKey).toBe(
      second.execution.publicationIdempotencyKey,
    );
    expect(first.execution.state).toBe("claimed");
    expect([first.lease, second.lease].filter(Boolean)).toHaveLength(1);
    expect(first.execution).not.toHaveProperty("leaseToken");
  });

  it("reclaims an expired lease with the same logical execution identity", async () => {
    const { app, store } = application();
    const schedule = await app.commands.activateSchedule({
      actorId,
      siteId: "foundry-site",
      postId: "post-scheduled-release",
      approvalId,
      resolvedTime: resolvedTime("2026-11-01T01:00:00", "-07:00", now),
      idempotencyKey: "activate-lease-reclaim",
    });
    const first = await store.claimSchedule({
      scheduleId: schedule.id,
      now,
      executionId: "execution_original",
      publicationIdempotencyKey: "scheduled-publication:lease",
      attemptActorId: "system:scheduler",
      attemptRequestId: "claim-original",
      leaseToken: "lease-original",
      leaseExpiresAt: "2026-11-01T08:01:00.000Z",
    });
    const reclaimed = await store.claimSchedule({
      scheduleId: schedule.id,
      now: "2026-11-01T08:02:00.000Z",
      executionId: "execution_replacement",
      publicationIdempotencyKey: "scheduled-publication:lease",
      attemptActorId: "system:scheduler",
      attemptRequestId: "claim-replacement",
      leaseToken: "lease-reclaimed",
      leaseExpiresAt: "2026-11-01T08:07:00.000Z",
    });

    expect(reclaimed.execution.executionId).toBe(
      first.execution.executionId,
    );
    expect(reclaimed.lease?.leaseToken).toBe("lease-reclaimed");
  });

  it.each(["blocked", "failed", "unknown", "completed"] as const)(
    "persists and replays the %s scheduler outcome",
    async (outcome) => {
      const { app, advanceToNow } = application();
      const schedule = await app.commands.activateSchedule({
        actorId,
        siteId: "foundry-site",
        postId: "post-scheduled-release",
        approvalId,
        resolvedTime: resolvedTime("2026-11-01T01:00:00", "-07:00", "2026-11-01T08:00:00.000Z"),
        idempotencyKey: `activate-${outcome}-0001`,
      });
      advanceToNow();
      const claim = await app.commands.claimDueSchedule(schedule.siteId, schedule.id);

      const recorded = await app.commands.recordExecutionOutcome({
        lease: claim.lease!,
        outcomeId: `${claim.execution.executionId}:${outcome}`,
        outcome,
        detail: outcome === "completed" ? null : `publication_${outcome}`,
      });

      expect(recorded.state).toBe(outcome);
      expect(
        await app.queries.getExecution(
          "foundry-site",
          claim.execution.executionId,
        ),
      ).toEqual(
        recorded,
      );
    },
  );

  it("deactivates pending authority when a successor post revision is saved", async () => {
    const { app } = application();
    const schedule = await app.commands.activateSchedule({
      actorId,
      siteId: "foundry-site",
      postId: "post-scheduled-release",
      approvalId,
      resolvedTime: resolvedTime("2026-11-01T01:30:00", "-07:00", "2026-11-01T08:30:00.000Z"),
      idempotencyKey: "activate-schedule-0003",
    });

    await app.commands.invalidateForSuccessorRevision({
      siteId: "foundry-site",
      postId: "post-scheduled-release",
      workspaceId,
      contentRevision: 8,
      occurredAt: "2026-11-01T08:05:00.000Z",
    });

    expect(await app.queries.getSchedule(
      "foundry-site",
      schedule.id,
    )).toMatchObject({
      state: "cancelled",
      detail: "revision_changed",
    });
    await expect(
      app.commands.claimDueSchedule(schedule.siteId, schedule.id),
    ).rejects.toMatchObject({ code: "schedule_inactive" });
  });

  it("replays activation before rechecking elapsed time or approval authority", async () => {
    const { store } = application();
    let observedAt = "2026-11-01T07:59:00.000Z";
    let authorityIsLive = true;
    const app = createBlogPostOperationsApplication({
      store,
      now: () => observedAt,
      createId: (kind) => `${kind}_activation_replay`,
      timeZoneDatabaseVersion: () => "2026a",
      validateApprovalAuthority: async () => authorityIsLive,
    });
    const input = {
      actorId,
      siteId: "foundry-site",
      postId: "post-scheduled-release",
      approvalId,
      resolvedTime: resolvedTime(
        "2026-11-01T01:00:00",
        "-07:00",
        "2026-11-01T08:00:00.000Z",
      ),
      idempotencyKey: "activate-response-loss-replay",
    };
    const activated = await app.commands.activateSchedule(input);

    observedAt = "2026-11-01T08:10:00.000Z";
    authorityIsLive = false;

    await expect(
      app.commands.activateSchedule(input),
    ).resolves.toEqual(activated);
  });

  it("records a claimed due schedule as blocked when exact approval authority is stale", async () => {
    const { store } = application();
    let stale = false;
    let observedAt = beforeNow;
    const app = createBlogPostOperationsApplication({
      store: {
        ...store,
        async findApproval(id) {
          const approval = await store.findApproval(id);
          return stale && approval !== null
            ? { ...approval, invalidatedAt: now }
            : approval;
        },
      },
      now: () => observedAt,
      createId: (kind) => `${kind}_stale`,
      timeZoneDatabaseVersion: () => "2026a",
    });
    const schedule = await app.commands.activateSchedule({
      actorId,
      siteId: "foundry-site",
      postId: "post-scheduled-release",
      approvalId,
      resolvedTime: resolvedTime("2026-11-01T01:00:00", "-07:00", now),
      idempotencyKey: "activate-stale-claim",
    });
    observedAt = now;
    stale = true;

    await expect(app.commands.claimDueSchedule(schedule.siteId, schedule.id)).resolves.toMatchObject({
      execution: {
        state: "blocked",
        detail: "approval_stale",
      },
      lease: null,
    });
  });

  it("returns valid civil-time alternatives for a daylight-saving gap", async () => {
    const { app } = application();

    await expect(
      app.commands.activateSchedule({
        actorId,
        siteId: "foundry-site",
        postId: "post-scheduled-release",
        approvalId,
        resolvedTime: resolvedTime("2026-03-08T02:30:00", "-08:00", "2026-03-08T10:30:00.000Z"),
        idempotencyKey: "activate-dst-gap-0001",
      }),
    ).rejects.toMatchObject({
      code: "civil_time_resolution_mismatch",
      details: {
        validAlternatives: [
          expect.objectContaining({ localDateTime: "2026-03-08T03:00:00" }),
          expect.objectContaining({ localDateTime: "2026-03-08T03:01:00" }),
        ],
      },
    });
  });

  it("allows an explicit retry of a failed execution without changing its identity", async () => {
    const { app, advanceToNow } = application();
    const schedule = await app.commands.activateSchedule({
      actorId,
      siteId: "foundry-site",
      postId: "post-scheduled-release",
      approvalId,
      resolvedTime: resolvedTime("2026-11-01T01:00:00", "-07:00", now),
      idempotencyKey: "activate-retry-execution",
    });
    advanceToNow();
    const claimed = await app.commands.claimDueSchedule(schedule.siteId, schedule.id);
    await app.commands.recordExecutionOutcome({
      lease: claimed.lease!,
      outcomeId: `${claimed.execution.executionId}:failed`,
      outcome: "failed",
      detail: "deployment_failed",
    });

    const retried = await app.commands.retryExecution(
      "foundry-site",
      "post-scheduled-release",
      claimed.execution.executionId,
      actorId,
      "explicit-human-retry",
    );

    expect(retried.execution).toMatchObject({
      executionId: claimed.execution.executionId,
      state: "claimed",
      detail: null,
    });
  });

  it.each(["failed", "blocked"] as const)(
    "does not let the scheduler retry a human-actionable %s execution",
    async (outcome) => {
      const { app, advanceToNow } = application();
      const schedule = await app.commands.activateSchedule({
        actorId,
        siteId: "foundry-site",
        postId: "post-scheduled-release",
        approvalId,
        resolvedTime: resolvedTime(
          "2026-11-01T01:00:00",
          "-07:00",
          now,
        ),
        idempotencyKey: `activate-scheduler-${outcome}-fence`,
      });
      advanceToNow();
      const claimed = await app.commands.claimDueSchedule(
        schedule.siteId,
        schedule.id,
      );
      await app.commands.recordExecutionOutcome({
        lease: claimed.lease!,
        outcomeId: `scheduler-${outcome}-fence`,
        outcome,
        detail: `${outcome}_requires_human`,
      });

      await expect(app.commands.retryExecutionAsScheduler(
        "foundry-site",
        "post-scheduled-release",
        claimed.execution.executionId,
        `scheduler-${outcome}-retry`,
      )).rejects.toMatchObject({ code: "execution_not_retryable" });
      await expect(app.commands.claimDueSchedule(
        schedule.siteId,
        schedule.id,
      )).rejects.toMatchObject({ code: "schedule_inactive" });
      await expect(app.queries.getExecution(
        schedule.siteId,
        claimed.execution.executionId,
      )).resolves.toMatchObject({
        attempt: 1,
        state: outcome,
      });
    },
  );

  it("requires current human authority for a human-triggered retry", async () => {
    const { app, advanceToNow } = application();
    const schedule = await app.commands.activateSchedule({
      actorId,
      siteId: "foundry-site",
      postId: "post-scheduled-release",
      approvalId,
      resolvedTime: resolvedTime(
        "2026-11-01T01:00:00",
        "-07:00",
        now,
      ),
      idempotencyKey: "activate-human-retry-authorization",
    });
    advanceToNow();
    const claimed = await app.commands.claimDueSchedule(
      schedule.siteId,
      schedule.id,
    );
    await app.commands.recordExecutionOutcome({
      lease: claimed.lease!,
      outcomeId: "human-retry-authorization-failed",
      outcome: "failed",
      detail: "deployment_failed",
    });

    await expect(app.commands.retryExecution(
      "foundry-site",
      "post-scheduled-release",
      claimed.execution.executionId,
      createContentActorId("mcp-agent"),
      "unauthorized-human-retry",
    )).rejects.toMatchObject({ code: "human_authority_required" });
  });

  it("isolates schedule queries and retries when sites share a post identifier", async () => {
    const store = createInMemoryBlogPostOperationsStore({
      humanActorIds: [actorId],
      posts: [
        activePost(),
        activePost({ siteId: "other-site" }),
      ],
      approvals: [{
        id: approvalId,
        siteId: "foundry-site",
        workspaceId,
        contentRevision: 7,
        fingerprint: "approved-fingerprint-7",
        postArtifacts: [{
          postId: activePost().postId,
          postRevisionId: activePost().postRevisionId,
        }],
        invalidatedAt: null,
      }],
    });
    let observedAt = beforeNow;
    const app = createBlogPostOperationsApplication({
      store,
      now: () => observedAt,
      createId: (kind) => `${kind}_site_isolation`,
      timeZoneDatabaseVersion: () => "2026a",
    });
    const schedule = await app.commands.activateSchedule({
      actorId,
      siteId: "foundry-site",
      postId: activePost().postId,
      approvalId,
      resolvedTime: resolvedTime(
        "2026-11-01T01:00:00",
        "-07:00",
        now,
      ),
      idempotencyKey: "activate-site-isolation",
    });
    await expect(app.commands.activateSchedule({
      actorId,
      siteId: "other-site",
      postId: activePost().postId,
      approvalId,
      resolvedTime: resolvedTime(
        "2026-11-01T01:00:00",
        "-07:00",
        now,
      ),
      idempotencyKey: "activate-site-isolation",
    })).rejects.toMatchObject({ code: "approval_stale" });
    observedAt = now;
    const claimed = await app.commands.claimDueSchedule(schedule.siteId, schedule.id);
    await app.commands.recordExecutionOutcome({
      lease: claimed.lease!,
      outcomeId: "site-isolation-failed",
      outcome: "failed",
      detail: "deployment_failed",
    });

    await expect(
      app.queries.getSchedule("other-site", schedule.id),
    ).resolves.toBeNull();
    await expect(
      app.queries.getExecution(
        "other-site",
        claimed.execution.executionId,
      ),
    ).resolves.toBeNull();
    await expect(
      app.commands.retryExecution(
        "other-site",
        activePost().postId,
        claimed.execution.executionId,
        actorId,
        "other-site-retry",
      ),
    ).rejects.toMatchObject({ code: "execution_not_found" });
    await expect(
      app.commands.retryExecution(
        "foundry-site",
        activePost().postId,
        claimed.execution.executionId,
        actorId,
        "foundry-site-retry",
      ),
    ).resolves.toMatchObject({
      execution: {
        executionId: claimed.execution.executionId,
        state: "claimed",
      },
    });
  });

  it("scopes outcome and retry idempotency receipts to each site", async () => {
    const otherApprovalId = createContentApprovalId(
      "approval_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );
    const otherWorkspaceId = createContentWorkspaceId(
      "workspace_other_site_schedule",
    );
    const posts = [
      activePost(),
      activePost({
        siteId: "other-site",
        workspaceId: otherWorkspaceId,
      }),
    ];
    const store = createInMemoryBlogPostOperationsStore({
      humanActorIds: [actorId],
      posts,
      approvals: [
        {
          id: approvalId,
          siteId: "foundry-site",
          workspaceId,
          contentRevision: 7,
          fingerprint: "approved-fingerprint-7",
          postArtifacts: [{
            postId: activePost().postId,
            postRevisionId: activePost().postRevisionId,
          }],
          invalidatedAt: null,
        },
        {
          id: otherApprovalId,
          siteId: "other-site",
          workspaceId: otherWorkspaceId,
          contentRevision: 7,
          fingerprint: "approved-fingerprint-7",
          postArtifacts: [{
            postId: activePost().postId,
            postRevisionId: activePost().postRevisionId,
          }],
          invalidatedAt: null,
        },
      ],
    });
    let sequence = 0;
    let observedAt = beforeNow;
    const app = createBlogPostOperationsApplication({
      store,
      now: () => observedAt,
      createId: (kind) => `${kind}_site_receipt_${++sequence}`,
      timeZoneDatabaseVersion: () => "2026a",
    });
    const activate = (
      siteId: string,
      selectedApprovalId: typeof approvalId,
    ) => app.commands.activateSchedule({
      actorId,
      siteId,
      postId: activePost().postId,
      approvalId: selectedApprovalId,
      resolvedTime: resolvedTime(
        "2026-11-01T01:00:00",
        "-07:00",
        now,
      ),
      idempotencyKey: "shared-activation-key",
    });
    const [firstSchedule, secondSchedule] = await Promise.all([
      activate("foundry-site", approvalId),
      activate("other-site", otherApprovalId),
    ]);
    observedAt = now;
    const [firstClaim, secondClaim] = await Promise.all([
      app.commands.claimDueSchedule(firstSchedule.siteId, firstSchedule.id),
      app.commands.claimDueSchedule(secondSchedule.siteId, secondSchedule.id),
    ]);

    await Promise.all([
      app.commands.recordExecutionOutcome({
        lease: firstClaim.lease!,
        outcomeId: "shared-outcome-id",
        outcome: "failed",
        detail: "deployment_failed",
      }),
      app.commands.recordExecutionOutcome({
        lease: secondClaim.lease!,
        outcomeId: "shared-outcome-id",
        outcome: "failed",
        detail: "deployment_failed",
      }),
    ]);
    const [firstRetry, secondRetry] = await Promise.all([
      app.commands.retryExecution(
        "foundry-site",
        activePost().postId,
        firstClaim.execution.executionId,
        actorId,
        "shared-retry-request",
      ),
      app.commands.retryExecution(
        "other-site",
        activePost().postId,
        secondClaim.execution.executionId,
        actorId,
        "shared-retry-request",
      ),
    ]);

    expect(firstRetry.execution.attempt).toBe(2);
    expect(secondRetry.execution.attempt).toBe(2);
  });

  it("revalidates retry authority while preserving a durable retry replay", async () => {
    const { store } = application();
    let authorityIsLive = true;
    let observedAt = beforeNow;
    const app = createBlogPostOperationsApplication({
      store,
      now: () => observedAt,
      createId: (kind) => `${kind}_retry_authority`,
      timeZoneDatabaseVersion: () => "2026a",
      validateApprovalAuthority: async () => authorityIsLive,
    });
    const schedule = await app.commands.activateSchedule({
      actorId,
      siteId: "foundry-site",
      postId: "post-scheduled-release",
      approvalId,
      resolvedTime: resolvedTime(
        "2026-11-01T01:00:00",
        "-07:00",
        now,
      ),
      idempotencyKey: "activate-retry-authority",
    });
    observedAt = now;
    const claimed = await app.commands.claimDueSchedule(schedule.siteId, schedule.id);
    await app.commands.recordExecutionOutcome({
      lease: claimed.lease!,
      outcomeId: "retry-authority-failed",
      outcome: "failed",
      detail: "deployment_failed",
    });
    const firstRetry = await app.commands.retryExecution(
      "foundry-site",
      "post-scheduled-release",
      claimed.execution.executionId,
      actorId,
      "retry-authority-request",
    );

    authorityIsLive = false;
    await expect(app.commands.retryExecution(
      "foundry-site",
      "post-scheduled-release",
      claimed.execution.executionId,
      actorId,
      "retry-authority-request",
    )).resolves.toMatchObject({
      execution: firstRetry.execution,
      replayed: true,
    });
    await expect(app.commands.retryExecution(
      "foundry-site",
      "post-scheduled-release",
      claimed.execution.executionId,
      actorId,
      "new-retry-with-stale-authority",
    )).rejects.toMatchObject({ code: "approval_stale" });
  });

  it("audits scheduler rejections even when referenced work is missing", async () => {
    const { store } = application();
    const auditEvents: Array<
      Parameters<typeof store.recordAudit>[0]
    > = [];
    const app = createBlogPostOperationsApplication({
      store: {
        ...store,
        async recordAudit(event) {
          auditEvents.push(event);
          await store.recordAudit(event);
        },
      },
      now: () => now,
      timeZoneDatabaseVersion: () => "2026a",
    });

    await expect(
      app.commands.claimDueSchedule("foundry-site", "missing-schedule"),
    ).rejects.toMatchObject({ code: "schedule_inactive" });
    await expect(
      app.commands.retryExecution(
        "foundry-site",
        "post-scheduled-release",
        "missing-execution",
        actorId,
        "retry-missing-execution",
      ),
    ).rejects.toMatchObject({ code: "execution_not_found" });
    await expect(
      app.commands.recordExecutionOutcome({
        lease: {
          siteId: "foundry-site",
          postId: "post-scheduled-release",
          execution: {
            executionId: "missing-execution",
            scheduleId: "missing-schedule",
            publicationIdempotencyKey: "missing-publication",
            scheduledInstant: now,
            attempt: 1,
            attemptActorId: "system:scheduler",
            attemptRequestId: "missing-claim",
            leaseExpiresAt: "2026-11-01T08:05:00.000Z",
            state: "claimed",
            detail: null,
            claimedAt: now,
            updatedAt: now,
          },
          leaseToken: "missing-lease",
        },
        outcomeId: "missing-outcome",
        outcome: "blocked",
        detail: "schedule_missing",
      }),
    ).rejects.toMatchObject({ code: "schedule_inactive" });

    expect(
      auditEvents.map(({ commandType, outcome, reasonCode }) => ({
        commandType,
        outcome,
        reasonCode,
      })),
    ).toEqual([
      {
        commandType: "blog.post.schedule.claim",
        outcome: "rejected",
        reasonCode: "schedule_inactive",
      },
      {
        commandType: "blog.post.schedule.retry",
        outcome: "rejected",
        reasonCode: "execution_not_found",
      },
      {
        commandType: "blog.post.schedule.outcome",
        outcome: "rejected",
        reasonCode: "schedule_inactive",
      },
    ]);
  });

  it("identifies the exact owned publication while validating recovery authority", async () => {
    const { store } = application();
    const authorityChecks: Array<{
      approvalId: string;
      ownedPublicationIdempotencyKey?: string;
    }> = [];
    let observedAt = beforeNow;
    const app = createBlogPostOperationsApplication({
      store,
      now: () => observedAt,
      createId: (kind) => `${kind}_owned_recovery_authority`,
      timeZoneDatabaseVersion: () => "2026a",
      validateApprovalAuthority: async (
        checkedApprovalId,
        ownedPublicationIdempotencyKey,
      ) => {
        authorityChecks.push({
          approvalId: checkedApprovalId,
          ...(ownedPublicationIdempotencyKey === undefined
            ? {}
            : { ownedPublicationIdempotencyKey }),
        });
        return true;
      },
    });
    const schedule = await app.commands.activateSchedule({
      actorId,
      siteId: "foundry-site",
      postId: "post-scheduled-release",
      approvalId,
      resolvedTime: resolvedTime(
        "2026-11-01T01:00:00",
        "-07:00",
        now,
      ),
      idempotencyKey: "activate-owned-recovery-authority",
    });
    observedAt = now;
    const claim = await app.commands.claimDueSchedule(schedule.siteId, schedule.id);
    await app.commands.recordExecutionOutcome({
      lease: claim.lease!,
      outcomeId: "owned-recovery-authority-failed",
      outcome: "failed",
      detail: "deployment_failed",
    });
    await app.commands.retryExecution(
      "foundry-site",
      "post-scheduled-release",
      claim.execution.executionId,
      actorId,
      "owned-recovery-human-retry",
    );

    expect(authorityChecks).toEqual([
      { approvalId },
      {
        approvalId,
        ownedPublicationIdempotencyKey:
          claim.execution.publicationIdempotencyKey,
      },
      {
        approvalId,
        ownedPublicationIdempotencyKey:
          claim.execution.publicationIdempotencyKey,
      },
    ]);
  });

  it("archives without deletion and restores a selected snapshot as a new unpublished draft", async () => {
    const { app, store } = application(
      activePost({ liveRevisionId: "post-revision-7" }),
    );

    const archived = await app.commands.archive({
      actorId,
      siteId: "foundry-site",
      postId: "post-scheduled-release",
      selectedPostRevisionId: "post-revision-7",
      idempotencyKey: "archive-post-0001",
    });
    expect(archived).toMatchObject({
      collectionState: "archiving",
      withdrawalRequired: true,
    });

    await app.commands.confirmArchiveWithdrawal({
      siteId: "foundry-site",
      postId: "post-scheduled-release",
      publicationId: "unbound-publication",
    }).then(
      () => {
        throw new Error("expected_unbound_withdrawal_rejection");
      },
      (error: unknown) => {
        expect(error).toMatchObject({
          code: "archive_withdrawal_not_verified",
        });
      },
    );
    await app.commands.bindArchiveWithdrawalDraft({
      siteId: "foundry-site",
      postId: "post-scheduled-release",
      workspaceId,
      contentRevision: 7,
      createdBy: actorId,
      requestId: "archive-post-0001",
      occurredAt: now,
    });
    await app.commands.bindArchiveWithdrawal({
      siteId: "foundry-site",
      postId: "post-scheduled-release",
      publicationId: "publish_withdrawal",
      occurredAt: now,
    });
    await app.commands.confirmArchiveWithdrawal({
      siteId: "foundry-site",
      postId: "post-scheduled-release",
      publicationId: "publish_withdrawal",
    });
    const restored = await app.commands.restore({
      actorId,
      siteId: "foundry-site",
      postId: "post-scheduled-release",
      selectedPostRevisionId: "post-revision-7",
      idempotencyKey: "restore-post-0001",
      provenance: {
        workspaceId: createContentWorkspaceId("workspace_restored_blog"),
        contentRevision: 1,
        restoredPostRevisionId: "post-revision-restored-8",
      },
    });

    expect(restored).toMatchObject({
      collectionState: "active",
      targetVisibility: "unpublished",
      sourcePostRevisionId: "post-revision-7",
    });
    expect(await store.countPostRevisionHistory(
      "foundry-site",
      "post-scheduled-release",
    )).toBe(
      2,
    );
  });

  it("exposes no permanent deletion command", () => {
    const { app } = application();

    expect(app.commands).not.toHaveProperty("delete");
    expect(app.commands).not.toHaveProperty("deletePost");
  });

  it("rejects a schedule when its post artifact is not in the exact approval", async () => {
    const { app } = application(
      activePost({ postRevisionId: "post-revision-new" }),
      "post-revision-7",
      "different-post",
    );

    await expect(
      app.commands.activateSchedule({
        actorId,
        siteId: "foundry-site",
        postId: "post-scheduled-release",
        approvalId,
        resolvedTime: resolvedTime("2026-11-01T01:30:00", "-07:00", "2026-11-01T08:30:00.000Z"),
        idempotencyKey: "activate-stale-0001",
      }),
    ).rejects.toEqual(
      new BlogPostOperationError("approval_stale"),
    );
  });
});
