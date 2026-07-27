import {
  AccessDeniedError,
  PublicFormPrivacyError,
  createPublicFormDeliveryId,
  createPublicFormReceiptId,
  type ExportedPublicFormSubmission,
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
import { createPublicFormPrivacyContext } from "../../../../src/public-form-privacy-dashboard-runtime";
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

type FormOperationRecord = Record<string, unknown> & { action: string };
type ReplayDeliveryCommand = FormOperationRecord & {
  action: "replay_delivery";
  deliveryId: string;
};
type ReleaseSpamCommand = FormOperationRecord & {
  action: "release_spam";
  receiptId: string;
};
type ClassifySubmissionCommand = FormOperationRecord & {
  action: "classify_submission";
  receiptId: string;
  classification: "accepted" | "suspected_spam";
};
type EraseSubmissionCommand = FormOperationRecord & {
  action: "erase_submission";
  receiptId: string;
};
type ExportSubmissionCommand = FormOperationRecord & {
  action: "export_submission";
  receiptId: string;
};
type AuthorizedHumanContext = Extract<
  Awaited<ReturnType<typeof authorizeAuthenticatedHumanIdentity>>,
  { state: "authorized" }
>;
type FormOperationExecutionContext = Readonly<{
  human: AuthorizedHumanContext;
  operations(): ReturnType<typeof createPublicFormOperationsContext>;
  privacy(): ReturnType<typeof createPublicFormPrivacyContext>;
}>;

function hasString(command: FormOperationRecord, field: string) {
  return typeof command[field] === "string" && command[field] !== "";
}

function defineFormOperation<Command extends FormOperationRecord>(
  valid: (command: FormOperationRecord) => command is Command,
  execute: (
    command: Command,
    context: FormOperationExecutionContext,
  ) => Promise<void>,
) {
  return {
    resolve(command: FormOperationRecord) {
      return valid(command)
        ? (context: FormOperationExecutionContext) =>
            execute(command, context)
        : null;
    },
  };
}

const formOperationHandlers = {
  replay_delivery: defineFormOperation(
    (command): command is ReplayDeliveryCommand =>
      command.action === "replay_delivery" &&
      hasString(command, "deliveryId"),
    async (
      command,
      context: FormOperationExecutionContext,
    ) => {
      await (await context.operations()).commands.replayFailed({
        actor: context.human.identity,
        deliveryId: createPublicFormDeliveryId(command.deliveryId),
      });
    },
  ),
  release_spam: defineFormOperation(
    (command): command is ReleaseSpamCommand =>
      command.action === "release_spam" &&
      hasString(command, "receiptId"),
    async (
      command,
      context: FormOperationExecutionContext,
    ) => {
      await (await context.operations()).commands.releaseSuspectedSpam({
        actor: context.human.identity,
        receiptId: createPublicFormReceiptId(command.receiptId),
      });
    },
  ),
  classify_submission: defineFormOperation(
    (command): command is ClassifySubmissionCommand =>
      command.action === "classify_submission" &&
      hasString(command, "receiptId") &&
      (command.classification === "accepted" ||
        command.classification === "suspected_spam"),
    async (
      command,
      context: FormOperationExecutionContext,
    ) => {
      await (await context.privacy()).commands.classifySubmission({
        actor: context.human.identity,
        receiptId: createPublicFormReceiptId(command.receiptId),
        classification: command.classification,
      });
    },
  ),
  erase_submission: defineFormOperation(
    (command): command is EraseSubmissionCommand =>
      command.action === "erase_submission" &&
      hasString(command, "receiptId"),
    async (
      command,
      context: FormOperationExecutionContext,
    ) => {
      await (await context.privacy()).commands.eraseSubmission({
        actor: context.human.identity,
        receiptId: createPublicFormReceiptId(command.receiptId),
      });
    },
  ),
} as const;

function readFormOperation(value: unknown) {
  if (
    typeof value !== "object" ||
    value === null ||
    !("action" in value) ||
    typeof value.action !== "string" ||
    !Object.hasOwn(formOperationHandlers, value.action)
  ) {
    return null;
  }
  const command = value as FormOperationRecord;
  const definition =
    formOperationHandlers[
      command.action as keyof typeof formOperationHandlers
    ];
  const execute = definition.resolve(command);
  return execute === null ? null : { command, execute };
}

function readExportSubmission(value: unknown): ExportSubmissionCommand | null {
  if (
    typeof value !== "object" ||
    value === null ||
    !("action" in value) ||
    value.action !== "export_submission" ||
    !("receiptId" in value) ||
    typeof value.receiptId !== "string" ||
    value.receiptId === ""
  ) {
    return null;
  }
  return value as ExportSubmissionCommand;
}

function exportAttachment(
  receiptId: string,
  exported: ExportedPublicFormSubmission,
) {
  return new Response(JSON.stringify(exported, null, 2), {
    headers: {
      "cache-control": "private, no-store",
      "content-disposition": `attachment; filename="form-${encodeURIComponent(receiptId)}.json"`,
      "content-type": "application/json; charset=utf-8",
    },
  });
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
    const commandValue = await request.json().catch(() => null);
    const exportCommand = readExportSubmission(commandValue);
    if (exportCommand !== null) {
      const humanContext =
        await authorizeAuthenticatedHumanIdentity(identityContext);
      if (humanContext.state !== "authorized") {
        return Response.json({ error: "not_authorized" }, { status: 403 });
      }
      const privacy = await createPublicFormPrivacyContext(humanContext);
      const exported = await privacy.queries.exportSubmission({
        actor: humanContext.identity,
        receiptId: createPublicFormReceiptId(exportCommand.receiptId),
      });
      return exportAttachment(exportCommand.receiptId, exported);
    }
    const parsed = readFormOperation(commandValue);
    if (parsed === null) {
      return Response.json({ error: "invalid_command" }, { status: 400 });
    }
    const { command, execute } = parsed;
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
        let operations:
          | Awaited<ReturnType<typeof createPublicFormOperationsContext>>
          | undefined;
        let privacy:
          | Awaited<ReturnType<typeof createPublicFormPrivacyContext>>
          | undefined;
        const load = async <T>(create: () => Promise<T>) => {
          try {
            return await create();
          } catch (error) {
            throw new HumanMutationExecutionNotStartedError(error);
          }
        };
        try {
          await execute({
            human: humanContext,
            operations: async () =>
              (operations ??= await load(() =>
                createPublicFormOperationsContext(humanContext),
              )),
            privacy: async () =>
              (privacy ??= await load(() =>
                createPublicFormPrivacyContext(humanContext),
              )),
          });
        } catch (error) {
          if (error instanceof AccessDeniedError) {
            return Response.json({ error: "not_authorized" }, { status: 403 });
          }
          if (
            (error instanceof Error &&
              (error.message === "form_delivery_not_replayable" ||
                error.message === "form_submission_not_held")) ||
            (error instanceof PublicFormPrivacyError &&
              error.code === "operation_not_available")
          ) {
            return Response.json(
              { error: "form_operation_not_available" },
              { status: 409 },
            );
          }
          throw error;
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
    if (error instanceof PublicFormPrivacyError) {
      if (error.code === "submission_not_found") {
        return Response.json({ error: "not_found" }, { status: 404 });
      }
    }
    throw error;
  }
}
