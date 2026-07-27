import {
  AccessDeniedError,
  ContentApprovalInvalidError,
  ContentPublicationValidationError,
  ContentRevisionConfigurationError,
  ContentWorkspaceAccessError,
  createContentActorId,
  createContentApprovalId,
  createContentPublicationId,
  createContentWorkspaceId,
} from "@foundry/application";

import {
  AccessIdentityError,
  AccessIdentityUnavailableError,
} from "../../../../src/access-identity";
import { loadContentPublicationApplication } from "../../../../src/content-publication-runtime";
import {
  GitHubContentPublisherConfigurationError,
} from "../../../../src/github-content-publisher";
import { HumanAccessConfigurationError } from "../../../../src/human-access-configuration";
import {
  authorizeAuthenticatedHumanIdentity,
  loadHumanIdentityRequestContext,
} from "../../../../src/human-access-runtime";
import {
  executeIdempotentHumanMutation,
  HumanMutationExecutionNotStartedError,
  HumanMutationIdempotencyError,
  verifyHumanMutation,
} from "../../../../src/human-mutation-runtime";
import {
  humanMutationResultHeader,
  recordedHumanMutationResult,
} from "../../../../src/human-mutation-protocol";
import { HumanRequestIntegrityError } from "../../../../src/human-request-integrity";

type ApproveCommand = Readonly<{
  operation: "approve";
  workspaceId: string;
  revision: number;
  previewConfirmed: true;
}>;

type PublishCommand = Readonly<{
  operation: "publish";
  workspaceId: string;
  approvalId: string;
}>;

function readCommand(value: unknown): ApproveCommand | PublishCommand | null {
  if (
    typeof value !== "object" ||
    value === null ||
    !("operation" in value) ||
    !("workspaceId" in value) ||
    typeof value.workspaceId !== "string"
  ) {
    return null;
  }
  if (
    value.operation === "approve" &&
    "revision" in value &&
    Number.isSafeInteger(value.revision) &&
    (value.revision as number) >= 0 &&
    "previewConfirmed" in value &&
    value.previewConfirmed === true
  ) {
    return value as ApproveCommand;
  }
  if (
    value.operation === "publish" &&
    "approvalId" in value &&
    typeof value.approvalId === "string"
  ) {
    return value as PublishCommand;
  }
  return null;
}

function domainErrorResponse(error: unknown): Response | null {
  if (error instanceof ContentApprovalInvalidError) {
    return Response.json(
      { error: error.code },
      {
        status:
          error.code === "approval_not_found" ? 404 : 409,
      },
    );
  }
  if (error instanceof ContentPublicationValidationError) {
    return Response.json({ error: error.code }, { status: 422 });
  }
  if (error instanceof ContentWorkspaceAccessError) {
    return Response.json({ error: "workspace_access_denied" }, { status: 403 });
  }
  return null;
}

function recorded(response: Response) {
  const headers = new Headers(response.headers);
  headers.set(humanMutationResultHeader, recordedHumanMutationResult);
  return new Response(response.body, { status: response.status, headers });
}

async function authorized(request: Request) {
  const identity = await loadHumanIdentityRequestContext(request.headers);
  const access = await authorizeAuthenticatedHumanIdentity(identity);
  if (access.state !== "authorized") {
    throw new AccessDeniedError("membership_not_active");
  }
  return { identity, access };
}

export async function GET(request: Request) {
  try {
    const { access } = await authorized(request);
    const url = new URL(request.url);
    const workspaceParameter = url.searchParams.get("workspaceId");
    const publicationParameter = url.searchParams.get("publicationId");
    if (workspaceParameter === null) {
      return Response.json({ error: "invalid_query" }, { status: 400 });
    }
    const workspaceId = createContentWorkspaceId(workspaceParameter);
    const actorId = createContentActorId(access.membership.id);
    const application = await loadContentPublicationApplication(
      workspaceId,
      actorId,
    );
    let publication;
    if (publicationParameter !== null) {
      publication = await application.commands.refresh(
        createContentPublicationId(publicationParameter),
      );
    } else {
      publication = await application.queries.getLatest(workspaceId);
      if (
        publication !== null &&
        !["verified-live", "blocked", "failed"].includes(publication.status)
      ) {
        publication = await application.commands.refresh(publication.id);
      }
    }
    return Response.json(
      { publication },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    const domain = domainErrorResponse(error);
    if (domain !== null) {
      return domain;
    }
    if (error instanceof TypeError) {
      return Response.json({ error: "invalid_query" }, { status: 400 });
    }
    if (
      error instanceof AccessDeniedError ||
      error instanceof AccessIdentityError ||
      error instanceof HumanRequestIntegrityError
    ) {
      return Response.json({ error: "request_check_failed" }, { status: 403 });
    }
    if (
      error instanceof AccessIdentityUnavailableError ||
      error instanceof HumanAccessConfigurationError ||
      error instanceof ContentRevisionConfigurationError ||
      error instanceof GitHubContentPublisherConfigurationError
    ) {
      return Response.json(
        { error: "request_check_unavailable" },
        { status: 503 },
      );
    }
    throw error;
  }
}

export async function POST(request: Request) {
  try {
    const identity = await loadHumanIdentityRequestContext(request.headers);
    await verifyHumanMutation(request, identity.identity);
    const command = readCommand(await request.json().catch(() => null));
    if (command === null) {
      return Response.json({ error: "invalid_command" }, { status: 400 });
    }
    let workspaceId;
    try {
      workspaceId = createContentWorkspaceId(command.workspaceId);
      if (command.operation === "publish") {
        createContentApprovalId(command.approvalId);
      }
    } catch {
      return Response.json({ error: "invalid_command" }, { status: 400 });
    }
    const response = await executeIdempotentHumanMutation({
      request,
      identity: identity.identity,
      command,
      execute: async () => {
        let access;
        let application;
        try {
          access = await authorizeAuthenticatedHumanIdentity(identity);
          if (access.state !== "authorized") {
            return Response.json(
              { error: "not_authorized" },
              { status: 403 },
            );
          }
          application = await loadContentPublicationApplication(
            workspaceId,
            createContentActorId(access.membership.id),
          );
        } catch (error) {
          throw new HumanMutationExecutionNotStartedError(error);
        }
        try {
          if (command.operation === "approve") {
            const approval = await application.commands.approve({
              workspaceId,
              revision: command.revision,
              approvedBy: access.membership.id,
              previewConfirmed: command.previewConfirmed,
            });
            return Response.json({ approval }, { status: 201 });
          }
          const publication = await application.commands.publish({
            approvalId: createContentApprovalId(command.approvalId),
            requestedBy: access.membership.id,
            idempotencyKey: request.headers.get("idempotency-key") ?? "",
          });
          return Response.json({ publication }, { status: 202 });
        } catch (error) {
          const domain = domainErrorResponse(error);
          if (domain !== null) {
            return domain;
          }
          throw error;
        }
      },
    });
    return recorded(response);
  } catch (error) {
    if (
      error instanceof AccessDeniedError ||
      error instanceof AccessIdentityError ||
      error instanceof HumanRequestIntegrityError
    ) {
      return Response.json({ error: "request_check_failed" }, { status: 403 });
    }
    if (
      error instanceof AccessIdentityUnavailableError ||
      error instanceof HumanAccessConfigurationError ||
      error instanceof ContentRevisionConfigurationError ||
      error instanceof GitHubContentPublisherConfigurationError
    ) {
      return Response.json(
        { error: "request_check_unavailable" },
        { status: 503 },
      );
    }
    if (error instanceof HumanMutationIdempotencyError) {
      return Response.json(
        {
          error:
            error.code === "invalid_key"
              ? "invalid_idempotency_key"
              : error.code === "key_conflict"
                ? "idempotency_key_conflict"
                : "request_in_progress",
        },
        { status: error.code === "invalid_key" ? 400 : 409 },
      );
    }
    throw error;
  }
}
