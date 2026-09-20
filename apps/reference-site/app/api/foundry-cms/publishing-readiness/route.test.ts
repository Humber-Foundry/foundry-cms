import { beforeEach, describe, expect, it, vi } from "vitest";

import { AccessDeniedError } from "@humber-foundry/application";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  loadIdentity: vi.fn(),
  readReadiness: vi.fn(),
}));

vi.mock("../../../../src/human-access-runtime", () => ({
  authorizeAuthenticatedHumanIdentity: mocks.authorize,
  loadHumanIdentityRequestContext: mocks.loadIdentity,
}));
vi.mock("../../../../src/content-publication-runtime", () => ({
  readContentPublicationReadiness: mocks.readReadiness,
}));

import { GET } from "./route";

describe("publishing readiness endpoint", () => {
  const identityContext = {
    identity: {
      binding: { issuer: "issuer", subject: "subject" },
      email: "editor@example.com",
      nonce: "nonce",
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadIdentity.mockResolvedValue(identityContext);
  });

  function request() {
    return new Request(
      "https://foundry.example/api/foundry-cms/publishing-readiness",
    );
  }

  it("reports publishing readiness for an authorized member", async () => {
    mocks.authorize.mockResolvedValue({
      state: "authorized",
      identity: identityContext.identity,
      membership: { id: "membership-editor", role: "editor", status: "active" },
    });
    mocks.readReadiness.mockResolvedValue({
      state: "not_configured",
      missingSettings: ["FOUNDRY_GITHUB_APP_ID"],
      setupGuide: "docs/operations/github-publishing-readiness.md",
    });

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      publishing: {
        state: "not_configured",
        missingSettings: ["FOUNDRY_GITHUB_APP_ID"],
        setupGuide: "docs/operations/github-publishing-readiness.md",
      },
    });
  });

  it("refuses a member whose access is not active", async () => {
    mocks.authorize.mockResolvedValue({ state: "not_a_member" });

    const response = await GET(request());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "request_check_failed",
    });
    expect(mocks.readReadiness).not.toHaveBeenCalled();
  });

  it("reports a denied identity as a request check failure", async () => {
    mocks.loadIdentity.mockRejectedValue(
      new AccessDeniedError("membership_not_found"),
    );

    const response = await GET(request());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "request_check_failed",
    });
    expect(mocks.readReadiness).not.toHaveBeenCalled();
  });
});
