import {
  AccessDeniedError,
  CampaignConflictError,
  CampaignIdempotencyError,
  CampaignNotFoundError,
  CampaignValidationError,
  createCampaignId,
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
    }>;

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
    return Response.json({ rendered }, {
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
    const rawCommand = await request.json().catch(() => null);
    const parsed = command(rawCommand);
    const requestId = request.headers.get("idempotency-key") ?? "";
    if (parsed === null) {
      await context.application.commands.recordRejectedCommand({
        actor: context.identity,
        requestId,
        reason: "campaign_command_invalid",
      });
      return Response.json(
        { error: "campaign_command_invalid" },
        { status: 400 },
      );
    }
    let editedCampaignId;
    if (parsed.action === "edit") {
      try {
        editedCampaignId = createCampaignId(parsed.campaignId);
      } catch {
        await context.application.commands.recordRejectedCommand({
          actor: context.identity,
          requestId,
          action: "campaign.edit",
          targetId: parsed.campaignId,
          reason: "campaign_id_invalid",
        });
        return Response.json(
          { error: "campaign_command_invalid" },
          { status: 400 },
        );
      }
    }
    const result = parsed.action === "create_standalone"
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
      status: parsed.action === "edit" || result.replayed ? 200 : 201,
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    if (error instanceof AccessDeniedError) {
      return Response.json({ error: "not_authorized" }, { status: 403 });
    }
    if (
      error instanceof CampaignValidationError ||
      error instanceof TypeError
    ) {
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
