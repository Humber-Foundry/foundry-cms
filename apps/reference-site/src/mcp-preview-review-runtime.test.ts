import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createCanonicalPreviewArtifactHash,
  createContentActorId,
  createContentWorkspaceId,
} from "@humber-foundry/application";
import {
  homePage,
  referenceSiteDefinition,
  type SiteDefinition,
} from "@humber-foundry/site-definition";

const mocks = vi.hoisted(() => ({
  first: vi.fn(),
  getRevision: vi.fn(),
  getRevisionWithBookmark: vi.fn(),
  isRevisionCurrent: vi.fn(),
  loadApplication: vi.fn(),
  loadEnvironment: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("./content-revision-runtime", () => ({
  loadContentRevisionApplication: mocks.loadApplication,
}));
vi.mock("./human-access-environment", () => ({
  loadHumanAccessEnvironment: mocks.loadEnvironment,
}));

import {
  loadMcpPreviewForHuman,
  loadPreviewsWaitingForReview,
  recordPreviewReviewDecision,
} from "./mcp-preview-review-runtime";

describe("MCP preview review runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects a hash-bound preview after renderer or production-base drift", async () => {
    const revision = {
      workspaceId: createContentWorkspaceId("workspace_mcp_preview_drift"),
      revision: 2,
      definition: referenceSiteDefinition,
      inputs: {
        contentHash: "b".repeat(64),
        schemaVersion: referenceSiteDefinition.schemaVersion,
        rendererVersion: "renderer-55",
        productionBase:
          `git:${"a".repeat(40)}@content:${"b".repeat(64)}`,
      },
      createdAt: "2026-07-29T20:00:00.000Z",
      createdBy: createContentActorId("mcp-agent-55"),
      bookmark: "preview-bookmark",
    };
    mocks.first.mockResolvedValue({
      actor_id: "agent-55",
      workspace_id: revision.workspaceId,
      revision: revision.revision,
      artifact_hash: await createCanonicalPreviewArtifactHash(revision),
    });
    mocks.loadEnvironment.mockResolvedValue({
      FOUNDRY_DB: {
        prepare: vi.fn(() => ({
          bind: vi.fn(() => ({ first: mocks.first })),
        })),
      },
    });
    mocks.getRevisionWithBookmark.mockResolvedValue(revision);
    mocks.isRevisionCurrent.mockResolvedValue(false);
    mocks.getRevision.mockResolvedValue({
      ...revision,
      revision: 0,
    });
    mocks.loadApplication.mockResolvedValue({
      queries: {
        getRevision: mocks.getRevision,
        getRevisionWithBookmark: mocks.getRevisionWithBookmark,
        isRevisionCurrent: mocks.isRevisionCurrent,
      },
    });

    await expect(
      loadMcpPreviewForHuman({
        previewId: "preview-drift",
        siteId: referenceSiteDefinition.site.id,
      }),
    ).resolves.toBeNull();
    expect(mocks.isRevisionCurrent).toHaveBeenCalledWith(revision);
    expect(mocks.getRevision).not.toHaveBeenCalled();
  });

  it("names every changed and created page by its title", async () => {
    const home = homePage(referenceSiteDefinition);
    const hero = home.sections[0]!;
    if (hero.type !== "hero") throw new TypeError("expected_hero_fixture");
    const draftDefinition: SiteDefinition = {
      ...referenceSiteDefinition,
      pages: [
        {
          ...home,
          sections: [
            { ...hero, title: "A new headline" },
            ...home.sections.slice(1),
          ],
        },
        {
          id: "page_about",
          slug: "about",
          title: "About us",
          seo: home.seo,
          sections: [],
        },
      ],
    };
    const revision = {
      workspaceId: createContentWorkspaceId("workspace_mcp_preview_pages"),
      revision: 3,
      definition: draftDefinition,
      inputs: {
        contentHash: "c".repeat(64),
        schemaVersion: referenceSiteDefinition.schemaVersion,
        rendererVersion: "renderer-55",
        productionBase: `git:${"a".repeat(40)}@content:${"b".repeat(64)}`,
      },
      createdAt: "2026-07-29T20:00:00.000Z",
      createdBy: createContentActorId("mcp-agent-55"),
      bookmark: "preview-bookmark",
    };
    mocks.first.mockResolvedValue({
      actor_id: "agent-55",
      workspace_id: revision.workspaceId,
      revision: revision.revision,
      artifact_hash: await createCanonicalPreviewArtifactHash(revision),
    });
    mocks.loadEnvironment.mockResolvedValue({
      FOUNDRY_DB: {
        prepare: vi.fn(() => ({
          bind: vi.fn(() => ({ first: mocks.first })),
        })),
      },
    });
    mocks.getRevisionWithBookmark.mockResolvedValue(revision);
    mocks.isRevisionCurrent.mockResolvedValue(true);
    mocks.getRevision.mockResolvedValue({
      ...revision,
      revision: 0,
      definition: referenceSiteDefinition,
    });
    mocks.loadApplication.mockResolvedValue({
      queries: {
        getRevision: mocks.getRevision,
        getRevisionWithBookmark: mocks.getRevisionWithBookmark,
        isRevisionCurrent: mocks.isRevisionCurrent,
      },
    });

    const preview = await loadMcpPreviewForHuman({
      previewId: "preview-pages",
      siteId: referenceSiteDefinition.site.id,
    });

    expect(preview?.review.changedDocuments).toEqual([
      `${home.title} — Hero: Hero title`,
      "About us — new page at /about",
    ]);
    expect(preview?.review.pages.map(({ state }) => state)).toEqual([
      "changed",
      "created",
    ]);
    expect(preview?.review.publicEffect).toContain(
      "Visitors get a new page at /about.",
    );
    expect(JSON.stringify(preview?.review.changedDocuments)).not.toContain(
      "page_about",
    );
  });
  it("names the app by what it claims, and reports a decision already made", async () => {
    const revision = {
      workspaceId: createContentWorkspaceId("workspace_mcp_preview_named"),
      revision: 2,
      definition: referenceSiteDefinition,
      inputs: {
        contentHash: "d".repeat(64),
        schemaVersion: referenceSiteDefinition.schemaVersion,
        rendererVersion: "renderer-55",
        productionBase: `git:${"a".repeat(40)}@content:${"b".repeat(64)}`,
      },
      createdAt: "2026-09-18T20:00:00.000Z",
      createdBy: createContentActorId("mcp-agent-55"),
      bookmark: "preview-bookmark",
    };
    mocks.first.mockResolvedValue({
      actor_id: "agent-55",
      workspace_id: revision.workspaceId,
      revision: revision.revision,
      artifact_hash: await createCanonicalPreviewArtifactHash(revision),
      created_at: "2026-09-18T19:00:00.000Z",
      oauth_client_id: "https://helper.example/mcp.json",
      decision: "changes_requested",
      approval_id: null,
      reason: "Use the shorter headline",
      decided_at: "2026-09-18T21:00:00.000Z",
    });
    mocks.loadEnvironment.mockResolvedValue({
      FOUNDRY_DB: {
        prepare: vi.fn(() => ({
          bind: vi.fn(() => ({ first: mocks.first })),
        })),
      },
    });
    mocks.getRevisionWithBookmark.mockResolvedValue(revision);
    mocks.isRevisionCurrent.mockResolvedValue(true);
    mocks.getRevision.mockResolvedValue({ ...revision, revision: 0 });
    mocks.loadApplication.mockResolvedValue({
      queries: {
        getRevision: mocks.getRevision,
        getRevisionWithBookmark: mocks.getRevisionWithBookmark,
        isRevisionCurrent: mocks.isRevisionCurrent,
      },
    });

    const preview = await loadMcpPreviewForHuman({
      previewId: "preview_11111111-2222-3333-4444-555555555555",
      siteId: referenceSiteDefinition.site.id,
    });

    expect(preview?.review.agentName).toBe("helper.example");
    expect(preview?.review.preparedAt).toBe("2026-09-18T19:00:00.000Z");
    expect(preview?.review.decided).toEqual({
      decision: "changes_requested",
      approvalId: null,
      reason: "Use the shorter headline",
      decidedAt: "2026-09-18T21:00:00.000Z",
    });
  });

  it("falls back to a plain name when the connection names no client", async () => {
    const revision = {
      workspaceId: createContentWorkspaceId("workspace_mcp_preview_plain"),
      revision: 2,
      definition: referenceSiteDefinition,
      inputs: {
        contentHash: "e".repeat(64),
        schemaVersion: referenceSiteDefinition.schemaVersion,
        rendererVersion: "renderer-55",
        productionBase: `git:${"a".repeat(40)}@content:${"b".repeat(64)}`,
      },
      createdAt: "2026-09-18T20:00:00.000Z",
      createdBy: createContentActorId("mcp-agent-55"),
      bookmark: "preview-bookmark",
    };
    mocks.first.mockResolvedValue({
      actor_id: "agent-55",
      workspace_id: revision.workspaceId,
      revision: revision.revision,
      artifact_hash: await createCanonicalPreviewArtifactHash(revision),
      created_at: "2026-09-18T19:00:00.000Z",
      oauth_client_id: null,
      decision: null,
      approval_id: null,
      reason: null,
      decided_at: null,
    });
    mocks.loadEnvironment.mockResolvedValue({
      FOUNDRY_DB: {
        prepare: vi.fn(() => ({
          bind: vi.fn(() => ({ first: mocks.first })),
        })),
      },
    });
    mocks.getRevisionWithBookmark.mockResolvedValue(revision);
    mocks.isRevisionCurrent.mockResolvedValue(true);
    mocks.getRevision.mockResolvedValue({ ...revision, revision: 0 });
    mocks.loadApplication.mockResolvedValue({
      queries: {
        getRevision: mocks.getRevision,
        getRevisionWithBookmark: mocks.getRevisionWithBookmark,
        isRevisionCurrent: mocks.isRevisionCurrent,
      },
    });

    const preview = await loadMcpPreviewForHuman({
      previewId: "preview_11111111-2222-3333-4444-555555555555",
      siteId: referenceSiteDefinition.site.id,
    });

    expect(preview?.review.agentName).toBe("A connected app");
    expect(preview?.review.decided).toBeNull();
  });

  it("reports whether the decision row was the first one stored", async () => {
    const run = vi.fn().mockResolvedValue({ meta: { changes: 1 } });
    mocks.loadEnvironment.mockResolvedValue({
      FOUNDRY_DB: {
        prepare: vi.fn(() => ({ bind: vi.fn(() => ({ run })) })),
      },
    });

    await expect(
      recordPreviewReviewDecision({
        previewId: "preview_11111111-2222-3333-4444-555555555555",
        siteId: referenceSiteDefinition.site.id,
        workspaceId: "workspace_mcp_preview_named",
        revision: 2,
        decision: "approved",
        approvalId: `approval_${"a".repeat(32)}`,
        reason: null,
        decidedBy: "membership-owner",
        decidedAt: "2026-09-18T21:00:00.000Z",
      }),
    ).resolves.toBe(true);

    run.mockResolvedValue({ meta: { changes: 0 } });
    await expect(
      recordPreviewReviewDecision({
        previewId: "preview_11111111-2222-3333-4444-555555555555",
        siteId: referenceSiteDefinition.site.id,
        workspaceId: "workspace_mcp_preview_named",
        revision: 2,
        decision: "approved",
        approvalId: `approval_${"a".repeat(32)}`,
        reason: null,
        decidedBy: "membership-owner",
        decidedAt: "2026-09-18T21:00:00.000Z",
      }),
    ).resolves.toBe(false);
  });

  it("lists previews that are still waiting for a person", async () => {
    const all = vi.fn().mockResolvedValue({
      results: [
        {
          preview_id: "preview_11111111-2222-3333-4444-555555555555",
          created_at: "2026-09-18T19:00:00.000Z",
          oauth_client_id: "https://helper.example/mcp.json",
        },
      ],
    });
    mocks.loadEnvironment.mockResolvedValue({
      FOUNDRY_DB: {
        prepare: vi.fn(() => ({ bind: vi.fn(() => ({ all })) })),
      },
    });

    await expect(
      loadPreviewsWaitingForReview({
        siteId: referenceSiteDefinition.site.id,
      }),
    ).resolves.toEqual([
      {
        previewId: "preview_11111111-2222-3333-4444-555555555555",
        agentName: "helper.example",
        preparedAt: "2026-09-18T19:00:00.000Z",
      },
    ]);
  });
});
