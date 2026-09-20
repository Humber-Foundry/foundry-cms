import type { SiteId } from "@humber-foundry/site-definition";

import {
  BlogPostOperationError,
  resolvePostPublicationInstant,
  type BlogPostArchiveResult,
  type BlogPostOperationalState,
  type BlogPostScheduleProposal,
  type McpBlogOperationAuthority,
} from "./blog-post-operations";
import { createMcpContentActorId } from "./mcp-drafts";
import {
  McpReadError,
  mcpContentDraftScope,
  mcpPublicationScheduleScope,
  type McpConnectionPrincipal,
  type McpExecutionContext,
} from "./mcp-read";

/**
 * What an agent has to be able to do to the blog outside a draft: take a post
 * out of the collection, put it back, and ask a person to publish it at a
 * named time.
 *
 * Each of these calls the one application command the dashboard calls. The
 * MCP front adds the connection's permission, the connection's own authority
 * record, and a refusal an agent can read. See ADR-0036.
 */
export type McpBlogRuntime = Readonly<{
  /** The post's current operational state, or `null` when there is none. */
  findPost(input: {
    principal: McpConnectionPrincipal;
    postId: string;
  }): Promise<BlogPostOperationalState | null>;
  archivePost(input: {
    principal: McpConnectionPrincipal;
    actorId: string;
    postId: string;
    selectedPostRevisionId: string;
    idempotencyKey: string;
    authority: McpBlogOperationAuthority;
  }): Promise<
    Readonly<{
      archiveRequestId: string;
      archived: BlogPostArchiveResult;
    }>
  >;
  restorePost(input: {
    principal: McpConnectionPrincipal;
    actorId: string;
    postId: string;
    selectedPostRevisionId: string;
    idempotencyKey: string;
    authority: McpBlogOperationAuthority;
  }): Promise<
    Readonly<{
      workspaceId: string;
      revision: number;
      postId: string;
      postRevision: number;
      targetVisibility: "unpublished";
    }>
  >;
  requestSchedule(input: {
    principal: McpConnectionPrincipal;
    actorId: string;
    postId: string;
    resolvedTime: ReturnType<typeof resolvedScheduleTime>;
    idempotencyKey: string;
    authority: McpBlogOperationAuthority;
  }): Promise<BlogPostScheduleProposal>;
}>;

type McpBlogApplicationBase = Readonly<{
  executeScoped<Result>(input: {
    principal: McpConnectionPrincipal;
    operation: string;
    auditInput: unknown;
    requiredScopes: ReadonlyArray<string>;
    context: McpExecutionContext;
    run(context: McpExecutionContext): Promise<Result>;
  }): Promise<unknown>;
}>;

/**
 * The named reason a blog command is refused for when the post an agent named
 * is not in the site's blog at all.
 */
const blogPostNotFoundReason = "post_not_found";

function resolvedScheduleTime(
  publishAt: string,
  reportingTimeZone: string,
) {
  return resolvePostPublicationInstant(publishAt, reportingTimeZone);
}

/**
 * Turn a refused blog command into the tool error an agent acts on.
 *
 * The blog's own code is the named reason, so an agent branches on the same
 * word the dashboard shows a site owner. A refusal that names a permission
 * says which one.
 */
function blogOperationError(
  error: unknown,
  requiredScopes: ReadonlyArray<string>,
): McpReadError {
  if (error instanceof McpReadError) return error;
  if (error instanceof BlogPostOperationError) {
    if (
      error.code === "mcp_blog_authority_required" ||
      error.code === "mcp_schedule_authority_required" ||
      error.code === "human_authority_required" ||
      error.code === "schedule_proposal_authority_required"
    ) {
      return new McpReadError(
        "INSUFFICIENT_SCOPE",
        "The connection no longer grants this blog permission.",
        { requiredScopes, reason: error.code },
      );
    }
    if (error.code === "idempotency_key_conflict") {
      return new McpReadError(
        "IDEMPOTENCY_KEY_REUSED",
        "The idempotency key was already used for different input.",
        { reason: error.code },
      );
    }
    if (
      error.code === "post_not_found" ||
      error.code === "revision_not_found"
    ) {
      return new McpReadError(
        "OBJECT_NOT_FOUND",
        "The requested object was not found.",
        { reason: error.code },
      );
    }
    return new McpReadError(
      "VALIDATION_FAILED",
      "The blog command is not valid in the post's current state.",
      { reason: error.code },
    );
  }
  return new McpReadError(
    "TEMPORARILY_UNAVAILABLE",
    "The request could not be completed safely.",
  );
}

export function createMcpBlogApplication({
  base,
  runtime,
}: {
  base: McpBlogApplicationBase;
  runtime: McpBlogRuntime;
}) {
  /**
   * Read the post an agent named, and say which revision of it the command
   * acts on. An agent never picks a revision: it acts on the post as it
   * stands, the way the dashboard's own control does.
   */
  async function currentPost(
    principal: McpConnectionPrincipal,
    postId: string,
  ) {
    const post = await runtime.findPost({ principal, postId });
    if (post === null || post.siteId !== (principal.siteId as SiteId)) {
      throw new McpReadError(
        "OBJECT_NOT_FOUND",
        "The requested object was not found.",
        { reason: blogPostNotFoundReason },
      );
    }
    return post;
  }

  function authority(
    principal: McpConnectionPrincipal,
    operation: McpBlogOperationAuthority["operation"],
    requiredScopes: ReadonlyArray<string>,
  ): McpBlogOperationAuthority {
    return {
      kind: "mcp",
      connectionId: principal.connectionId,
      actorId: principal.actorId,
      operation,
      requiredScopes,
    };
  }

  return Object.freeze({
    /**
     * Take one post out of the blog.
     *
     * A post that was never on the site leaves at once. A post that is on the
     * site enters `archiving`: the removal itself is an ordinary publication
     * that a person still has to review and approve, so an agent can never
     * take a live post off the public site on its own. See ADR-0036.
     */
    archiveBlogPost(
      principal: McpConnectionPrincipal,
      input: Readonly<{ postId: string; idempotencyKey: string }>,
      context: McpExecutionContext,
    ) {
      const requiredScopes = [mcpContentDraftScope];
      return base.executeScoped({
        principal,
        operation: "foundry.blog.archive",
        auditInput: input,
        requiredScopes,
        context,
        async run() {
          try {
            const post = await currentPost(principal, input.postId);
            const result = await runtime.archivePost({
              principal,
              actorId: createMcpContentActorId(principal),
              postId: input.postId,
              selectedPostRevisionId: post.postRevisionId,
              idempotencyKey: input.idempotencyKey,
              authority: authority(
                principal,
                "foundry.blog.archive",
                requiredScopes,
              ),
            });
            return {
              postId: input.postId,
              archiveRequestId: result.archiveRequestId,
              collectionState: result.archived.collectionState,
              removalFromSiteNeedsApproval:
                result.archived.withdrawalRequired,
            };
          } catch (error) {
            throw blogOperationError(error, requiredScopes);
          }
        },
      });
    },
    /**
     * Put one archived post back as a draft.
     *
     * The post comes back unpublished, in a new workspace revision. Nothing
     * goes back on the site until a person approves and publishes it.
     */
    restoreBlogPost(
      principal: McpConnectionPrincipal,
      input: Readonly<{ postId: string; idempotencyKey: string }>,
      context: McpExecutionContext,
    ) {
      const requiredScopes = [mcpContentDraftScope];
      return base.executeScoped({
        principal,
        operation: "foundry.blog.restore",
        auditInput: input,
        requiredScopes,
        context,
        async run() {
          try {
            const post = await currentPost(principal, input.postId);
            const restored = await runtime.restorePost({
              principal,
              actorId: createMcpContentActorId(principal),
              postId: input.postId,
              selectedPostRevisionId: post.postRevisionId,
              idempotencyKey: input.idempotencyKey,
              authority: authority(
                principal,
                "foundry.blog.restore",
                requiredScopes,
              ),
            });
            return {
              postId: input.postId,
              workspaceId: restored.workspaceId,
              revision: restored.revision,
              postRevision: restored.postRevision,
              targetVisibility: restored.targetVisibility,
            };
          } catch (error) {
            throw blogOperationError(error, requiredScopes);
          }
        },
      });
    },
    /**
     * Ask a person to publish one post at a named time.
     *
     * This records a request and nothing else. A schedule only exists after a
     * person opens the post in the dashboard, approves that exact revision
     * and turns the request into a schedule. An agent cannot approve, and
     * cannot publish. See ADR-0036 and ADR-0025.
     */
    requestBlogSchedule(
      principal: McpConnectionPrincipal,
      input: Readonly<{
        postId: string;
        publishAt: string;
        reportingTimeZone: string;
        idempotencyKey: string;
      }>,
      context: McpExecutionContext,
    ) {
      const requiredScopes = [mcpPublicationScheduleScope];
      return base.executeScoped({
        principal,
        operation: "foundry.blog.schedule_request",
        auditInput: input,
        requiredScopes,
        context,
        async run() {
          try {
            await currentPost(principal, input.postId);
            const proposal = await runtime.requestSchedule({
              principal,
              actorId: createMcpContentActorId(principal),
              postId: input.postId,
              resolvedTime: resolvedScheduleTime(
                input.publishAt,
                input.reportingTimeZone,
              ),
              idempotencyKey: input.idempotencyKey,
              authority: authority(
                principal,
                "foundry.blog.schedule_request",
                requiredScopes,
              ),
            });
            return {
              requestId: proposal.id,
              postId: input.postId,
              publishAt: proposal.executeAtUtc,
              reportingTimeZone: proposal.ianaTimeZone,
              state: "pending_human_approval" as const,
            };
          } catch (error) {
            throw blogOperationError(error, requiredScopes);
          }
        },
      });
    },
  });
}
