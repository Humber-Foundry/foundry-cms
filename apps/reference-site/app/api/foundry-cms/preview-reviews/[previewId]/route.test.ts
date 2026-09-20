import { beforeEach, describe, expect, it, vi } from "vitest";

import { AccessDeniedError } from "@humber-foundry/application";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  loadIdentity: vi.fn(),
  loadPreview: vi.fn(),
}));

vi.mock("../../../../../src/human-access-runtime", () => ({
  authorizeAuthenticatedHumanIdentity: mocks.authorize,
  loadHumanIdentityRequestContext: mocks.loadIdentity,
}));
vi.mock("../../../../../src/mcp-preview-review-runtime", () => ({
  loadMcpPreviewForHuman: mocks.loadPreview,
}));

import { GET } from "./route";

const previewId = "preview_11111111-2222-3333-4444-555555555555";

function request() {
  return new Request(
    `https://cms.example/api/foundry-cms/preview-reviews/${previewId}`,
  );
}

const params = Promise.resolve({ previewId });

describe("preview check endpoint", () => {
  const identityContext = {
    identity: { binding: { issuer: "issuer", subject: "subject" } },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadIdentity.mockResolvedValue(identityContext);
    mocks.authorize.mockResolvedValue({
      state: "authorized",
      identity: identityContext.identity,
      membership: { id: "membership-editor", siteId: "site_foundry" },
    });
  });

  it("answers with a status and no body while the preview still stands", async () => {
    mocks.loadPreview.mockResolvedValue({
      revision: { workspaceId: "workspace_mcp_70", revision: 4 },
      review: { previewId, decided: null },
    });

    const response = await GET(request(), { params });

    expect(response.status).toBe(204);
    await expect(response.text()).resolves.toBe("");
    // The answer is about one person and one moment, so it is never stored.
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("answers not found once the draft moved on", async () => {
    mocks.loadPreview.mockResolvedValue(null);

    const response = await GET(request(), { params });

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("refuses a caller with no signed-in person", async () => {
    mocks.loadIdentity.mockRejectedValue(
      new AccessDeniedError("membership_not_found"),
    );

    const response = await GET(request(), { params });

    expect(response.status).toBe(403);
    expect(mocks.loadPreview).not.toHaveBeenCalled();
  });
});
