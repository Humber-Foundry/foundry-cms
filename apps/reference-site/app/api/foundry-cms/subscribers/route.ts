import {
  AccessDeniedError,
  ErasedSubscriberError,
  InvalidSubscriberEventTimestampError,
  InvalidSubscriberEmailError,
  MissingConsentEvidenceError,
  SubscriberAlreadyExistsError,
  SubscriberNotFoundError,
  type ConsentEvidence,
  type SuppressionReason,
} from "@humber-foundry/application";

import {
  AccessIdentityError,
  AccessIdentityUnavailableError,
} from "../../../../src/access-identity";
import { HumanAccessConfigurationError } from "../../../../src/human-access-configuration";
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
import {
  authorizeSubscriberLedgerIdentity,
  loadHumanIdentityRequestContext,
  loadSubscriberLedgerRequestContext,
} from "../../../../src/subscriber-ledger-runtime";

type SubscriberCommand =
  | Readonly<{
      action: "record_consent";
      email: string;
      evidence: ConsentEvidence;
    }>
  | Readonly<{
      action: "suppress";
      email: string;
      reason: SuppressionReason;
      occurredAt: string;
    }>
  | Readonly<{
      action: "resubscribe";
      email: string;
      evidence: ConsentEvidence;
    }>;

function isConsentEvidence(value: unknown): value is ConsentEvidence {
  return (
    typeof value === "object" &&
    value !== null &&
    "lawfulBasis" in value &&
    (value.lawfulBasis === "express" || value.lawfulBasis === "implied") &&
    "source" in value &&
    (value.source === "public_form" ||
      value.source === "owner_import" ||
      value.source === "provider_import") &&
    "occurredAt" in value &&
    typeof value.occurredAt === "string" &&
    "disclosureVersion" in value &&
    typeof value.disclosureVersion === "string" &&
    "collectionSurface" in value &&
    typeof value.collectionSurface === "string" &&
    "evidenceReference" in value &&
    typeof value.evidenceReference === "string"
  );
}

function isSubscriberCommand(value: unknown): value is SubscriberCommand {
  if (
    typeof value !== "object" ||
    value === null ||
    !("action" in value) ||
    !("email" in value) ||
    typeof value.email !== "string"
  ) {
    return false;
  }
  if (
    value.action === "record_consent" ||
    value.action === "resubscribe"
  ) {
    return "evidence" in value && isConsentEvidence(value.evidence);
  }
  if (value.action === "suppress") {
    return (
      "reason" in value &&
      ["unsubscribed", "complained", "hard_bounced", "erased"].includes(
        value.reason as string,
      ) &&
      "occurredAt" in value &&
      typeof value.occurredAt === "string"
    );
  }
  return false;
}

function subscriberErrorResponse(error: unknown): Response | null {
  if (error instanceof AccessDeniedError) {
    return Response.json({ error: "not_authorized" }, { status: 403 });
  }
  if (
    error instanceof InvalidSubscriberEmailError ||
    error instanceof InvalidSubscriberEventTimestampError ||
    error instanceof MissingConsentEvidenceError
  ) {
    return Response.json({ error: "invalid_command" }, { status: 400 });
  }
  if (error instanceof SubscriberNotFoundError) {
    return Response.json({ error: "subscriber_not_found" }, { status: 404 });
  }
  if (error instanceof SubscriberAlreadyExistsError) {
    return Response.json(
      { error: "subscriber_already_exists" },
      { status: 409 },
    );
  }
  if (error instanceof ErasedSubscriberError) {
    return Response.json(
      { error: "erased_subscriber_cannot_be_reactivated" },
      { status: 409 },
    );
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

export async function GET(request: Request) {
  try {
    const context = await loadSubscriberLedgerRequestContext(
      request.headers,
    );
    const format = new URL(request.url).searchParams.get("format");
    if (format === "ledger") {
      const ledger = await context.application.queries.exportLedger({
        actor: context.identity,
      });
      return Response.json(ledger, {
        headers: {
          "content-disposition":
            'attachment; filename="foundry-subscriber-ledger.json"',
          "cache-control": "private, no-store",
        },
      });
    }
    if (format !== null && format !== "identities") {
      return Response.json({ error: "invalid_format" }, { status: 400 });
    }
    const subscribers =
      await context.application.queries.listIdentities({
        actor: context.identity,
      });
    return Response.json(
      { subscribers },
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    const response = subscriberErrorResponse(error);
    if (response !== null) return response;
    if (error instanceof AccessIdentityError) {
      return Response.json({ error: "not_authorized" }, { status: 403 });
    }
    if (
      error instanceof HumanAccessConfigurationError ||
      error instanceof AccessIdentityUnavailableError
    ) {
      return Response.json({ error: "access_unavailable" }, { status: 503 });
    }
    throw error;
  }
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
    if (!isSubscriberCommand(command)) {
      return Response.json({ error: "invalid_command" }, { status: 400 });
    }

    const response = await executeIdempotentHumanMutation({
      request,
      identity: identityContext.identity,
      command,
      execute: async () => {
        let context;
        try {
          context =
            await authorizeSubscriberLedgerIdentity(identityContext);
        } catch (error) {
          const response = subscriberErrorResponse(error);
          if (response !== null) return response;
          throw new HumanMutationExecutionNotStartedError(error);
        }
        try {
          if (command.action === "record_consent") {
            const subscriber =
              await context.application.commands.recordConsent({
                actor: context.identity,
                email: command.email,
                evidence: command.evidence,
              });
            return Response.json({ subscriber }, { status: 201 });
          }
          if (command.action === "resubscribe") {
            const subscriber =
              await context.application.commands.resubscribe({
                actor: context.identity,
                email: command.email,
                evidence: command.evidence,
              });
            return Response.json({ subscriber });
          }
          const subscriber = await context.application.commands.suppress({
            actor: context.identity,
            email: command.email,
            reason: command.reason,
            occurredAt: command.occurredAt,
          });
          return Response.json({ subscriber });
        } catch (error) {
          const response = subscriberErrorResponse(error);
          if (response !== null) return response;
          throw error;
        }
      },
    });
    return markRecordedMutation(response);
  } catch (error) {
    if (
      error instanceof HumanRequestIntegrityError ||
      error instanceof AccessIdentityError ||
      error instanceof AccessDeniedError
    ) {
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
