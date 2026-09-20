import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BlogPostScheduleProposal } from "@humber-foundry/application";
import { createBlogPostId } from "@humber-foundry/site-definition";

vi.mock("server-only", () => ({}));

import {
  blogScheduleRequestAgentName,
  blogScheduleRequestAgentNames,
  isMcpScheduleRequest,
  unnamedConnectedApp,
} from "./blog-schedule-request-runtime";
import type { HumanAccessEnvironment } from "./human-access-configuration";

function proposal(
  overrides: Partial<BlogPostScheduleProposal>,
): BlogPostScheduleProposal {
  return {
    id: "schedule_proposal_test",
    siteId: "site_test",
    postId: "post_test",
    workspaceId: "workspace_test" as BlogPostScheduleProposal["workspaceId"],
    contentRevision: 1,
    postRevisionId: "revision-1",
    authorityVersion: 1,
    localDateTime: "2026-11-01T01:30:00",
    ianaTimeZone: "America/Vancouver",
    utcOffsetChoice: "-07:00",
    executeAtUtc: "2026-11-01T08:30:00.000Z",
    timeZoneDatabaseVersion: "2026a",
    createdBy: "membership-editor" as BlogPostScheduleProposal["createdBy"],
    proposalAuditId: "blog.post.schedule.proposal:schedule_proposal_test",
    createdAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("blog schedule request runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("tells an app's request apart from a person's own", () => {
    expect(isMcpScheduleRequest("mcp-agent-55")).toBe(true);
    expect(isMcpScheduleRequest("membership-editor")).toBe(false);
  });

  it("returns null for a proposal a person made directly", async () => {
    const environment = { FOUNDRY_DB: undefined } as HumanAccessEnvironment;
    await expect(
      blogScheduleRequestAgentName(environment, "membership-editor"),
    ).resolves.toBeNull();
  });

  it("names the app by its own registered address", async () => {
    const first = vi.fn().mockResolvedValue({
      oauth_client_id: "https://helper.example/mcp.json",
    });
    const environment = {
      FOUNDRY_DB: {
        prepare: vi.fn(() => ({ bind: vi.fn(() => ({ first })) })),
      },
    } as unknown as HumanAccessEnvironment;

    await expect(
      blogScheduleRequestAgentName(environment, "mcp-agent-55"),
    ).resolves.toBe("helper.example");
  });

  it("falls back to a plain name when the connection names no client", async () => {
    const first = vi.fn().mockResolvedValue(null);
    const environment = {
      FOUNDRY_DB: {
        prepare: vi.fn(() => ({ bind: vi.fn(() => ({ first })) })),
      },
    } as unknown as HumanAccessEnvironment;

    await expect(
      blogScheduleRequestAgentName(environment, "mcp-agent-vanished"),
    ).resolves.toBe(unnamedConnectedApp);
  });

  it("names every app request and leaves out a person's own", async () => {
    const first = vi
      .fn()
      .mockResolvedValueOnce({
        oauth_client_id: "https://helper.example/mcp.json",
      });
    const environment = {
      FOUNDRY_DB: {
        prepare: vi.fn(() => ({ bind: vi.fn(() => ({ first })) })),
      },
    } as unknown as HumanAccessEnvironment;
    const postAppRequested = createBlogPostId(
      "00000000-0000-4000-8000-000000000001",
    );
    const postPersonRequested = createBlogPostId(
      "00000000-0000-4000-8000-000000000002",
    );

    const names = await blogScheduleRequestAgentNames(
      environment,
      new Map([
        [postAppRequested, proposal({ createdBy: "mcp-agent-55" as never })],
        [
          postPersonRequested,
          proposal({ createdBy: "membership-editor" as never }),
        ],
      ]),
    );

    expect(names.get(postAppRequested)).toBe("helper.example");
    expect(names.has(postPersonRequested)).toBe(false);
  });
});
