import {
  AccessDeniedError,
  CampaignConflictError,
  CampaignNotFoundError,
  CampaignValidationError,
  createCampaignId,
  type CampaignAuthoringInput,
} from "@foundry/application";

import { loadCampaignRequestContext } from "../../../../src/campaign-runtime";
import {
  executeIdempotentHumanMutation,
  verifyHumanMutation,
} from "../../../../src/human-mutation-runtime";

type CampaignCommand =
  | Readonly<{
      action: "create_standalone";
      input: Omit<CampaignAuthoringInput, "complianceFooter">;
    }>
  | Readonly<{
      action: "create_from_post";
      sourcePostRevisionId: string;
      senderIdentityId: string;
      audienceDefinition: CampaignAuthoringInput["audienceDefinition"];
    }>
  | Readonly<{
      action: "edit";
      campaignId: string;
      expectedVersion: number;
      input: Omit<CampaignAuthoringInput, "complianceFooter">;
    }>;

const canonicalComplianceFooter = Object.freeze({
  version: "reference-footer-v1",
  content:
    "Humber Foundry · 123 Harbour Street, Victoria, BC · Contact: mailto:hello@humberfoundry.ca · Unsubscribe: https://foundry.tinyskiff.xyz/newsletter/unsubscribe",
});

function command(value: unknown): CampaignCommand | null {
  if (typeof value !== "object" || value === null || !("action" in value)) {
    return null;
  }
  return value.action === "create_standalone" ||
    value.action === "create_from_post" ||
    value.action === "edit"
    ? (value as CampaignCommand)
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
    throw error;
  }
}

export async function POST(request: Request) {
  try {
    const context = await loadCampaignRequestContext(request.headers);
    await verifyHumanMutation(request, context.identity);
    const parsed = command(await request.json().catch(() => null));
    if (parsed === null) {
      await context.application.commands.recordRejectedCommand({
        actor: context.identity,
        reason: "campaign_command_invalid",
      });
      return Response.json(
        { error: "campaign_command_invalid" },
        { status: 400 },
      );
    }
    return executeIdempotentHumanMutation({
      request,
      identity: context.identity,
      command: parsed,
      execute: async () => {
        const result = parsed.action === "create_standalone"
          ? await context.application.commands.createStandalone({
              actor: context.identity,
              input: {
                ...parsed.input,
                complianceFooter: canonicalComplianceFooter,
              },
            })
          : parsed.action === "create_from_post"
            ? await context.application.commands.createFromPost({
                actor: context.identity,
                sourcePostRevisionId: parsed.sourcePostRevisionId,
                senderIdentityId: parsed.senderIdentityId,
                complianceFooter: canonicalComplianceFooter,
                audienceDefinition: parsed.audienceDefinition,
              })
            : await context.application.commands.edit({
                actor: context.identity,
                campaignId: createCampaignId(parsed.campaignId),
                expectedVersion: parsed.expectedVersion,
                input: {
                  ...parsed.input,
                  complianceFooter: canonicalComplianceFooter,
                },
              });
        return Response.json(result, {
          status: parsed.action === "edit" ? 200 : 201,
          headers: { "cache-control": "private, no-store" },
        });
      },
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
    if (error instanceof CampaignNotFoundError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    throw error;
  }
}
