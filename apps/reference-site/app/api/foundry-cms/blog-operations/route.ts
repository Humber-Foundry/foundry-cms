import {
  AccessDeniedError,
  BlogPostOperationError,
  createContentActorId,
  createContentApprovalId,
} from "@humber-foundry/application";
import { createBlogPostId, referenceSiteDefinition } from "@humber-foundry/site-definition";

import {
  archiveBlogPostWithWithdrawal,
  continueArchiveBlogPostWithdrawal,
  loadBlogPostOperationsApplication,
  recoverArchiveBlogPostWithdrawalAccess,
  retryScheduledBlogPostExecution,
  restoreArchivedBlogPostAsDraft,
} from "../../../../src/blog-post-operations-runtime";
import {
  loadHumanAccessEnvironment,
} from "../../../../src/human-access-environment";
import {
  authorizeAuthenticatedHumanIdentity,
  loadHumanIdentityRequestContext,
} from "../../../../src/human-access-runtime";
import {
  executeIdempotentHumanMutation,
  HumanMutationExecutionNotStartedError,
  HumanMutationExecutionResumableError,
  verifyHumanMutation,
} from "../../../../src/human-mutation-runtime";
import {
  humanMutationResultHeader,
  recordedHumanMutationResult,
} from "../../../../src/human-mutation-protocol";

type ActivateScheduleCommand = Readonly<{
  operation: "activate_schedule";
  postId: string;
  approvalId: string;
  resolvedTime: Readonly<{
    localDateTime: string;
    ianaTimeZone: string;
    utcOffsetChoice: string;
    executeAtUtc: string;
  }>;
}>;

type ProposeScheduleCommand = Readonly<{
  operation: "propose_schedule";
  postId: string;
  resolvedTime: ActivateScheduleCommand["resolvedTime"];
}>;

type CancelScheduleCommand = Readonly<{
  operation: "cancel_schedule";
  postId: string;
  scheduleId: string;
}>;

type ArchiveCommand = Readonly<{
  operation: "archive";
  postId: string;
  selectedPostRevisionId: string;
}>;

type ContinueArchiveWithdrawalCommand = Readonly<{
  operation: "continue_archive_withdrawal";
  postId: string;
  archiveRequestId: string;
  withdrawalApprovalId: string;
}>;

type RecoverArchiveWithdrawalAccessCommand = Readonly<{
  operation: "recover_archive_withdrawal_access";
  postId: string;
  archiveRequestId: string;
}>;

type RestoreCommand = Readonly<{
  operation: "restore";
  postId: string;
  selectedPostRevisionId: string;
}>;
type RetryExecutionCommand = Readonly<{
  operation: "retry_execution";
  postId: string;
  executionId: string;
}>;

type BlogCommand =
  | ActivateScheduleCommand
  | ProposeScheduleCommand
  | CancelScheduleCommand
  | ArchiveCommand
  | ContinueArchiveWithdrawalCommand
  | RecoverArchiveWithdrawalAccessCommand
  | RestoreCommand
  | RetryExecutionCommand;

const operationMetadata = Object.freeze({
  activate_schedule: {
    commandType: "blog.post.schedule.activate",
  },
  propose_schedule: {
    commandType: "blog.post.schedule.propose",
  },
  cancel_schedule: {
    commandType: "blog.post.schedule.cancel",
  },
  archive: {
    commandType: "blog.post.archive",
  },
  continue_archive_withdrawal: {
    commandType: "blog.post.archive.withdrawal.continue",
  },
  recover_archive_withdrawal_access: {
    commandType: "blog.post.archive.withdrawal.recover_access",
  },
  restore: {
    commandType: "blog.post.restore",
  },
  retry_execution: {
    commandType: "blog.post.schedule.retry",
  },
} as const);

type BlogOperation = keyof typeof operationMetadata;

function isBlogOperation(value: unknown): value is BlogOperation {
  return (
    typeof value === "string" &&
    Object.hasOwn(operationMetadata, value)
  );
}

const commandReaders: {
  [Operation in BlogOperation]: (
    candidate: Record<string, unknown>,
  ) => Extract<BlogCommand, { operation: Operation }> | null;
} = {
  cancel_schedule(candidate) {
    return typeof candidate.postId === "string" &&
      typeof candidate.scheduleId === "string"
      ? candidate as CancelScheduleCommand
      : null;
  },
  retry_execution(candidate) {
    return typeof candidate.postId === "string" &&
      typeof candidate.executionId === "string"
      ? candidate as RetryExecutionCommand
      : null;
  },
  continue_archive_withdrawal(candidate) {
    return typeof candidate.postId === "string" &&
      typeof candidate.archiveRequestId === "string" &&
      typeof candidate.withdrawalApprovalId === "string"
      ? candidate as ContinueArchiveWithdrawalCommand
      : null;
  },
  recover_archive_withdrawal_access(candidate) {
    return typeof candidate.postId === "string" &&
      typeof candidate.archiveRequestId === "string"
      ? candidate as RecoverArchiveWithdrawalAccessCommand
      : null;
  },
  archive(candidate) {
    return typeof candidate.postId === "string" &&
      typeof candidate.selectedPostRevisionId === "string"
      ? candidate as ArchiveCommand
      : null;
  },
  restore(candidate) {
    return typeof candidate.postId === "string" &&
      typeof candidate.selectedPostRevisionId === "string"
      ? candidate as RestoreCommand
      : null;
  },
  activate_schedule(candidate) {
    const resolvedTime =
      typeof candidate.resolvedTime === "object" &&
      candidate.resolvedTime !== null
        ? candidate.resolvedTime as Record<string, unknown>
        : null;
    return typeof candidate.postId === "string" &&
      typeof candidate.approvalId === "string" &&
      resolvedTime !== null &&
      typeof resolvedTime.localDateTime === "string" &&
      typeof resolvedTime.ianaTimeZone === "string" &&
      typeof resolvedTime.utcOffsetChoice === "string" &&
      typeof resolvedTime.executeAtUtc === "string"
      ? candidate as ActivateScheduleCommand
      : null;
  },
  propose_schedule(candidate) {
    const resolvedTime =
      typeof candidate.resolvedTime === "object" &&
      candidate.resolvedTime !== null
        ? candidate.resolvedTime as Record<string, unknown>
        : null;
    return typeof candidate.postId === "string" &&
      resolvedTime !== null &&
      typeof resolvedTime.localDateTime === "string" &&
      typeof resolvedTime.ianaTimeZone === "string" &&
      typeof resolvedTime.utcOffsetChoice === "string" &&
      typeof resolvedTime.executeAtUtc === "string"
      ? candidate as ProposeScheduleCommand
      : null;
  },
};

function readCommand(
  value: unknown,
): BlogCommand | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  return isBlogOperation(candidate.operation)
    ? commandReaders[candidate.operation](candidate) as BlogCommand | null
    : null;
}

export async function GET(request: Request) {
  try {
    const identity = await loadHumanIdentityRequestContext(request.headers);
    const access = await authorizeAuthenticatedHumanIdentity(identity);
    if (access.state !== "authorized") {
      throw new AccessDeniedError("membership_not_active");
    }
    const url = new URL(request.url);
    const scheduleId = url.searchParams.get("scheduleId");
    const executionId = url.searchParams.get("executionId");
    if ((scheduleId === null) === (executionId === null)) {
      return Response.json({ error: "invalid_query" }, { status: 400 });
    }
    const application = await loadBlogPostOperationsApplication(
      await loadHumanAccessEnvironment(),
    );
    if (executionId !== null) {
      const execution = await application.queries.getExecution(
        referenceSiteDefinition.site.id,
        executionId,
      );
      if (execution === null) {
        return Response.json({ execution: null });
      }
      return Response.json(
        { execution },
        { headers: { "cache-control": "no-store" } },
      );
    }
    const schedule = await application.queries.getSchedule(
      referenceSiteDefinition.site.id,
      scheduleId!,
    );
    return Response.json(
      { schedule },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof AccessDeniedError) {
      return Response.json({ error: "request_check_failed" }, { status: 403 });
    }
    throw error;
  }
}

function recorded(response: Response) {
  const headers = new Headers(response.headers);
  headers.set(humanMutationResultHeader, recordedHumanMutationResult);
  return new Response(response.body, { status: response.status, headers });
}

export async function POST(request: Request) {
  try {
    const identity = await loadHumanIdentityRequestContext(request.headers);
    await verifyHumanMutation(request, identity.identity);
    const submitted = await request.json().catch(() => null);
    const command = readCommand(submitted);
    if (command === null) {
      const candidate =
        typeof submitted === "object" && submitted !== null
          ? submitted as Record<string, unknown>
          : null;
      const access = await authorizeAuthenticatedHumanIdentity(identity);
      if (access.state === "authorized") {
        const application = await loadBlogPostOperationsApplication(
          await loadHumanAccessEnvironment(),
        );
        let rejectedPostId = null;
        try {
          rejectedPostId =
            candidate !== null && typeof candidate.postId === "string"
              ? createBlogPostId(candidate.postId)
              : null;
        } catch {
          // The audit target stays null when the submitted ID is malformed.
        }
        await application.commands.recordRejectedCommand({
          actorId: createContentActorId(access.membership.id),
          siteId: referenceSiteDefinition.site.id,
          postId: rejectedPostId,
          commandType:
            candidate !== null && isBlogOperation(candidate.operation)
              ? operationMetadata[candidate.operation].commandType
              : "blog.post.command.unknown",
          requestId:
            request.headers.get("idempotency-key") ??
            `invalid:${crypto.randomUUID()}`,
          reasonCode: "blog_command_invalid",
        });
      }
      return Response.json({ error: "invalid_command" }, { status: 400 });
    }
    let postId;
    try {
      postId = createBlogPostId(command.postId);
      if (command.operation === "activate_schedule") {
        createContentApprovalId(command.approvalId);
      } else if (command.operation === "continue_archive_withdrawal") {
        createContentApprovalId(command.withdrawalApprovalId);
      }
    } catch {
      const access = await authorizeAuthenticatedHumanIdentity(identity);
      if (access.state === "authorized") {
        const application = await loadBlogPostOperationsApplication(
          await loadHumanAccessEnvironment(),
        );
        await application.commands.recordRejectedCommand({
          actorId: createContentActorId(access.membership.id),
          siteId: referenceSiteDefinition.site.id,
          postId: null,
          commandType:
            operationMetadata[command.operation].commandType,
          requestId:
            request.headers.get("idempotency-key") ??
            `invalid:${crypto.randomUUID()}`,
          reasonCode: "blog_command_invalid",
        });
      }
      return Response.json({ error: "invalid_command" }, { status: 400 });
    }
    const response = await executeIdempotentHumanMutation({
      request,
      identity: identity.identity,
      command,
      execute: async () => {
        const access = await authorizeAuthenticatedHumanIdentity(identity);
        if (access.state !== "authorized") {
          return Response.json({ error: "not_authorized" }, { status: 403 });
        }
        const actorId = createContentActorId(access.membership.id);
        const idempotencyKey =
          request.headers.get("idempotency-key") ?? "";
        try {
          const environment = await loadHumanAccessEnvironment();
          switch (command.operation) {
            case "restore": {
              const draft = await restoreArchivedBlogPostAsDraft({
                environment,
                actorId,
                postId,
                selectedPostRevisionId: command.selectedPostRevisionId,
                idempotencyKey,
              });
              return Response.json({ draft }, { status: 201 });
            }
            case "retry_execution": {
              const retried = await retryScheduledBlogPostExecution(
                environment,
                referenceSiteDefinition.site.id,
                postId,
                command.executionId,
                actorId,
                idempotencyKey,
              );
              return Response.json(
                { execution: retried },
                { status: 202 },
              );
            }
            case "archive": {
              const result = await archiveBlogPostWithWithdrawal({
                environment,
                actorId,
                postId,
                selectedPostRevisionId: command.selectedPostRevisionId,
                idempotencyKey,
              });
              return Response.json(result, { status: 202 });
            }
            case "continue_archive_withdrawal": {
              const result = await continueArchiveBlogPostWithdrawal({
                environment,
                actorId,
                postId,
                archiveRequestId: command.archiveRequestId,
                withdrawalApprovalId: command.withdrawalApprovalId,
                requestId: idempotencyKey,
              });
              return Response.json(result, { status: 202 });
            }
            case "recover_archive_withdrawal_access": {
              const result =
                await recoverArchiveBlogPostWithdrawalAccess({
                  environment,
                  actorId,
                  postId,
                  archiveRequestId: command.archiveRequestId,
                  requestId: idempotencyKey,
                });
              return Response.json(result, { status: 200 });
            }
            case "activate_schedule": {
              const application =
                await loadBlogPostOperationsApplication(environment);
              const schedule =
                await application.commands.activateSchedule({
                  actorId,
                  siteId: referenceSiteDefinition.site.id,
                  postId,
                  approvalId: createContentApprovalId(
                    command.approvalId,
                  ),
                  resolvedTime: command.resolvedTime,
                  idempotencyKey,
                });
              return Response.json({ schedule }, { status: 201 });
            }
            case "propose_schedule": {
              const application =
                await loadBlogPostOperationsApplication(environment);
              const proposal =
                await application.commands.proposeSchedule({
                  actorId,
                  siteId: referenceSiteDefinition.site.id,
                  postId,
                  resolvedTime: command.resolvedTime,
                  idempotencyKey,
                });
              return Response.json({ proposal }, { status: 201 });
            }
            case "cancel_schedule": {
              const application =
                await loadBlogPostOperationsApplication(environment);
              const schedule = await application.commands.cancelSchedule({
                actorId,
                siteId: referenceSiteDefinition.site.id,
                postId,
                scheduleId: command.scheduleId,
                idempotencyKey,
              });
              return Response.json({ schedule }, { status: 200 });
            }
          }
        } catch (error) {
          if (error instanceof BlogPostOperationError) {
            return Response.json(
              {
                error: error.code,
                ...(error.details === undefined
                  ? {}
                  : { details: error.details }),
              },
              { status: 422 },
            );
          }
          throw new HumanMutationExecutionResumableError(error);
        }
      },
    });
    return recorded(response);
  } catch (error) {
    if (error instanceof AccessDeniedError) {
      return Response.json({ error: "request_check_failed" }, { status: 403 });
    }
    if (error instanceof BlogPostOperationError) {
      return Response.json(
        {
          error: error.code,
          ...(error.details === undefined
            ? {}
            : { details: error.details }),
        },
        { status: 422 },
      );
    }
    if (error instanceof HumanMutationExecutionNotStartedError) {
      return Response.json(
        { error: "request_check_unavailable" },
        { status: 503 },
      );
    }
    throw error;
  }
}
