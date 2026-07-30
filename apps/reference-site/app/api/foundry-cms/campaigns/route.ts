import {
  AccessDeniedError,
  CampaignBulkDeliveryError,
  CampaignConflictError,
  CampaignIdempotencyError,
  CampaignNotFoundError,
  CampaignValidationError,
  createCampaignId,
  isCampaignRequestId,
  type CampaignActor,
  type CampaignBulkDeliveryApplication,
  type CampaignCommandName,
  type CampaignEditableInput,
} from "@foundry/application";

import { loadCampaignRequestContext } from "../../../../src/campaign-runtime";
import { verifyHumanMutation } from "../../../../src/human-mutation-runtime";

type CampaignCommand =
  | Readonly<{
      action: "create_standalone";
      input: CampaignEditableInput;
    }>
  | Readonly<{
      action: "create_from_post";
      sourcePostRevisionId: string;
    }>
  | Readonly<{
      action: "edit";
      campaignId: string;
      expectedVersion: number;
      input: CampaignEditableInput;
    }>
  | Readonly<{
      action: "request_test";
      campaignId: string;
      testRecipientIds: ReadonlyArray<string>;
    }>
  | Readonly<{
      action: "confirm_test_receipt";
      executionId: string;
    }>
  | Readonly<{
      action: "authorize_bulk";
      campaignId: string;
      testExecutionId: string;
    }>
  | Readonly<{
      action: "activate_bulk_schedule";
      campaignId: string;
      authorizationId: string;
      resolvedTime: Readonly<{
        localDateTime: string;
        ianaTimeZone: string;
        utcOffsetChoice: string;
        executeAtUtc: string;
        timeZoneDatabaseVersion: string;
      }>;
    }>
  | Readonly<{
      action: "cancel_bulk_schedule";
      scheduleId: string;
    }>
  | Readonly<{
      action: "send_bulk_now";
      campaignId: string;
      authorizationId: string;
    }>
  | Readonly<{
      action: "retry_bulk_send";
      campaignId: string;
      operationId: string;
    }>;

const maximumCampaignCommandBytes = 256 * 1024;

const bulkActions = Object.freeze([
  "authorize_bulk",
  "activate_bulk_schedule",
  "cancel_bulk_schedule",
  "send_bulk_now",
  "retry_bulk_send",
] as const) satisfies ReadonlyArray<CampaignCommand["action"]>;

/**
 * A rejected bulk command answers whether durable state moved under the caller
 * (409) or the request itself cannot be satisfied yet (400). The set is
 * enumerated rather than matched on how a code happens to be spelled, so a new
 * reason is reported as an unmet precondition until it is listed here
 * deliberately.
 */
const bulkConflictReasons: ReadonlySet<string> = new Set([
  "bulk_authorization_stale",
  "bulk_authorization_exists",
  "bulk_test_stale",
  "bulk_send_already_exists",
  "bulk_schedule_already_exists",
  "bulk_schedule_state_changed",
  "bulk_send_state_changed",
  "bulk_idempotency_key_reused",
  "bulk_suppression_changed",
  "bulk_schedule_not_cancellable",
  "bulk_execution_lease_lost",
  "bulk_provider_correlation_conflict",
  "bulk_delivery_event_identity_conflict",
]);

function bulkRejectionStatus(code: string) {
  return bulkConflictReasons.has(code) ? 409 : 400;
}

type BulkAction = (typeof bulkActions)[number];
type BulkCommand = Extract<CampaignCommand, { action: BulkAction }>;

function isBulkCommand(command: CampaignCommand): command is BulkCommand {
  return (bulkActions as ReadonlyArray<string>).includes(command.action);
}

/**
 * Every bulk command except schedule cancellation names its campaign, and the
 * caller validated it before dispatch. This turns that fact into a check rather
 * than an assertion so a future action cannot dispatch without one.
 */
function requireCampaignId(
  campaignId: ReturnType<typeof createCampaignId> | undefined,
) {
  if (campaignId === undefined) {
    throw new CampaignValidationError("campaign_id_invalid");
  }
  return campaignId;
}

/**
 * Dispatch one Owner bulk command. `send_bulk_now` and `retry_bulk_send` both
 * end in the same shared executor, so an immediate send and a retry of a
 * failed send follow exactly one execution path.
 */
async function runBulkCommand({
  bulkDelivery,
  actor,
  requestId,
  campaignId,
  command,
}: {
  bulkDelivery: CampaignBulkDeliveryApplication;
  actor: CampaignActor;
  requestId: string;
  campaignId: ReturnType<typeof createCampaignId> | undefined;
  command: BulkCommand;
}) {
  switch (command.action) {
    case "authorize_bulk":
      return bulkDelivery.commands.authorize({
        actor,
        requestId,
        campaignId: requireCampaignId(campaignId),
        testExecutionId: command.testExecutionId,
      });
    case "activate_bulk_schedule":
      return bulkDelivery.commands.activateSchedule({
        actor,
        requestId,
        campaignId: requireCampaignId(campaignId),
        authorizationId: command.authorizationId,
        resolvedTime: command.resolvedTime,
      });
    case "cancel_bulk_schedule":
      return bulkDelivery.commands.cancelSchedule({
        actor,
        requestId,
        scheduleId: command.scheduleId,
      });
    case "retry_bulk_send":
      return bulkDelivery.commands.retrySend({
        actor,
        requestId,
        campaignId: requireCampaignId(campaignId),
        operationId: command.operationId,
      });
    case "send_bulk_now": {
      const requested = await bulkDelivery.commands.sendNow({
        actor,
        requestId,
        campaignId: requireCampaignId(campaignId),
        authorizationId: command.authorizationId,
      });
      return {
        ...requested,
        operation: await bulkDelivery.scheduler.execute(requested.operation.id),
      };
    }
    default:
      // A new bulk action must choose its dispatch here rather than inherit
      // another action's behaviour.
      return command satisfies never;
  }
}

class CampaignCommandBodyError extends Error {
  constructor(readonly code: "campaign_command_invalid" | "campaign_command_too_large") {
    super(code);
    this.name = "CampaignCommandBodyError";
  }
}

async function readCampaignCommandBody(request: Request) {
  const declaredLength = Number(request.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > maximumCampaignCommandBytes
  ) {
    throw new CampaignCommandBodyError("campaign_command_too_large");
  }
  if (request.body === null) {
    return Object.freeze({ value: null, receiptInput: "" });
  }
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    bytes += result.value.byteLength;
    if (bytes > maximumCampaignCommandBytes) {
      await reader.cancel();
      throw new CampaignCommandBodyError("campaign_command_too_large");
    }
    text += decoder.decode(result.value, { stream: true });
  }
  text += decoder.decode();
  try {
    return Object.freeze({
      value: JSON.parse(text) as unknown,
      receiptInput: text,
    });
  } catch {
    return Object.freeze({ value: null, receiptInput: text });
  }
}

function command(value: unknown): CampaignCommand | null {
  if (typeof value !== "object" || value === null || !("action" in value)) {
    return null;
  }
  if (value.action === "create_from_post") {
    return "sourcePostRevisionId" in value &&
      typeof value.sourcePostRevisionId === "string"
      ? {
          action: value.action,
          sourcePostRevisionId: value.sourcePostRevisionId,
        }
      : null;
  }
  if (value.action === "request_test") {
    return Object.keys(value).length === 3 &&
      Object.keys(value).every((key) =>
        key === "action" ||
        key === "campaignId" ||
        key === "testRecipientIds"
      ) &&
      "campaignId" in value &&
      typeof value.campaignId === "string" &&
      "testRecipientIds" in value &&
      Array.isArray(value.testRecipientIds) &&
      value.testRecipientIds.every(
        (recipientId) => typeof recipientId === "string",
      )
      ? {
          action: value.action,
          campaignId: value.campaignId,
          testRecipientIds: value.testRecipientIds,
        }
      : null;
  }
  if (value.action === "confirm_test_receipt") {
    return Object.keys(value).length === 2 &&
      Object.keys(value).every(
        (key) => key === "action" || key === "executionId",
      ) &&
      "executionId" in value &&
      typeof value.executionId === "string"
      ? {
          action: value.action,
          executionId: value.executionId,
        }
      : null;
  }
  if (value.action === "authorize_bulk") {
    return Object.keys(value).length === 3 &&
      "campaignId" in value &&
      typeof value.campaignId === "string" &&
      "testExecutionId" in value &&
      typeof value.testExecutionId === "string"
      ? {
          action: value.action,
          campaignId: value.campaignId,
          testExecutionId: value.testExecutionId,
        }
      : null;
  }
  if (
    value.action === "activate_bulk_schedule" &&
    Object.keys(value).length === 4 &&
    "campaignId" in value &&
    typeof value.campaignId === "string" &&
    "authorizationId" in value &&
    typeof value.authorizationId === "string" &&
    "resolvedTime" in value &&
    typeof value.resolvedTime === "object" &&
    value.resolvedTime !== null
  ) {
    const resolved = value.resolvedTime as Record<string, unknown>;
    return Object.keys(resolved).length === 5 &&
      [
        "localDateTime",
        "ianaTimeZone",
        "utcOffsetChoice",
        "executeAtUtc",
        "timeZoneDatabaseVersion",
      ].every((key) => typeof resolved[key] === "string")
      ? {
          action: value.action,
          campaignId: value.campaignId,
          authorizationId: value.authorizationId,
          resolvedTime: {
            localDateTime: resolved.localDateTime as string,
            ianaTimeZone: resolved.ianaTimeZone as string,
            utcOffsetChoice: resolved.utcOffsetChoice as string,
            executeAtUtc: resolved.executeAtUtc as string,
            timeZoneDatabaseVersion:
              resolved.timeZoneDatabaseVersion as string,
          },
        }
      : null;
  }
  if (value.action === "cancel_bulk_schedule") {
    return Object.keys(value).length === 2 &&
      "scheduleId" in value &&
      typeof value.scheduleId === "string"
      ? { action: value.action, scheduleId: value.scheduleId }
      : null;
  }
  if (value.action === "send_bulk_now") {
    return Object.keys(value).length === 3 &&
      "campaignId" in value &&
      typeof value.campaignId === "string" &&
      "authorizationId" in value &&
      typeof value.authorizationId === "string"
      ? {
          action: value.action,
          campaignId: value.campaignId,
          authorizationId: value.authorizationId,
        }
      : null;
  }
  if (value.action === "retry_bulk_send") {
    return Object.keys(value).length === 3 &&
      "campaignId" in value &&
      typeof value.campaignId === "string" &&
      "operationId" in value &&
      typeof value.operationId === "string"
      ? {
          action: value.action,
          campaignId: value.campaignId,
          operationId: value.operationId,
        }
      : null;
  }
  if (
    (value.action !== "create_standalone" && value.action !== "edit") ||
    !("input" in value) ||
    typeof value.input !== "object" ||
    value.input === null
  ) {
    return null;
  }
  const editable = value.input as Record<string, unknown>;
  const input = {
    subject: editable.subject,
    previewText: editable.previewText,
    callToAction: editable.callToAction,
    emailContent: editable.emailContent,
  } as CampaignEditableInput;
  if (value.action === "create_standalone") {
    return { action: value.action, input };
  }
  return "campaignId" in value &&
    typeof value.campaignId === "string" &&
    "expectedVersion" in value &&
    typeof value.expectedVersion === "number"
    ? {
        action: value.action,
        campaignId: value.campaignId,
        expectedVersion: value.expectedVersion,
        input,
      }
    : null;
}

export async function GET(request: Request) {
  try {
    const context = await loadCampaignRequestContext(request.headers);
    const campaignIdValue =
      new URL(request.url).searchParams.get("campaignId");
    if (campaignIdValue === null) {
      const campaigns = await context.application.queries.listCampaigns({
        actor: context.identity,
      });
      return Response.json(
        { campaigns },
        { headers: { "cache-control": "private, no-store" } },
      );
    }
    const campaignId = createCampaignId(campaignIdValue);
    const rendered = await context.application.queries.render({
      actor: context.identity,
      campaignId,
    });
    const testEvidence =
      await context.testDelivery.queries.currentEvidence({
        actor: context.identity,
        campaignId,
      });
    const testReadiness = await context.testDelivery.queries.readiness({
      actor: context.identity,
      campaignId,
    });
    return Response.json({ rendered, testEvidence, testReadiness }, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    if (
      error instanceof AccessDeniedError ||
      error instanceof CampaignNotFoundError
    ) {
      return Response.json({ error: "not_authorized_or_found" }, { status: 404 });
    }
    if (error instanceof TypeError) {
      return Response.json({ error: "campaign_id_invalid" }, { status: 400 });
    }
    if (
      error instanceof CampaignValidationError &&
      error.message === "campaign_renderer_mismatch"
    ) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
}

export async function POST(request: Request) {
  let rawAction: string | undefined;
  try {
    const context = await loadCampaignRequestContext(request.headers);
    await verifyHumanMutation(request, context.identity);
    const requestId = request.headers.get("idempotency-key") ?? "";
    if (!isCampaignRequestId(requestId)) {
      await context.application.commands.recordRejectedCommand({
        actor: context.identity,
        requestId,
        reason: "campaign_idempotency_key_invalid",
        command: { kind: "campaign_request_envelope" },
      });
      return Response.json(
        { error: "campaign_idempotency_key_invalid" },
        { status: 400 },
      );
    }
    let body;
    try {
      body = await readCampaignCommandBody(request);
    } catch (error) {
      if (!(error instanceof CampaignCommandBodyError)) throw error;
      await context.application.commands.recordRejectedCommand({
        actor: context.identity,
        requestId,
        reason: error.code,
        command: { kind: error.code },
      });
      return Response.json(
        { error: error.code },
        {
          status:
            error.code === "campaign_command_too_large" ? 413 : 400,
        },
      );
    }
    const rawCommand = body.value;
    const parsed = command(rawCommand);
    rawAction = parsed?.action;
    if (parsed === null) {
      const rawRecord =
        typeof rawCommand === "object" && rawCommand !== null
          ? rawCommand as Record<string, unknown>
          : null;
      const malformedTest =
        rawRecord !== null &&
        (rawRecord.action === "request_test" ||
          rawRecord.action === "confirm_test_receipt");
      const malformedConfirmation =
        malformedTest &&
        rawRecord!.action === "confirm_test_receipt";
      const malformedTarget =
        malformedTest &&
        (malformedConfirmation
          ? typeof rawRecord!.executionId === "string"
          : typeof rawRecord!.campaignId === "string")
          ? malformedConfirmation
            ? rawRecord!.executionId as string
            : rawRecord!.campaignId as string
          : "campaign:unknown";
      await context.application.commands.recordRejectedCommand({
        actor: context.identity,
        requestId,
        reason: "campaign_command_invalid",
        command: rawCommand ?? { invalidJson: body.receiptInput },
        ...(malformedTest
          ? {
              action: "campaign.test" as const,
              commandName: malformedConfirmation
                ? "campaign.confirm_test_receipt" as const
                : "campaign.request_test" as const,
              targetId: malformedTarget,
              beforeState: JSON.stringify({
                current: { commandEnvelope: "invalid" },
                required: {
                  commandEnvelope: malformedConfirmation
                    ? "valid_confirm_test_receipt"
                    : "valid_request_test",
                },
              }),
            }
          : {}),
      });
      return Response.json(
        { error: "campaign_command_invalid" },
        { status: 400 },
      );
    }
    let editedCampaignId;
    if (
      parsed.action === "edit" ||
      parsed.action === "request_test" ||
      parsed.action === "authorize_bulk" ||
      parsed.action === "activate_bulk_schedule" ||
      parsed.action === "send_bulk_now" ||
      parsed.action === "retry_bulk_send"
    ) {
      try {
        editedCampaignId = createCampaignId(parsed.campaignId);
      } catch {
        await context.application.commands.recordRejectedCommand({
          actor: context.identity,
          requestId,
          action:
            parsed.action === "edit"
              ? "campaign.edit"
              : parsed.action === "request_test"
                ? "campaign.test"
                : "campaign.bulk",
          targetId: parsed.campaignId,
          reason: "campaign_id_invalid",
          beforeState: JSON.stringify({
            current: { campaignId: "invalid" },
            required: { campaignId: "valid_uuid" },
          }),
          command: rawCommand,
          // Every campaign command's audited name is its action, so deriving
          // it keeps a new action from silently inheriting another's name.
          commandName:
            `campaign.${parsed.action}` satisfies CampaignCommandName,
        });
        return Response.json(
          { error: "campaign_id_invalid" },
          { status: 400 },
        );
      }
    }
    const result = isBulkCommand(parsed)
      ? await runBulkCommand({
          bulkDelivery: context.bulkDelivery,
          actor: context.identity,
          requestId,
          campaignId: editedCampaignId,
          command: parsed,
        })
      : parsed.action === "request_test"
      ? await context.testDelivery.commands.requestTest({
          actor: context.identity,
          requestId,
          campaignId: editedCampaignId!,
          testRecipientIds: parsed.testRecipientIds,
        })
      : parsed.action === "confirm_test_receipt"
        ? await context.testDelivery.commands.confirmReceipt({
            actor: context.identity,
            requestId,
            executionId: parsed.executionId,
          })
      : parsed.action === "create_standalone"
      ? await context.application.commands.createStandalone({
          actor: context.identity,
          requestId,
          input: parsed.input,
        })
      : parsed.action === "create_from_post"
        ? await context.application.commands.createFromPost({
            actor: context.identity,
            requestId,
            sourcePostRevisionId: parsed.sourcePostRevisionId,
          })
        : await context.application.commands.edit({
            actor: context.identity,
            requestId,
            campaignId: editedCampaignId!,
            expectedVersion: parsed.expectedVersion,
            input: parsed.input,
          });
    return Response.json(result, {
      status:
        parsed.action === "edit" ||
        parsed.action === "request_test" ||
        parsed.action === "confirm_test_receipt" ||
        ("replayed" in result && result.replayed)
          ? 200
          : 201,
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    if (error instanceof AccessDeniedError) {
      // Only an Owner may originate bulk authority, so naming that requirement
      // tells an Editor or agent what is missing rather than only that it was
      // refused.
      return Response.json(
        {
          error: (bulkActions as ReadonlyArray<string>).includes(
            rawAction ?? "",
          )
            ? "bulk_owner_required"
            : "not_authorized",
        },
        { status: 403 },
      );
    }
    if (error instanceof CampaignValidationError) {
      const isTestDeliveryReason =
        error.message === "provider_unhealthy" ||
        error.message === "test_recipient_forbidden" ||
        error.message.startsWith("test_delivery_") ||
        error.message.startsWith("test_confirmation_") ||
        error.message.startsWith("test_receipt_") ||
        error.message.startsWith("test_execution_") ||
        error.message.startsWith("provider_test_") ||
        error.message.startsWith("provider_configuration_");
      return Response.json(
        {
          error: isTestDeliveryReason
            ? error.message
            : "campaign_command_invalid",
        },
        {
          status:
            error.message === "provider_unhealthy"
              ? 503
              : error.message === "test_delivery_rate_limited"
                ? 429
                : error.message === "test_delivery_in_progress"
                  ? 409
                  : 400,
        },
      );
    }
    if (error instanceof CampaignBulkDeliveryError) {
      return Response.json(
        { error: error.code },
        { status: bulkRejectionStatus(error.code) },
      );
    }
    if (error instanceof TypeError) {
      return Response.json({ error: "campaign_command_invalid" }, { status: 400 });
    }
    if (error instanceof CampaignConflictError) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof CampaignIdempotencyError) {
      return Response.json(
        { error: error.message },
        {
          status:
            error.code === "campaign_idempotency_key_invalid" ? 400 : 409,
        },
      );
    }
    if (error instanceof CampaignNotFoundError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    throw error;
  }
}
