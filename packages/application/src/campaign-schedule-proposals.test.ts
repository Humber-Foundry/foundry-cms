import { describe, expect, it } from "vitest";

import { referenceSiteDefinition } from "@humber-foundry/site-definition";

import {
  CampaignScheduleProposalError,
  createCampaignId,
  createCampaignRevisionId,
  createCampaignScheduleProposalApplication,
  createInMemoryCampaignScheduleProposalStore,
  mcpCampaignOperationScopes,
  resolveCampaignScheduleTime,
  type Campaign,
} from "./index";

const siteId = referenceSiteDefinition.site.id;
const campaignId = createCampaignId("11111111-1111-4111-8111-111111111111");
const revisionId = createCampaignRevisionId(
  "22222222-2222-4222-8222-222222222222",
);
const now = "2026-08-06T18:00:00.000Z";
const sendAt = "2026-08-20T17:00:00.000Z";
const idempotencyKey = "33333333-3333-4333-8333-333333333333";
const connectionId = "connection-campaign-57";
const actorId = "agent-campaign-57";

const campaign: Campaign = Object.freeze({
  id: campaignId,
  siteId,
  lifecycleState: "draft",
  currentRevisionId: revisionId,
  version: 3,
  createdAt: now,
  updatedAt: now,
});

function harness({
  scopes = ["publication.schedule"],
  humans = ["membership-owner"],
  activeSchedule = false,
}: {
  scopes?: ReadonlyArray<string>;
  humans?: ReadonlyArray<string>;
  activeSchedule?: boolean;
} = {}) {
  const store = createInMemoryCampaignScheduleProposalStore({
    humanAuthorities: new Set(humans),
    mcpAuthorities: new Set(
      scopes.map((scope) => `${connectionId}:${actorId}:${scope}`),
    ),
  });
  let minted = 0;
  const application = createCampaignScheduleProposalApplication({
    siteId,
    store,
    loadCampaign: async (id) => (id === campaignId ? campaign : null),
    hasActiveSchedule: async () => activeSchedule,
    now: () => now,
    createId: () => {
      minted += 1;
      return `schedule_request_${minted}`;
    },
    timeZoneDatabaseVersion: () => "2026a",
  });
  return { application, store };
}

const mcpAuthority = Object.freeze({
  kind: "mcp" as const,
  connectionId,
  actorId,
  operation: "foundry.campaign.schedule_request" as const,
  requiredScopes: ["publication.schedule"],
});

const resolvedTime = resolveCampaignScheduleTime(sendAt, "America/Vancouver");

describe("a campaign schedule request records a proposal and nothing else", () => {
  it("records the request against the campaign's current revision", async () => {
    const { application } = harness();
    const proposal = await application.commands.proposeSchedule({
      actorId: `mcp-${actorId}`,
      campaignId,
      resolvedTime,
      idempotencyKey,
      authority: mcpAuthority,
    });
    expect(proposal).toMatchObject({
      campaignId,
      campaignRevisionId: revisionId,
      campaignVersion: 3,
      executeAtUtc: sendAt,
      ianaTimeZone: "America/Vancouver",
      createdBy: `mcp-${actorId}`,
      timeZoneDatabaseVersion: "2026a",
    });
    expect(
      await application.queries.pending({ campaignId }),
    ).toStrictEqual(proposal);
  });

  it("replays the same request instead of recording a second one", async () => {
    const { application } = harness();
    const first = await application.commands.proposeSchedule({
      actorId: `mcp-${actorId}`,
      campaignId,
      resolvedTime,
      idempotencyKey,
      authority: mcpAuthority,
    });
    const second = await application.commands.proposeSchedule({
      actorId: `mcp-${actorId}`,
      campaignId,
      resolvedTime,
      idempotencyKey,
      authority: mcpAuthority,
    });
    expect(second).toStrictEqual(first);
    expect(await application.queries.listPending()).toStrictEqual([first]);
  });

  it("refuses the same key used for a different time", async () => {
    const { application } = harness();
    await application.commands.proposeSchedule({
      actorId: `mcp-${actorId}`,
      campaignId,
      resolvedTime,
      idempotencyKey,
      authority: mcpAuthority,
    });
    await expect(
      application.commands.proposeSchedule({
        actorId: `mcp-${actorId}`,
        campaignId,
        resolvedTime: resolveCampaignScheduleTime(
          "2026-08-21T17:00:00.000Z",
          "America/Vancouver",
        ),
        idempotencyKey,
        authority: mcpAuthority,
      }),
    ).rejects.toMatchObject({
      code: "schedule_request_idempotency_key_reused",
    });
  });

  it("refuses a connection that did not evaluate the pinned permission", async () => {
    const { application } = harness({ scopes: ["campaign.draft"] });
    await expect(
      application.commands.proposeSchedule({
        actorId: `mcp-${actorId}`,
        campaignId,
        resolvedTime,
        idempotencyKey,
        authority: { ...mcpAuthority, requiredScopes: ["campaign.draft"] },
      }),
    ).rejects.toMatchObject({ code: "mcp_schedule_authority_required" });
  });

  it("refuses a connection that evaluated no permission at all", async () => {
    const { application } = harness();
    await expect(
      application.commands.proposeSchedule({
        actorId: `mcp-${actorId}`,
        campaignId,
        resolvedTime,
        idempotencyKey,
        authority: { ...mcpAuthority, requiredScopes: [] },
      }),
    ).rejects.toMatchObject({ code: "mcp_schedule_authority_required" });
  });

  it("pins the permission to the command rather than the caller's list", () => {
    expect(
      mcpCampaignOperationScopes["foundry.campaign.schedule_request"],
    ).toBe("publication.schedule");
  });

  it("refuses a time that has already passed", async () => {
    const { application } = harness();
    await expect(
      application.commands.proposeSchedule({
        actorId: `mcp-${actorId}`,
        campaignId,
        resolvedTime: resolveCampaignScheduleTime(
          "2026-07-01T17:00:00.000Z",
          "America/Vancouver",
        ),
        idempotencyKey,
        authority: mcpAuthority,
      }),
    ).rejects.toMatchObject({ code: "bulk_schedule_time_invalid" });
  });

  it("refuses a campaign this site does not hold", async () => {
    const { application } = harness();
    await expect(
      application.commands.proposeSchedule({
        actorId: `mcp-${actorId}`,
        campaignId: createCampaignId(
          "44444444-4444-4444-8444-444444444444",
        ),
        resolvedTime,
        idempotencyKey,
        authority: mcpAuthority,
      }),
    ).rejects.toMatchObject({ code: "campaign_not_found" });
  });

  it("refuses an instant that is not a plain UTC time", () => {
    expect(() =>
      resolveCampaignScheduleTime("20 August", "America/Vancouver"),
    ).toThrow(CampaignScheduleProposalError);
  });
});

describe("only a person answers a campaign schedule request", () => {
  it("stops being pending once a person declines it", async () => {
    const { application } = harness();
    const proposal = await application.commands.proposeSchedule({
      actorId: `mcp-${actorId}`,
      campaignId,
      resolvedTime,
      idempotencyKey,
      authority: mcpAuthority,
    });
    await application.commands.decline({
      actorId: "membership-owner",
      proposalId: proposal.id,
      idempotencyKey: "55555555-5555-4555-8555-555555555555",
    });
    expect(await application.queries.pending({ campaignId })).toBeNull();
    expect(await application.queries.listPending()).toStrictEqual([]);
  });

  it("declining twice is safe and answers the same request", async () => {
    const { application } = harness();
    const proposal = await application.commands.proposeSchedule({
      actorId: `mcp-${actorId}`,
      campaignId,
      resolvedTime,
      idempotencyKey,
      authority: mcpAuthority,
    });
    const decline = () =>
      application.commands.decline({
        actorId: "membership-owner",
        proposalId: proposal.id,
        idempotencyKey: "55555555-5555-4555-8555-555555555555",
      });
    expect(await decline()).toStrictEqual(await decline());
  });

  it("refuses a decline from anyone who is not an active Owner or Editor", async () => {
    const { application } = harness();
    const proposal = await application.commands.proposeSchedule({
      actorId: `mcp-${actorId}`,
      campaignId,
      resolvedTime,
      idempotencyKey,
      authority: mcpAuthority,
    });
    await expect(
      application.commands.decline({
        actorId: `mcp-${actorId}`,
        proposalId: proposal.id,
        idempotencyKey: "55555555-5555-4555-8555-555555555555",
      }),
    ).rejects.toMatchObject({ code: "human_authority_required" });
  });

  it("refuses a request when a send is already set for that campaign", async () => {
    // Recording one would answer `pending_human_approval` while every screen
    // showed nothing pending, so the tool says no by name instead.
    const { application } = harness({ activeSchedule: true });
    await expect(
      application.commands.proposeSchedule({
        actorId: `mcp-${actorId}`,
        campaignId,
        resolvedTime,
        idempotencyKey,
        authority: mcpAuthority,
      }),
    ).rejects.toMatchObject({ code: "campaign_send_already_scheduled" });
    expect(await application.queries.pending({ campaignId })).toBeNull();
    expect(await application.queries.listPending()).toStrictEqual([]);
  });

  it("stops reporting a request once a person sets the send themselves", async () => {
    // A person can answer a request by scheduling the send. Nothing is
    // declined, and the request stops being pending. See ADR-0038 §1.
    let sendIsSet = false;
    const store = createInMemoryCampaignScheduleProposalStore({
      humanAuthorities: new Set(["membership-owner"]),
      mcpAuthorities: new Set([
        `${connectionId}:${actorId}:publication.schedule`,
      ]),
    });
    const application = createCampaignScheduleProposalApplication({
      siteId,
      store,
      loadCampaign: async (id) => (id === campaignId ? campaign : null),
      hasActiveSchedule: async () => sendIsSet,
      now: () => now,
      createId: () => "schedule_request_1",
      timeZoneDatabaseVersion: () => "2026a",
    });
    await application.commands.proposeSchedule({
      actorId: `mcp-${actorId}`,
      campaignId,
      resolvedTime,
      idempotencyKey,
      authority: mcpAuthority,
    });
    expect(await application.queries.pending({ campaignId })).not.toBeNull();
    sendIsSet = true;
    expect(await application.queries.pending({ campaignId })).toBeNull();
    expect(await application.queries.listPending()).toStrictEqual([]);
  });
});

describe("a campaign schedule request carries no identity", () => {
  it("names no address, no recipient and no subscriber", async () => {
    const { application } = harness();
    const proposal = await application.commands.proposeSchedule({
      actorId: `mcp-${actorId}`,
      campaignId,
      resolvedTime,
      idempotencyKey,
      authority: mcpAuthority,
    });
    const written = JSON.stringify(proposal);
    expect(written).not.toContain("@");
    for (const forbidden of [
      "recipient",
      "subscriber",
      "address",
      "email",
    ]) {
      expect(written.toLowerCase()).not.toContain(forbidden);
    }
  });
});
