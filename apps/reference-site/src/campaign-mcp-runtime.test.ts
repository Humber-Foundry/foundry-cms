import { describe, expect, it } from "vitest";

import {
  AccessDeniedError,
  campaignAudienceDefinition,
  createInMemoryCampaignStore,
} from "@foundry/application";
import {
  createRichTextDocumentFromPlainText,
  createSiteId,
} from "@foundry/site-definition";

import { createCampaignMcpRuntime } from "./campaign-mcp-runtime";

describe("campaign MCP runtime", () => {
  it("requires the exact site connection and content.draft grant", async () => {
    const siteId = createSiteId("site_reference");
    const actor = { type: "mcp" as const, connectionId: "mcp-1", siteId };
    const application = createCampaignMcpRuntime({
      actor,
      scopes: new Set(["content.draft"]),
      store: createInMemoryCampaignStore(),
      findPostRevision: async () => null,
      resolveAudience: async () => ({ eligibleSubscriberCount: 0 }),
      rendererCommit: "1111111111111111111111111111111111111111",
    });
    const input = {
      subject: "Scoped draft",
      previewText: "Scoped preview.",
      callToAction: { label: "Read", href: "https://example.com" },
      emailContent: createRichTextDocumentFromPlainText("Scoped body."),
      senderIdentityId: "sender_primary",
      complianceFooter: {
        version: "footer-v1",
        content: "Contact: hello@example.com. Unsubscribe: https://example.com/u",
      },
      audienceDefinition: campaignAudienceDefinition,
    };

    await expect(
      application.commands.createStandalone({ actor, input }),
    ).resolves.toMatchObject({ campaign: { siteId } });
    await expect(
      application.commands.createStandalone({
        actor: { ...actor, siteId: createSiteId("site_other") },
        input,
      }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
  });
});
