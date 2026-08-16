import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  published: vi.fn(),
  loadApplication: vi.fn(),
  getPublishedSource: vi.fn(),
}));
vi.mock("@/foundry/site-definition.server", () => ({
  installedSite: {
    application: {
      queries: { getPublishedSite: mocks.published },
    },
  },
}));
vi.mock("../../../../src/media-asset-runtime", () => ({
  MediaAssetConfigurationError: class extends Error {},
  loadMediaAssetApplication: mocks.loadApplication,
}));

import { GET } from "./route";

describe("published media delivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadApplication.mockResolvedValue({
      queries: { getPublishedSource: mocks.getPublishedSource },
    });
    mocks.published.mockResolvedValue({
      home: {
        media: [
          {
            occurrenceId: "occurrence_home_hero",
            asset: { assetId: "asset_published" },
          },
        ],
      },
    });
    mocks.getPublishedSource.mockResolvedValue({
      body: new Uint8Array([1, 2, 3]),
      contentType: "image/png",
    });
  });

  it("serves an anonymous request only when Git-published content references the asset", async () => {
    const response = await GET(
      new Request("https://foundry.example/api/media/asset_published"),
      { params: Promise.resolve({ assetId: "asset_published" }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.getPublishedSource).toHaveBeenCalledWith("asset_published");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });

  it("does not expose an active draft asset absent from the published manifest", async () => {
    const response = await GET(
      new Request("https://foundry.example/api/media/asset_draft"),
      { params: Promise.resolve({ assetId: "asset_draft" }) },
    );

    expect(response.status).toBe(404);
    expect(mocks.loadApplication).not.toHaveBeenCalled();
    expect(mocks.getPublishedSource).not.toHaveBeenCalled();
  });

  it("serves a photo the published page references through an image field", async () => {
    mocks.published.mockResolvedValue({
      home: {
        media: [],
        sections: [
          {
            id: "section_story",
            type: "registered",
            component: "photoBand",
            props: {
              imageSrc: "/api/media/asset_page_photo",
              imageAlt: "Alt",
              caption: "Caption",
            },
          },
        ],
      },
    });

    const response = await GET(
      new Request("https://foundry.example/api/media/asset_page_photo"),
      { params: Promise.resolve({ assetId: "asset_page_photo" }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.getPublishedSource).toHaveBeenCalledWith("asset_page_photo");
  });
});
