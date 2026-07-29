import {
  AccessDeniedError,
  CampaignConflictError,
  CampaignIdempotencyError,
  CampaignNotFoundError,
  CampaignValidationError,
  createCampaignId,
  isCampaignRequestId,
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
    }>;

const maximumCampaignCommandBytes = 256 * 1024;

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
    return "campaignId" in value &&
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
    return Response.json({ rendered, testEvidence }, {
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
    if (parsed === null) {
      await context.application.commands.recordRejectedCommand({
        actor: context.identity,
        requestId,
        reason: "campaign_command_invalid",
        command: rawCommand ?? { invalidJson: body.receiptInput },
      });
      return Response.json(
        { error: "campaign_command_invalid" },
        { status: 400 },
      );
    }
    let editedCampaignId;
    if (parsed.action === "edit" || parsed.action === "request_test") {
      try {
        editedCampaignId = createCampaignId(parsed.campaignId);
      } catch {
        await context.application.commands.recordRejectedCommand({
          actor: context.identity,
          requestId,
          action:
            parsed.action === "edit"
              ? "campaign.edit"
              : "campaign.test",
          targetId: parsed.campaignId,
          reason: "campaign_id_invalid",
          beforeState: JSON.stringify({
            current: { campaignId: "invalid" },
            required: { campaignId: "valid_uuid" },
          }),
          command: rawCommand,
          commandName:
            parsed.action === "edit"
              ? "campaign.edit"
              : "campaign.request_test",
        });
        return Response.json(
          { error: "campaign_id_invalid" },
          { status: 400 },
        );
      }
    }
    const result = parsed.action === "request_test"
      ? await context.testDelivery.commands.requestTest({
          actor: context.identity,
          requestId,
          campaignId: editedCampaignId!,
          testRecipientIds: parsed.testRecipientIds,
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
        ("replayed" in result && result.replayed)
          ? 200
          : 201,
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    if (error instanceof AccessDeniedError) {
      return Response.json({ error: "not_authorized" }, { status: 403 });
    }
    if (error instanceof CampaignValidationError) {
      const isTestDeliveryReason =
        error.message === "provider_unhealthy" ||
        error.message === "test_recipient_forbidden" ||
        error.message.startsWith("provider_test_") ||
        error.message.startsWith("provider_configuration_");
      return Response.json(
        {
          error: isTestDeliveryReason
            ? error.message
            : "campaign_command_invalid",
        },
        {
          status: error.message === "provider_unhealthy" ? 503 : 400,
        },
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
