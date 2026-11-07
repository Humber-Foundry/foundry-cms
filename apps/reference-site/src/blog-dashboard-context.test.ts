import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  BlogPostOperationalSummary,
  BlogPostScheduleProposal,
} from "@humber-foundry/application";
import { createBlogPostId } from "@humber-foundry/site-definition";

vi.mock("server-only", () => ({}));

const loadHumanAccessEnvironment = vi.fn();
const loadBlogPostOperationalSummaries = vi.fn();
const loadBlogPostOperationsApplication = vi.fn();
const blogScheduleRequestAgentNames = vi.fn();

vi.mock("./human-access-environment", () => ({
  loadHumanAccessEnvironment: () => loadHumanAccessEnvironment(),
}));
vi.mock("./blog-post-operations-runtime", () => ({
  loadBlogPostOperationalSummaries: (...args: unknown[]) =>
    loadBlogPostOperationalSummaries(...args),
  loadBlogPostOperationsApplication: (...args: unknown[]) =>
    loadBlogPostOperationsApplication(...args),
}));
vi.mock("./blog-schedule-request-runtime", () => ({
  blogScheduleRequestAgentNames: (...args: unknown[]) =>
    blogScheduleRequestAgentNames(...args),
}));
vi.mock("../foundry/site-definition", () => ({
  installedSiteDefinition: { site: { id: "site_test" } },
}));

import {
  loadBlogPostOperationalContext,
  loadBlogPostSummaries,
} from "./blog-dashboard-context";

const postId = createBlogPostId("00000000-0000-4000-8000-00000000000e");

function summary(): BlogPostOperationalSummary {
  return {
    siteId: "site_test",
    postId,
    workspaceId: "workspace_test" as BlogPostOperationalSummary["workspaceId"],
    contentRevision: 1,
    postRevision: 1,
    postRevisionId: "revision-1",
    collectionState: "active",
    workflowState: "editing",
    liveRevisionId: null,
    version: 1,
    archiveRequestId: null,
    activeSchedule: null,
    latestExecution: null,
    pendingScheduleProposal: null,
  };
}

const archived = { postId: "post-archived", title: "Old post" };

describe("what the Blog screens read about a post", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    loadHumanAccessEnvironment.mockResolvedValue({ name: "environment" });
    loadBlogPostOperationalSummaries.mockResolvedValue(
      new Map([[postId, summary()]]),
    );
    blogScheduleRequestAgentNames.mockResolvedValue(new Map());
    loadBlogPostOperationsApplication.mockResolvedValue({
      queries: { listArchivedPosts: async () => [archived] },
    });
  });

  it("reads the summaries and the archived posts with one environment", async () => {
    const context = await loadBlogPostOperationalContext([postId]);

    expect(context.summaries.get(postId)).toEqual(summary());
    expect(context.archivedPosts).toEqual([archived]);
    expect(loadHumanAccessEnvironment).toHaveBeenCalledTimes(1);
  });

  it("keeps the summaries when only the archived-posts read fails", async () => {
    loadBlogPostOperationsApplication.mockRejectedValue(
      new Error("store_unavailable"),
    );

    const context = await loadBlogPostOperationalContext([postId]);

    expect(context.summaries.get(postId)).toEqual(summary());
    expect(context.archivedPosts).toEqual([]);
  });

  it("keeps the archived posts when only the summaries read fails", async () => {
    loadBlogPostOperationalSummaries.mockRejectedValue(
      new Error("store_unavailable"),
    );

    const context = await loadBlogPostOperationalContext([postId]);

    expect(context.summaries.size).toBe(0);
    expect(context.pendingScheduleRequestAgentNames.size).toBe(0);
    expect(context.archivedPosts).toEqual([archived]);
  });

  it("gives empty results when the environment cannot be loaded", async () => {
    loadHumanAccessEnvironment.mockRejectedValue(new Error("not_configured"));

    expect(await loadBlogPostOperationalContext([postId])).toEqual({
      summaries: new Map(),
      pendingScheduleRequestAgentNames: new Map(),
      archivedPosts: [],
    });
    expect(await loadBlogPostSummaries([postId])).toEqual({
      summaries: new Map(),
      pendingScheduleRequestAgentNames: new Map(),
    });
  });

  it("asks for an app name only for posts with a pending request", async () => {
    const proposal = { id: "proposal-1" } as BlogPostScheduleProposal;
    loadBlogPostOperationalSummaries.mockResolvedValue(
      new Map([
        [postId, { ...summary(), pendingScheduleProposal: proposal }],
        ["post-other", summary()],
      ]),
    );
    blogScheduleRequestAgentNames.mockResolvedValue(
      new Map([[postId, "Draft Assistant"]]),
    );

    const read = await loadBlogPostSummaries([postId]);

    expect(blogScheduleRequestAgentNames).toHaveBeenCalledWith(
      { name: "environment" },
      new Map([[postId, proposal]]),
    );
    expect(read.pendingScheduleRequestAgentNames.get(postId)).toBe(
      "Draft Assistant",
    );
  });
});
