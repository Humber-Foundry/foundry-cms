import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createMcpCampaignRuntime } from "./mcp-campaign-runtime";
import { runScheduledCampaignBulkDeliveries } from "./campaign-bulk-scheduler-runtime";

/**
 * The two entry points that serve no screen: the MCP campaign runtime and the
 * scheduled worker.
 *
 * Both must refuse with the same word the Newsletter page and the campaigns
 * API report, so an operator reading a worker log and an Owner reading the
 * dashboard are reading about the same missing settings.
 */

const reason = "campaign_sender_details_not_configured";

/** A database binding that answers every read with nothing. */
const database = {
  prepare: () => ({
    bind: () => ({
      first: async () => null,
      all: async () => ({ results: [] }),
      run: async () => ({}),
    }),
  }),
  batch: async () => [],
} as never;

/**
 * A new installation: the database is there, and every delivery secret is
 * there, so nothing but the sender settings can be the cause of the refusal.
 */
const environmentWithoutSenderSettings = {
  FOUNDRY_DB: database,
  FOUNDRY_PRODUCTION_BASE: "a".repeat(40),
  FOUNDRY_NEWSLETTER_DELIVERY_SECRET: "n".repeat(32),
  FOUNDRY_SUBSCRIBER_IDENTITY_SECRET: "s".repeat(32),
  FOUNDRY_BREVO_API_KEY: "example-api-key",
  FOUNDRY_CAMPAIGN_TEST_PROOF_KEY: "p".repeat(32),
  FOUNDRY_BREVO_WEBHOOK_AUTH_TOKEN: "w".repeat(32),
  FOUNDRY_BREVO_ACCOUNT_SCOPE_FINGERPRINT: "a".repeat(64),
  FOUNDRY_BREVO_SENDERS_JSON: JSON.stringify({
    sender_primary: { id: 1, email: "news@example.test", name: "Example" },
  }),
  FOUNDRY_CAMPAIGN_TEST_RECIPIENTS_JSON: JSON.stringify({
    "membership-owner": "owner@example.test",
  }),
};

const principal = {
  actorId: "connection-1",
  connectionId: "connection-1",
  scopes: ["campaign.write"],
} as never;

describe("the scheduled worker without the sender details", () => {
  it("stops with the named reason rather than claiming work", async () => {
    await expect(
      runScheduledCampaignBulkDeliveries(environmentWithoutSenderSettings),
    ).rejects.toThrow(reason);
  });

  it("still reports the database fault first when there is no database", async () => {
    const { FOUNDRY_DB: _absent, ...rest } = environmentWithoutSenderSettings;
    await expect(
      runScheduledCampaignBulkDeliveries(rest),
    ).rejects.toThrow("campaign_bulk_delivery_not_configured");
  });
});

describe("the MCP campaign runtime without the sender details", () => {
  const runtime = createMcpCampaignRuntime({
    environment: environmentWithoutSenderSettings,
    humanStore: { listMemberships: async () => [] },
  });

  it("refuses to write a campaign with the named reason", async () => {
    await expect(
      runtime.createStandalone({
        principal,
        requestId: "campaign-mcp-without-footer-000001",
        editable: {} as never,
      }),
    ).rejects.toThrow(reason);
  });

  it("refuses to read a campaign with the same reason", async () => {
    // Reading through MCP needs the same installation parts, so it stops for
    // the same reason rather than a different one.
    await expect(
      runtime.getCampaign({
        principal,
        campaignId: "20000000-0000-4000-8000-000000000001" as never,
      }),
    ).rejects.toThrow(reason);
  });
});
