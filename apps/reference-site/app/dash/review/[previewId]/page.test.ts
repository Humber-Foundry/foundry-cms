import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  capability: vi.fn(),
  mediaToken: vi.fn(),
  preview: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", () => ({
  notFound() {
    throw new Error("not_found");
  },
  redirect: mocks.redirect,
}));
vi.mock("@/src/human-access-runtime", () => ({
  loadHumanAccessRequestContext: mocks.access,
}));
vi.mock("@/src/mcp-preview-review-runtime", () => ({
  loadMcpPreviewForHuman: mocks.preview,
}));
vi.mock("@/src/human-mutation-runtime", () => ({
  createHumanMediaAccessToken: mocks.mediaToken,
}));
vi.mock("@/src/preview-capability-runtime", () => ({
  createRevisionPreviewCapability: mocks.capability,
}));

import McpPreviewReviewPage from "./page";

describe("MCP human review route", () => {
  it("redirects through the canonical authenticated revision preview", async () => {
    const identity = {
      binding: { issuer: "issuer", subject: "owner" },
      email: "owner@example.com",
    };
    const membership = {
      id: "membership-owner",
      siteId: "site_foundry",
    };
    mocks.access.mockResolvedValue({
      state: "authorized",
      identity,
      membership,
    });
    mocks.preview.mockResolvedValue({
      revision: {
        workspaceId: "workspace_mcp_55",
        revision: 4,
        bookmark: "bookmark-55",
        definition: {
          home: {
            media: [
              { asset: { assetId: "asset-55" } },
              { asset: { assetId: "asset-56" } },
            ],
          },
        },
      },
      review: {},
    });
    mocks.capability.mockResolvedValue("capability-55");
    mocks.mediaToken.mockResolvedValue({ token: "media-token-55" });

    await McpPreviewReviewPage({
      params: Promise.resolve({ previewId: "preview-55" }),
    });

    expect(mocks.preview).toHaveBeenCalledWith({
      previewId: "preview-55",
      siteId: membership.siteId,
    });
    expect(mocks.capability).toHaveBeenCalledWith({
      identity,
      workspaceId: "workspace_mcp_55",
      revision: 4,
    });
    expect(mocks.mediaToken).toHaveBeenCalledWith(
      identity,
      ["asset-55", "asset-56"],
      expect.any(String),
    );
    expect(mocks.redirect).toHaveBeenCalledWith(
      "/__foundry/preview/workspace_mcp_55/4" +
        "?capability=capability-55&bookmark=bookmark-55" +
        "&accessToken=media-token-55&previewId=preview-55",
    );
  });
});
