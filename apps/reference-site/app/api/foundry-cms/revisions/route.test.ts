import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ContentRevisionConflictError,
  ContentRevisionIdempotencyError,
  ContentRevisionStaleError,
  ContentRevisionValidationError,
  ContentWorkspaceAccessError,
} from "@foundry/application";
import {
  referenceSiteDefinition,
  serializeRichTextDocument,
} from "@foundry/site-definition";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  loadIdentity: vi.fn(),
  create: vi.fn(),
  save: vi.fn(),
  loadApplication: vi.fn(),
  requireExistingAccess: vi.fn(),
  createMutationToken: vi.fn(),
  getRevisionWithBookmark: vi.fn(),
  isRevisionCurrent: vi.fn(),
  verifyMutation: vi.fn(),
}));
vi.mock("../../../../src/human-access-runtime", () => ({
  authorizeAuthenticatedHumanIdentity: mocks.authorize,
  loadHumanIdentityRequestContext: mocks.loadIdentity,
}));
vi.mock("../../../../src/human-mutation-runtime", () => ({
  createHumanMutationToken: mocks.createMutationToken,
  verifyHumanMutation: mocks.verifyMutation,
}));
vi.mock("../../../../src/content-revision-runtime", () => ({
  contentWorkspaceIdForActor: async () => "workspace_default",
  contentWorkspaceIdForMutation: async () => "workspace_created",
  loadContentRevisionApplication: mocks.loadApplication,
  requireExistingContentWorkspaceAccess: mocks.requireExistingAccess,
}));
vi.mock("../../../../src/preview-capability-runtime", () => ({
  createRevisionPreviewCapability: async () => "preview-capability",
}));

import { GET, POST } from "./route";

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
    mocks.createMutationToken.mockResolvedValue("fresh-mutation-token");
    mocks.isRevisionCurrent.mockResolvedValue(true);
    mocks.requireExistingAccess.mockResolvedValue(undefined);
    mocks.loadApplication.mockResolvedValue({
      commands: { create: mocks.create, save: mocks.save },
      queries: {
        getRevisionWithBookmark: mocks.getRevisionWithBookmark,
        isRevisionCurrent: mocks.isRevisionCurrent,
      },
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
      definition: { schemaVersion: "1.1.0" },
      inputs: {
        contentHash: "abc",
        schemaVersion: "1.1.0",
        rendererVersion: "renderer-a",
        productionBase: "published-a",
      },
    });

    const response = await POST(
      request({
        workspaceId: "workspace_home",
        schemaVersion: "1.1.0",
        baseRevision: 2,
        edits: [{ path: "section_hero.title", value: "Changed" }],
      }),
    );

    expect(response.status).toBe(201);
    expect(mocks.save).toHaveBeenCalledWith({
      actorId: "membership-editor",
      workspaceId: "workspace_home",
      schemaVersion: "1.1.0",
      baseRevision: 2,
      edits: [
        {
          path: "section_hero.title",
          format: "plainText",
          value: "Changed",
        },
      ],
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
          "/api/foundry-cms/revisions?workspaceId=workspace_home&revision=3",
      }),
    );
  });

  it("preserves a canonical rich-text edit at the API boundary", async () => {
    mocks.save.mockResolvedValue({
      workspaceId: "workspace_home",
      revision: 3,
      bookmark: "d1-bookmark",
      definition: referenceSiteDefinition,
      inputs: {
        contentHash: "abc",
        schemaVersion: "1.1.0",
        rendererVersion: "renderer-a",
        productionBase: "published-a",
      },
    });
    const callToAction = referenceSiteDefinition.home.sections.find(
      (section) => section.type === "callToAction",
    )!;
    if (callToAction.type !== "callToAction") {
      throw new Error("expected_call_to_action_fixture");
    }
    const value = serializeRichTextDocument(callToAction.body);

    const response = await POST(
      request({
        workspaceId: "workspace_home",
        schemaVersion: "1.1.0",
        baseRevision: 2,
        edits: [
          {
            path: `${callToAction.id}.body`,
            format: "richText",
            value,
          },
        ],
      }),
    );

    expect(response.status).toBe(201);
    expect(mocks.save).toHaveBeenCalledWith(
      expect.objectContaining({
        edits: [
          {
            path: `${callToAction.id}.body`,
            format: "richText",
            value,
          },
        ],
      }),
    );
  });

  it("rejects unsafe rich text before calling the application", async () => {
    const response = await POST(
      request({
        workspaceId: "workspace_home",
        schemaVersion: "1.1.0",
        baseRevision: 2,
        edits: [
          {
            path: "section_contact.body",
            format: "richText",
            value: JSON.stringify({
              version: "1.0.0",
              type: "document",
              children: [
                {
                  type: "paragraph",
                  children: [
                    {
                      type: "text",
                      text: "Unsafe",
                      marks: [
                        { type: "link", href: "javascript:alert(1)" },
                      ],
                    },
                  ],
                },
              ],
            }),
          },
        ],
      }),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: "validation_failed",
      fields: {
        "section_contact.body":
          "Rich text is invalid or contains unsupported or unsafe content.",
      },
    });
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("passes registered component composition through the shared revision command", async () => {
    mocks.save.mockResolvedValue({
      workspaceId: "workspace_home",
      revision: 3,
      bookmark: "d1-bookmark",
      definition: { schemaVersion: "1.1.0" },
      inputs: {
        contentHash: "abc",
        schemaVersion: "1.1.0",
        rendererVersion: "renderer-a",
        productionBase: "published-a",
      },
    });
    const composition = {
      slotId: "slot_home_sections",
      components: [
        {
          id: "section_new_proof",
          type: "proof",
          quote: "Evidence",
          attribution: "Source",
          metrics: [],
        },
      ],
    };

    const response = await POST(
      request({
        workspaceId: "workspace_home",
        schemaVersion: "1.1.0",
        baseRevision: 2,
        edits: [],
        composition,
      }),
    );

    expect(response.status).toBe(201);
    expect(mocks.save).toHaveBeenCalledWith(
      expect.objectContaining({
        edits: [],
        composition,
      }),
    );
  });

  it("rejects a save without copy edits or component composition", async () => {
    const response = await POST(
      request({
        workspaceId: "workspace_home",
        schemaVersion: "1.1.0",
        baseRevision: 2,
        edits: [],
      }),
    );

    expect(response.status).toBe(400);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("creates a workspace only through an authenticated mutation", async () => {
    mocks.create.mockResolvedValue({
      workspaceId: "workspace_created",
      revision: 0,
      definition: { schemaVersion: "1.1.0" },
      inputs: {
        contentHash: "abc",
        schemaVersion: "1.1.0",
        rendererVersion: "renderer-a",
        productionBase: "published-a",
      },
    });

    const response = await POST(
      request({ operation: "create_workspace" }, "workspace-create-0001"),
    );

    expect(response.status).toBe(201);
    expect(mocks.verifyMutation).toHaveBeenCalled();
    expect(mocks.loadApplication).toHaveBeenCalledWith(
      "workspace_created",
      "membership-editor",
    );
    expect(mocks.create).toHaveBeenCalledWith({
      actorId: "membership-editor",
      workspaceId: "workspace_created",
      idempotencyKey: "workspace-create-0001",
    });
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        workspaceId: "workspace_created",
        revision: 0,
        previewUrl:
          "/api/foundry-cms/revisions?workspaceId=workspace_created&revision=0",
      }),
    );
  });

  it("creates the actor's stable default workspace through POST", async () => {
    mocks.create.mockResolvedValue({
      workspaceId: "workspace_default",
      revision: 0,
      definition: { schemaVersion: "1.1.0" },
      inputs: {
        contentHash: "abc",
        schemaVersion: "1.1.0",
        rendererVersion: "renderer-a",
        productionBase: "published-a",
      },
    });

    const response = await POST(
      request(
        { operation: "create_default_workspace" },
        "workspace-default-0001",
      ),
    );

    expect(response.status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith({
      actorId: "membership-editor",
      workspaceId: "workspace_default",
      idempotencyKey: "workspace-default-0001",
    });
  });

  it("refreshes the mutation token for a long-lived editor", async () => {
    const response = await GET(
      new Request("https://foundry.example/api/foundry-cms/revisions"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      mutationToken: "fresh-mutation-token",
    });
  });

  it("mints a fresh bookmarked capability when preview opens", async () => {
    mocks.getRevisionWithBookmark.mockResolvedValue({
      workspaceId: "workspace_home",
      revision: 3,
      bookmark: "fresh-d1-bookmark",
    });
    const response = await GET(
      new Request(
        "https://foundry.example/api/foundry-cms/revisions" +
          "?workspaceId=workspace_home&revision=3",
      ),
    );

    expect(response.status).toBe(307);
    expect(mocks.requireExistingAccess).toHaveBeenCalledWith(
      "workspace_home",
      "membership-editor",
    );
    expect(response.headers.get("location")).toBe(
      "https://foundry.example/__foundry/preview/workspace_home/3" +
        "?capability=preview-capability&bookmark=fresh-d1-bookmark",
    );
  });

  it("does not initialize a missing workspace during preview lookup", async () => {
    mocks.requireExistingAccess.mockRejectedValue(
      new ContentWorkspaceAccessError(),
    );

    const response = await GET(
      new Request(
        "https://foundry.example/api/foundry-cms/revisions" +
          "?workspaceId=workspace_missing&revision=0",
      ),
    );

    expect(response.status).toBe(403);
    expect(mocks.loadApplication).not.toHaveBeenCalled();
  });

  it("returns a conflict when the configured revision inputs are stale", async () => {
    mocks.save.mockRejectedValue(new ContentRevisionStaleError());
    const response = await POST(
      request({
        workspaceId: "workspace_home",
        schemaVersion: "1.1.0",
        baseRevision: 2,
        edits: [{ path: "section_hero.title", value: "Stale inputs" }],
      }),
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "revision_stale",
    });
  });

  it("reports an acknowledged replay that is stale on the current deployment", async () => {
    mocks.save.mockRejectedValue(new ContentRevisionStaleError(3));
    const response = await POST(
      request({
        workspaceId: "workspace_home",
        schemaVersion: "1.1.0",
        baseRevision: 2,
        edits: [{ path: "section_hero.title", value: "Already saved" }],
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "revision_stale",
      acknowledgedRevision: 3,
    });
  });

  it("does not disclose a workspace to an unauthorized actor", async () => {
    mocks.loadApplication.mockRejectedValue(
      new ContentWorkspaceAccessError(),
    );
    const response = await POST(
      request({
        workspaceId: "workspace_private",
        schemaVersion: "1.1.0",
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
        schemaVersion: "1.1.0",
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
        schemaVersion: "1.1.0",
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
        schemaVersion: "1.1.0",
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
        schemaVersion: "1.1.0",
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

  it("keeps prototype-named paths in field-level feedback", async () => {
    const response = await POST(
      request({
        workspaceId: "workspace_home",
        schemaVersion: "1.1.0",
        baseRevision: 2,
        edits: [{ path: "__proto__", value: 42 }],
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(Object.keys(body.fields)).toEqual(["__proto__"]);
    expect(body.fields["__proto__"]).toBe("Enter a text value.");
    expect(mocks.save).not.toHaveBeenCalled();
  });
});
