import {
  AccessDeniedError,
  createPublicFormDeliveryId,
  createPublicFormReceiptId,
} from "@foundry/application";

import {
  authorizeAuthenticatedHumanIdentity,
  loadHumanIdentityRequestContext,
} from "../../../../src/human-access-runtime";
import {
  AccessIdentityError,
  AccessIdentityUnavailableError,
} from "../../../../src/access-identity";
import { HumanAccessConfigurationError } from "../../../../src/human-access-configuration";
import { HumanRequestIntegrityError } from "../../../../src/human-request-integrity";
import { createPublicFormOperationsContext } from "../../../../src/public-form-delivery-health-runtime";
import {
  executeIdempotentHumanMutation,
  HumanMutationIdempotencyError,
  verifyHumanMutation,
} from "../../../../src/human-mutation-runtime";
import {
  humanMutationResultHeader,
  recordedHumanMutationResult,
} from "../../../../src/human-mutation-protocol";

type FormOperation =
  | Readonly<{ action: "replay_delivery"; deliveryId: string }>
  | Readonly<{ action: "release_spam"; receiptId: string }>;

function isFormOperation(value: unknown): value is FormOperation {
  if (typeof value !== "object" || value === null || !("action" in value)) {
    return false;
  }
  return (
    (value.action === "replay_delivery" &&
      "deliveryId" in value &&
      typeof value.deliveryId === "string") ||
    (value.action === "release_spam" &&
      "receiptId" in value &&
      typeof value.receiptId === "string")
  );
}

function recorded(response: Response) {
  const headers = new Headers(response.headers);
  headers.set(humanMutationResultHeader, recordedHumanMutationResult);
  return new Response(response.body, { status: response.status, headers });
}

export async function POST(request: Request) {
  try {
    const identityContext =
      await loadHumanIdentityRequestContext(request.headers);
    await verifyHumanMutation(request, identityContext.identity);
    const command: unknown = await request.json().catch(() => null);
    if (!isFormOperation(command)) {
      return Response.json({ error: "invalid_command" }, { status: 400 });
    }
    const response = await executeIdempotentHumanMutation({
      request,
      identity: identityContext.identity,
      command,
      execute: async () => {
        const humanContext =
          await authorizeAuthenticatedHumanIdentity(identityContext);
        if (humanContext.state !== "authorized") {
          return Response.json({ error: "not_authorized" }, { status: 403 });
        }
        const application =
          await createPublicFormOperationsContext(humanContext);
        if (command.action === "replay_delivery") {
          await application.commands.replayFailed({
            actor: humanContext.identity,
            deliveryId: createPublicFormDeliveryId(command.deliveryId),
          });
        } else {
          await application.commands.releaseSuspectedSpam({
            actor: humanContext.identity,
            receiptId: createPublicFormReceiptId(command.receiptId),
          });
        }
        return Response.json({ applied: true });
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
      error instanceof HumanAccessConfigurationError
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
