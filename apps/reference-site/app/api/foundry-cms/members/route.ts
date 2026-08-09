import {
  AccessDeniedError,
  createHumanMembershipId,
  EligibilitySyncConvergenceError,
  InvalidHumanEmailError,
  isMembershipStatus,
  LastOwnerError,
} from "@humber-foundry/application";

import {
  AccessIdentityError,
  AccessIdentityUnavailableError,
} from "../../../../src/access-identity";
import { AccessEligibilitySyncError } from "../../../../src/cloudflare-access-eligibility";
import {
  authorizeAuthenticatedHumanIdentity,
  loadHumanIdentityRequestContext,
} from "../../../../src/human-access-runtime";
import { HumanAccessConfigurationError } from "../../../../src/human-access-configuration";
import {
  executeIdempotentHumanMutation,
  HumanMutationExecutionNotStartedError,
  HumanMutationIdempotencyError,
  verifyHumanMutation,
} from "../../../../src/human-mutation-runtime";
import { HumanRequestIntegrityError } from "../../../../src/human-request-integrity";
import {
  humanMutationResultHeader,
  recordedHumanMutationResult,
} from "../../../../src/human-mutation-protocol";

type MemberCommand =
  | Readonly<{ action: "claim_invitation" }>
  | Readonly<{ action: "reconcile_access" }>
  | Readonly<{ action: "invite"; email: string; role: "owner" | "editor" }>
  | Readonly<{
      action: "change_status";
      membershipId: string;
      status: "active" | "suspended" | "revoked";
    }>;

function isMemberCommand(value: unknown): value is MemberCommand {
  if (typeof value !== "object" || value === null || !("action" in value)) {
    return false;
  }
  if (
    value.action === "claim_invitation" ||
    value.action === "reconcile_access"
  ) {
    return Object.keys(value).length === 1;
  }
  if (value.action === "invite") {
    return (
      "email" in value &&
      typeof value.email === "string" &&
      "role" in value &&
      (value.role === "owner" || value.role === "editor")
    );
  }
  if (value.action === "change_status") {
    return (
      "membershipId" in value &&
      typeof value.membershipId === "string" &&
      "status" in value &&
      isMembershipStatus(value.status)
    );
  }
  return false;
}

function commandErrorResponse(
  error: unknown,
  { commandDispatched = false } = {},
): Response | null {
  if (error instanceof AccessDeniedError) {
    return Response.json({ error: "not_authorized" }, { status: 403 });
  }
  if (error instanceof HumanAccessConfigurationError) {
    if (commandDispatched) {
      return Response.json(
        { error: "access_sync_pending", d1Committed: true },
        { status: 503 },
      );
    }
    return Response.json({ error: "access_unavailable" }, { status: 503 });
  }
  if (
    error instanceof AccessEligibilitySyncError ||
    error instanceof EligibilitySyncConvergenceError
  ) {
    return Response.json(
      { error: "access_sync_pending", d1Committed: true },
      { status: 503 },
    );
  }
  if (error instanceof LastOwnerError) {
    return Response.json({ error: "last_owner" }, { status: 409 });
  }
  if (error instanceof InvalidHumanEmailError) {
    return Response.json({ error: "invalid_command" }, { status: 400 });
  }
  return null;
}

function markRecordedMutation(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set(humanMutationResultHeader, recordedHumanMutationResult);
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

export async function POST(request: Request) {
  try {
    const identityContext =
      await loadHumanIdentityRequestContext(request.headers);
    await verifyHumanMutation(request, identityContext.identity);
    let command: unknown;
    try {
      command = await request.json();
    } catch {
      return Response.json({ error: "invalid_command" }, { status: 400 });
    }
    if (!isMemberCommand(command)) {
      return Response.json({ error: "invalid_command" }, { status: 400 });
    }

    const response = await executeIdempotentHumanMutation({
      request,
      identity: identityContext.identity,
      command,
      execute: async () => {
        let context;
        try {
          context = await authorizeAuthenticatedHumanIdentity(identityContext);
        } catch (error) {
          const response = commandErrorResponse(error);
          if (response !== null) {
            return response;
          }
          throw new HumanMutationExecutionNotStartedError(error);
        }

        try {
          if (command.action === "claim_invitation") {
            const membership =
              await context.application.commands.activateInvitation({
                actor: context.identity,
              });
            return Response.json({ membership }, { status: 201 });
          }

          if (command.action === "reconcile_access") {
            await context.application.commands.reconcileEligibility({
              actor: context.identity,
            });
            return Response.json({ synchronized: true });
          }

          if (command.action === "invite") {
            const invitation = await context.application.commands.invite({
              actor: context.identity,
              email: command.email,
              role: command.role,
            });
            return Response.json({ invitation }, { status: 201 });
          }

          const membershipId = createHumanMembershipId(command.membershipId);
          const membership =
            await context.application.commands.changeStatus({
              actor: context.identity,
              membershipId,
              status: command.status,
            });
          return Response.json({ membership });
        } catch (error) {
          const response = commandErrorResponse(error, {
            commandDispatched: true,
          });
          if (response !== null) {
            return response;
          }
          throw error;
        }
      },
    });
    return markRecordedMutation(response);
  } catch (error) {
    if (
      error instanceof HumanRequestIntegrityError ||
      error instanceof AccessIdentityError
    ) {
      return Response.json(
        { error: "request_check_failed" },
        { status: 403 },
      );
    }
    if (error instanceof AccessDeniedError) {
      return Response.json(
        { error: "request_check_failed" },
        { status: 403 },
      );
    }
    if (
      error instanceof HumanAccessConfigurationError ||
      error instanceof AccessIdentityUnavailableError
    ) {
      return Response.json(
        { error: "request_check_unavailable" },
        { status: 503 },
      );
    }
    if (error instanceof HumanMutationIdempotencyError) {
      if (error.code === "invalid_key") {
        return Response.json(
          { error: "invalid_idempotency_key" },
          { status: 400 },
        );
      }
      return Response.json(
        {
          error:
            error.code === "key_conflict"
              ? "idempotency_key_conflict"
              : "request_in_progress",
        },
        { status: 409 },
      );
    }
    throw error;
  }
}
