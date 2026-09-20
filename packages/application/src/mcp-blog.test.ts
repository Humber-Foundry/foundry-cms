import { describe, expect, it } from "vitest";

import { referenceSiteDefinition } from "@humber-foundry/site-definition";

import {
  BlogPostOperationError,
  createContentWorkspaceId,
  createInMemoryPublishedSiteRepository,
  createMcpBlogApplication,
  createMcpReadApplication,
  createPublishedSiteBundle,
  createSiteApplication,
  mcpContentDraftScope,
  mcpInitialScope,
  mcpPublicationScheduleScope,
  type BlogPostOperationalState,
  type McpBlogOperationAuthority,
  type McpBlogRuntime,
  type McpConnectionGrant,
  type McpConnectionPrincipal,
  type McpReadAuditEvent,
} from "./index";

const now = "2026-09-20T18:00:00.000Z";
const siteId = referenceSiteDefinition.site.id;
const postId = "11111111-1111-4111-8111-111111111111";
const idempotencyKey = "22222222-2222-4222-8222-222222222222";
const workspaceId = createContentWorkspaceId("workspace_blog_mcp");

const context = {
  throwIfExpired() {},
  run: <Result>(operation: () => Promise<Result>) => operation(),
  finishDurably: <Result>(operation: () => Promise<Result>) => operation(),
};

function principal(
  scopes: ReadonlyArray<string>,
): McpConnectionPrincipal {
  return {
    connectionId: "connection-blog-71",
    actorId: "agent-blog-71",
    clientId: "https://client.example/mcp.json",
    siteId,
    scopes: [mcpInitialScope, ...scopes],
  };
}

function operationalState(
  overrides: Partial<BlogPostOperationalState> = {},
): BlogPostOperationalState {
  return {
    siteId,
    postId,
    workspaceId,
    contentRevision: 4,
    postRevision: 2,
    postRevisionId: "post_revision_2",
    collectionState: "active",
    workflowState: "editing",
    liveRevisionId: null,
    version: 3,
    ...overrides,
  };
}

function resultOf<Result>(value: unknown): Result {
  return (value as { result: Result }).result;
}

function fixture(runtime: Partial<McpBlogRuntime> = {}) {
  const audit: McpReadAuditEvent[] = [];
  let grant: McpConnectionGrant | null = null;
  const read = createMcpReadApplication({
    site: createSiteApplication({
      siteId,
      publishedSites: createInMemoryPublishedSiteRepository([
        createPublishedSiteBundle(referenceSiteDefinition),
      ]),
    }),
    siteMetadata: {
      canonicalUrl: "https://foundry.example",
      locale: "en-CA",
      timeZone: "America/Vancouver",
      async getLiveRelease() {
        return null;
      },
    },
    connections: {
      async findCurrentConnection() {
        return grant;
      },
      async recordInvocation(event) {
        audit.push(event);
      },
    },
    cursors: {
      async encode() {
        return "unused";
      },
      async decode() {
        throw new Error("unused");
      },
    },
    createInvocationId: () => "invocation-blog",
    now: () => now,
  });
  const archiveCalls: Array<Record<string, unknown>> = [];
  const restoreCalls: Array<Record<string, unknown>> = [];
  const scheduleCalls: Array<Record<string, unknown>> = [];
  const defaults: McpBlogRuntime = {
    async findPost() {
      return operationalState();
    },
    async archivePost(input) {
      archiveCalls.push({ ...input });
      return {
        archiveRequestId: input.idempotencyKey,
        archived: {
          ...operationalState({ collectionState: "archived" }),
          selectedPostRevisionId: input.selectedPostRevisionId,
          withdrawalRequired: false,
        },
      };
    },
    async restorePost(input) {
      restoreCalls.push({ ...input });
      return {
        workspaceId: "workspace_blog_restore",
        revision: 1,
        postId: input.postId,
        postRevision: 3,
        targetVisibility: "unpublished",
      };
    },
    async requestSchedule(input) {
      scheduleCalls.push({ ...input });
      return {
        id: "schedule_proposal_1",
        siteId,
        postId: input.postId,
        workspaceId,
        contentRevision: 4,
        postRevisionId: "post_revision_2",
        authorityVersion: 3,
        localDateTime: input.resolvedTime.localDateTime,
        ianaTimeZone: input.resolvedTime.ianaTimeZone,
        utcOffsetChoice: input.resolvedTime.utcOffsetChoice,
        executeAtUtc: input.resolvedTime.executeAtUtc,
        timeZoneDatabaseVersion: "2026a",
        createdBy: input.actorId as never,
        proposalAuditId: "blog.post.schedule.proposal:schedule_proposal_1",
        createdAt: now,
      };
    },
  };
  const application = createMcpBlogApplication({
    base: read,
    runtime: { ...defaults, ...runtime },
  });
  return {
    application,
    audit,
    archiveCalls,
    restoreCalls,
    scheduleCalls,
    setGrant(next: McpConnectionGrant | null) {
      grant = next;
    },
  };
}

function activeGrant(
  scopes: ReadonlyArray<string>,
): McpConnectionGrant {
  return { ...principal(scopes), status: "active" };
}

describe("MCP blog archive", () => {
  it("archives the post as it stands and carries the connection's own authority", async () => {
    const value = fixture();
    value.setGrant(activeGrant([mcpContentDraftScope]));
    const result = resultOf<{
      postId: string;
      collectionState: string;
      removalFromSiteNeedsApproval: boolean;
    }>(
      await value.application.archiveBlogPost(
        principal([mcpContentDraftScope]),
        { postId, idempotencyKey },
        context,
      ),
    );
    expect(result).toMatchObject({
      postId,
      collectionState: "archived",
      removalFromSiteNeedsApproval: false,
    });
    // The agent did not choose a revision. The command acts on the post's
    // current revision, the way the dashboard's own control does.
    expect(value.archiveCalls[0]).toMatchObject({
      selectedPostRevisionId: "post_revision_2",
      actorId: "mcp-agent-blog-71",
    });
    // The connection acts as itself, never as the person who granted it.
    expect(
      value.archiveCalls[0]!.authority as McpBlogOperationAuthority,
    ).toEqual({
      kind: "mcp",
      connectionId: "connection-blog-71",
      actorId: "agent-blog-71",
      operation: "foundry.blog.archive",
      requiredScopes: [mcpContentDraftScope],
    });
  });

  it("says a live post stays on the site until a person approves its removal", async () => {
    const value = fixture({
      async archivePost(input) {
        return {
          archiveRequestId: input.idempotencyKey,
          archived: {
            ...operationalState({ collectionState: "archiving" }),
            selectedPostRevisionId: input.selectedPostRevisionId,
            withdrawalRequired: true,
          },
        };
      },
    });
    value.setGrant(activeGrant([mcpContentDraftScope]));
    expect(
      resultOf<{
        collectionState: string;
        removalFromSiteNeedsApproval: boolean;
      }>(
        await value.application.archiveBlogPost(
          principal([mcpContentDraftScope]),
          { postId, idempotencyKey },
          context,
        ),
      ),
    ).toMatchObject({
      collectionState: "archiving",
      removalFromSiteNeedsApproval: true,
    });
  });

  it("refuses to archive without the content draft permission", async () => {
    const value = fixture();
    value.setGrant(activeGrant([]));
    await expect(
      value.application.archiveBlogPost(
        principal([]),
        { postId, idempotencyKey },
        context,
      ),
    ).rejects.toMatchObject({
      code: "INSUFFICIENT_SCOPE",
      requiredScopes: [mcpContentDraftScope],
    });
    expect(value.archiveCalls).toHaveLength(0);
  });

  it("answers a post that is not in this site's blog as not found", async () => {
    const value = fixture({
      async findPost() {
        return null;
      },
    });
    value.setGrant(activeGrant([mcpContentDraftScope]));
    await expect(
      value.application.archiveBlogPost(
        principal([mcpContentDraftScope]),
        { postId, idempotencyKey },
        context,
      ),
    ).rejects.toMatchObject({
      code: "OBJECT_NOT_FOUND",
      reason: "post_not_found",
    });
  });

  it("names the blog's own reason when the post is already archived", async () => {
    const value = fixture({
      async archivePost() {
        throw new BlogPostOperationError("post_already_archived");
      },
    });
    value.setGrant(activeGrant([mcpContentDraftScope]));
    await expect(
      value.application.archiveBlogPost(
        principal([mcpContentDraftScope]),
        { postId, idempotencyKey },
        context,
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      reason: "post_already_archived",
    });
  });
});

describe("MCP blog restore", () => {
  it("brings the post back as an unpublished draft", async () => {
    const value = fixture();
    value.setGrant(activeGrant([mcpContentDraftScope]));
    expect(
      resultOf<{
        postId: string;
        workspaceId: string;
        revision: number;
        targetVisibility: string;
      }>(
        await value.application.restoreBlogPost(
          principal([mcpContentDraftScope]),
          { postId, idempotencyKey },
          context,
        ),
      ),
    ).toEqual({
      postId,
      workspaceId: "workspace_blog_restore",
      revision: 1,
      postRevision: 3,
      targetVisibility: "unpublished",
    });
    expect(
      (value.restoreCalls[0]!.authority as McpBlogOperationAuthority)
        .operation,
    ).toBe("foundry.blog.restore");
  });

  it("refuses to restore without the content draft permission", async () => {
    const value = fixture();
    value.setGrant(activeGrant([mcpPublicationScheduleScope]));
    await expect(
      value.application.restoreBlogPost(
        principal([mcpPublicationScheduleScope]),
        { postId, idempotencyKey },
        context,
      ),
    ).rejects.toMatchObject({
      code: "INSUFFICIENT_SCOPE",
      requiredScopes: [mcpContentDraftScope],
    });
  });
});

describe("MCP blog schedule request", () => {
  it("records a request a person still has to approve", async () => {
    const value = fixture();
    value.setGrant(activeGrant([mcpPublicationScheduleScope]));
    const result = resultOf<{
      requestId: string;
      postId: string;
      publishAt: string;
      state: string;
    }>(
      await value.application.requestBlogSchedule(
        principal([mcpPublicationScheduleScope]),
        {
          postId,
          publishAt: "2026-10-01T15:00:00Z",
          reportingTimeZone: "America/Vancouver",
          idempotencyKey,
        },
        context,
      ),
    );
    expect(result).toMatchObject({
      requestId: "schedule_proposal_1",
      postId,
      state: "pending_human_approval",
    });
    expect(new Date(result.publishAt).toISOString()).toBe(
      "2026-10-01T15:00:00.000Z",
    );
    expect(
      (value.scheduleCalls[0]!.authority as McpBlogOperationAuthority)
        .operation,
    ).toBe("foundry.blog.schedule_request");
  });

  it("refuses a schedule request without the schedule permission", async () => {
    const value = fixture();
    value.setGrant(activeGrant([mcpContentDraftScope]));
    await expect(
      value.application.requestBlogSchedule(
        principal([mcpContentDraftScope]),
        {
          postId,
          publishAt: "2026-10-01T15:00:00Z",
          reportingTimeZone: "America/Vancouver",
          idempotencyKey,
        },
        context,
      ),
    ).rejects.toMatchObject({
      code: "INSUFFICIENT_SCOPE",
      requiredScopes: [mcpPublicationScheduleScope],
    });
    expect(value.scheduleCalls).toHaveLength(0);
  });

  it("refuses a time zone the scheduler cannot resolve", async () => {
    const value = fixture();
    value.setGrant(activeGrant([mcpPublicationScheduleScope]));
    await expect(
      value.application.requestBlogSchedule(
        principal([mcpPublicationScheduleScope]),
        {
          postId,
          publishAt: "2026-10-01T15:00:00Z",
          reportingTimeZone: "Nowhere/Invented",
          idempotencyKey,
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(value.scheduleCalls).toHaveLength(0);
  });
});
