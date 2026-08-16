import { beforeEach, describe, expect, it, vi } from "vitest";

import { referenceSiteDefinition } from "@humber-foundry/site-definition";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  getRevision: vi.fn(),
  isRevisionCurrent: vi.fn(),
  loadApplication: vi.fn(),
  loadIdentity: vi.fn(),
  loadMcpPreview: vi.fn(),
  verifyCapability: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    cache<T extends (...args: never[]) => unknown>(callback: T): T {
      const values = new Map<string, ReturnType<T>>();
      return ((...args: Parameters<T>) => {
        const key = JSON.stringify(args);
        if (!values.has(key)) {
          values.set(key, callback(...args) as ReturnType<T>);
        }
        return values.get(key);
      }) as T;
    },
  };
});
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", () => ({
  notFound() {
    throw new Error("not_found");
  },
}));
vi.mock("./human-access-runtime", () => ({
  authorizeAuthenticatedHumanIdentity: mocks.authorize,
  loadHumanIdentityRequestContext: mocks.loadIdentity,
}));
vi.mock("./content-revision-runtime", () => ({
  loadContentRevisionApplication: mocks.loadApplication,
}));
vi.mock("./preview-capability-runtime", () => ({
  verifyRevisionPreviewCapability: mocks.verifyCapability,
}));
vi.mock("./mcp-preview-review-runtime", () => ({
  loadMcpPreviewForHuman: mocks.loadMcpPreview,
}));

import { loadRevisionPreview } from "./revision-preview-page";

describe("revision preview page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("memoizes one authenticated revision for metadata and body", async () => {
    const identity = {
      binding: { issuer: "issuer", subject: "subject" },
      email: "editor@example.com",
    };
    const revision = {
      workspaceId: "workspace_home",
      revision: 3,
      createdAt: "2026-07-27T12:00:00.000Z",
      definition: {
        home: {
          seo: {
            title: "Edited SEO title",
            description: "Edited SEO description",
            keywords: [],
            shareImage: null,
          },
        },
      },
      inputs: {
        contentHash: "content-hash",
        schemaVersion: "1.2.0",
        rendererVersion: "renderer-a",
        productionBase: "production-a",
      },
    };
    mocks.loadIdentity.mockResolvedValue({ identity });
    mocks.authorize.mockResolvedValue({
      state: "authorized",
      identity,
      membership: { id: "membership-editor" },
    });
    mocks.getRevision.mockResolvedValue(revision);
    mocks.isRevisionCurrent.mockResolvedValue(true);
    mocks.loadApplication.mockResolvedValue({
      queries: {
        getRevision: mocks.getRevision,
        isRevisionCurrent: mocks.isRevisionCurrent,
      },
    });
    const props = {
      params: Promise.resolve({
        workspaceId: "workspace_home",
        revision: "3",
      }),
      searchParams: Promise.resolve({
        capability: "preview-capability",
        bookmark: "d1-bookmark",
      }),
    };

    const metadataRevision = await loadRevisionPreview(props);
    const bodyRevision = await loadRevisionPreview(props);

    expect(metadataRevision).toBe(bodyRevision);
    expect(metadataRevision.definition.home.seo).toEqual({
      title: "Edited SEO title",
      description: "Edited SEO description",
      keywords: [],
      shareImage: null,
    });
    expect(mocks.loadIdentity).toHaveBeenCalledTimes(1);
    expect(mocks.authorize).toHaveBeenCalledTimes(1);
    expect(mocks.verifyCapability).toHaveBeenCalledTimes(1);
    expect(mocks.getRevision).toHaveBeenCalledTimes(1);
    expect(mocks.isRevisionCurrent).toHaveBeenCalledTimes(1);
  });

  it("keeps MCP review on the authenticated revision capability path", async () => {
    const identity = {
      binding: { issuer: "issuer", subject: "subject" },
      email: "owner@example.com",
    };
    const revision = {
      workspaceId: "workspace_mcp_review",
      revision: 2,
      bookmark: "mcp-bookmark",
      createdAt: "2026-07-29T20:00:00.000Z",
      definition: referenceSiteDefinition,
      inputs: {
        contentHash: "c".repeat(64),
        schemaVersion: referenceSiteDefinition.schemaVersion,
        rendererVersion: "renderer-55",
        productionBase: "a".repeat(40),
      },
    };
    const review = {
      previewId: "preview-mcp-55",
      actorId: "agent-55",
      changedDocuments: ["site_foundry.name"],
      designChanges: [],
      publicEffect: "No public effect. This review does not approve or publish.",
    };
    mocks.loadIdentity.mockResolvedValue({ identity });
    mocks.authorize.mockResolvedValue({
      state: "authorized",
      identity,
      membership: {
        id: "membership-owner",
        siteId: referenceSiteDefinition.site.id,
      },
    });
    mocks.loadMcpPreview.mockResolvedValue({ revision, review });

    await expect(
      loadRevisionPreview({
        params: Promise.resolve({
          workspaceId: revision.workspaceId,
          revision: String(revision.revision),
        }),
        searchParams: Promise.resolve({
          capability: "short-lived-capability",
          bookmark: revision.bookmark,
          previewId: review.previewId,
        }),
      }),
    ).resolves.toEqual({ ...revision, mcpReview: review });
    expect(mocks.verifyCapability).toHaveBeenCalledWith({
      capability: "short-lived-capability",
      identity,
      workspaceId: revision.workspaceId,
      revision: revision.revision,
    });
    expect(mocks.loadMcpPreview).toHaveBeenCalledWith({
      previewId: review.previewId,
      siteId: referenceSiteDefinition.site.id,
    });
    expect(mocks.loadApplication).not.toHaveBeenCalled();
  });
});
