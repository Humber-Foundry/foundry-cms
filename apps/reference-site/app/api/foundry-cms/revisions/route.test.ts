import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ContentRevisionConflictError,
  ContentRevisionIdempotencyError,
  ContentRevisionStaleError,
  ContentRevisionValidationError,
  ContentWorkspaceAccessError,
} from "@foundry/application";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  loadIdentity: vi.fn(),
  save: vi.fn(),
  loadApplication: vi.fn(),
  verifyMutation: vi.fn(),
}));
vi.mock("../../../../src/human-access-runtime", () => ({
  authorizeAuthenticatedHumanIdentity: mocks.authorize,
  loadHumanIdentityRequestContext: mocks.loadIdentity,
}));
vi.mock("../../../../src/human-mutation-runtime", () => ({
  verifyHumanMutation: mocks.verifyMutation,
}));
vi.mock("../../../../src/content-revision-runtime", () => ({
  loadContentRevisionApplication: mocks.loadApplication,
}));
vi.mock("../../../../src/preview-capability-runtime", () => ({
  createRevisionPreviewCapability: async () => "preview-capability",
}));

import { POST } from "./route";

describe("content revision endpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const identity = {
      binding: { issuer: "issuer", subject: "subject" },
      email: "editor@example.com",
    };
    mocks.loadIdentity.mockResolvedValue({ identity });
    mocks.authorize.mockResolvedValue({
      state: "authorized",
      identity,
      membership: { id: "membership-editor", role: "editor" },
    });
    mocks.verifyMutation.mockResolvedValue(undefined);
    mocks.loadApplication.mockResolvedValue({
      commands: { save: mocks.save },
    });
  });

  function request(
    body: unknown,
    idempotencyKey = "content-save-route-0001",
  ) {
    return new Request(
      "https://foundry.example/api/foundry-cms/revisions",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
        },
        body: JSON.stringify(body),
      },
    );
  }

  it("saves through the authorized editor identity", async () => {
    mocks.save.mockResolvedValue({
      workspaceId: "workspace_home",
      revision: 3,
      bookmark: "d1-bookmark",
      definition: { schemaVersion: "1.0.0" },
      inputs: {
        contentHash: "abc",
        schemaVersion: "1.0.0",
        rendererVersion: "renderer-a",
        productionBase: "published-a",
      },
    });

    const response = await POST(
      request({
        workspaceId: "workspace_home",
        schemaVersion: "1.0.0",
        baseRevision: 2,
        edits: [{ path: "section_hero.title", value: "Changed" }],
      }),
    );

    expect(response.status).toBe(201);
    expect(mocks.save).toHaveBeenCalledWith({
      actorId: "membership-editor",
      workspaceId: "workspace_home",
      schemaVersion: "1.0.0",
      baseRevision: 2,
      edits: [{ path: "section_hero.title", value: "Changed" }],
      idempotencyKey: "content-save-route-0001",
    });
    expect(mocks.loadApplication).toHaveBeenCalledWith(
      "workspace_home",
      "membership-editor",
    );
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        revision: 3,
        previewUrl:
          "/preview/workspace_home/3?capability=preview-capability&bookmark=d1-bookmark",
      }),
    );
  });

  it("returns a conflict when the configured revision inputs are stale", async () => {
    mocks.save.mockRejectedValue(new ContentRevisionStaleError());
    const response = await POST(
      request({
        workspaceId: "workspace_home",
        schemaVersion: "1.0.0",
        baseRevision: 2,
        edits: [{ path: "section_hero.title", value: "Stale inputs" }],
      }),
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "revision_stale",
    });
  });

  it("does not disclose a workspace to an unauthorized actor", async () => {
    mocks.loadApplication.mockRejectedValue(
      new ContentWorkspaceAccessError(),
    );
    const response = await POST(
      request({
        workspaceId: "workspace_private",
        schemaVersion: "1.0.0",
        baseRevision: 0,
        edits: [{ path: "section_hero.title", value: "Unauthorized" }],
      }),
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "workspace_access_denied",
    });
  });

  it("returns field-level validation feedback", async () => {
    mocks.save.mockRejectedValue(
      new ContentRevisionValidationError({
        "section_hero.title": "Enter at least one visible character.",
      }),
    );

    const response = await POST(
      request({
        workspaceId: "workspace_home",
        schemaVersion: "1.0.0",
        baseRevision: 2,
        edits: [{ path: "section_hero.title", value: "" }],
      }),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: "validation_failed",
      fields: {
        "section_hero.title": "Enter at least one visible character.",
      },
    });
  });

  it("returns the latest revision for a stale edit", async () => {
    mocks.save.mockRejectedValue(new ContentRevisionConflictError(7));

    const response = await POST(
      request({
        workspaceId: "workspace_home",
        schemaVersion: "1.0.0",
        baseRevision: 2,
        edits: [{ path: "section_hero.title", value: "Stale" }],
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "revision_conflict",
      currentRevision: 7,
    });
  });

  it("rejects reuse of an idempotency key with different input", async () => {
    mocks.save.mockRejectedValue(new ContentRevisionIdempotencyError());

    const response = await POST(
      request({
        workspaceId: "workspace_home",
        schemaVersion: "1.0.0",
        baseRevision: 2,
        edits: [{ path: "section_hero.title", value: "Different" }],
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "idempotency_key_conflict",
    });
  });

  it("keys malformed field values to the submitted path", async () => {
    const response = await POST(
      request({
        workspaceId: "workspace_home",
        schemaVersion: "1.0.0",
        baseRevision: 2,
        edits: [{ path: "section_hero.title", value: 42 }],
      }),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: "validation_failed",
      fields: {
        "section_hero.title": "Enter a text value.",
      },
    });
    expect(mocks.save).not.toHaveBeenCalled();
  });
});
