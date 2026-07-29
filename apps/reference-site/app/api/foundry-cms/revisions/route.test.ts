import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ContentRevisionConflictError,
  ContentRevisionIdempotencyError,
  ContentRevisionStaleError,
  ContentRevisionValidationError,
  ContentWorkspaceAccessError,
  MediaValidationError,
} from "@foundry/application";
import {
  referenceSiteDefinition,
  serializeRichTextDocument,
} from "@foundry/site-definition";
import { HumanRequestIntegrityError } from "../../../../src/human-request-integrity";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  loadIdentity: vi.fn(),
  create: vi.fn(),
  save: vi.fn(),
  createBlogPost: vi.fn(),
  editBlogPost: vi.fn(),
  unpublishBlogPost: vi.fn(),
  republishBlogPost: vi.fn(),
  recordRejectedBlogPostCommand: vi.fn(),
  loadApplication: vi.fn(),
  requireExistingAccess: vi.fn(),
  createMutationToken: vi.fn(),
  createMediaAccessToken: vi.fn(),
  verifyMediaAccessToken: vi.fn(),
  grantRevisionAccess: vi.fn(),
  loadMediaApplication: vi.fn(),
  getRevisionWithBookmark: vi.fn(),
  isRevisionCurrent: vi.fn(),
  verifyMutation: vi.fn(),
}));
vi.mock("../../../../src/human-access-runtime", () => ({
  authorizeAuthenticatedHumanIdentity: mocks.authorize,
  loadHumanIdentityRequestContext: mocks.loadIdentity,
}));
vi.mock("../../../../src/human-mutation-runtime", () => ({
  createHumanMediaAccessToken: mocks.createMediaAccessToken,
  createHumanMutationToken: mocks.createMutationToken,
  verifyHumanMediaAccessToken: mocks.verifyMediaAccessToken,
  verifyHumanMutation: mocks.verifyMutation,
}));
vi.mock("../../../../src/content-revision-runtime", () => ({
  contentWorkspaceIdForActor: async () => "workspace_default",
  contentWorkspaceIdForMutation: async () => "workspace_created",
  loadContentRevisionApplication: mocks.loadApplication,
  requireExistingContentWorkspaceAccess: mocks.requireExistingAccess,
}));
vi.mock("../../../../src/media-asset-runtime", () => ({
  MediaAssetConfigurationError: class extends Error {},
  loadMediaAssetApplication: mocks.loadMediaApplication,
}));
vi.mock("../../../../src/preview-capability-runtime", () => ({
  createRevisionPreviewCapability: async () => "preview-capability",
}));

import { GET, POST } from "./route";

const routePostId = "00000000-0000-4000-8000-00000000000a";

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
    mocks.createMediaAccessToken.mockResolvedValue({
      token: "revision-media-access",
      expiresAt: 1_785_124_800,
    });
    mocks.verifyMediaAccessToken.mockResolvedValue(undefined);
    mocks.grantRevisionAccess.mockResolvedValue({
      assetIds: ["asset_historical"],
      accessGrantedAt: "2026-07-27T12:00:00.000Z",
    });
    mocks.loadMediaApplication.mockResolvedValue({
      commands: { grantRevisionAccess: mocks.grantRevisionAccess },
    });
    mocks.isRevisionCurrent.mockResolvedValue(true);
    mocks.requireExistingAccess.mockResolvedValue(undefined);
    mocks.loadApplication.mockResolvedValue({
      commands: {
        create: mocks.create,
        save: mocks.save,
        createBlogPost: mocks.createBlogPost,
        editBlogPost: mocks.editBlogPost,
        unpublishBlogPost: mocks.unpublishBlogPost,
        republishBlogPost: mocks.republishBlogPost,
        recordRejectedBlogPostCommand:
          mocks.recordRejectedBlogPostCommand,
      },
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

  it("preserves an omitted legacy format for idempotent retry compatibility", async () => {
    mocks.save.mockResolvedValue({
      workspaceId: "workspace_home",
      revision: 3,
      bookmark: "d1-bookmark",
      definition: { schemaVersion: "1.2.0" },
      inputs: {
        contentHash: "abc",
        schemaVersion: "1.2.0",
        rendererVersion: "renderer-a",
        productionBase: "published-a",
      },
    });

    const response = await POST(
      request({
        workspaceId: "workspace_home",
        schemaVersion: "1.2.0",
        baseRevision: 2,
        edits: [{ path: "section_hero.title", value: "Changed" }],
      }),
    );

    expect(response.status).toBe(201);
    expect(mocks.save).toHaveBeenCalledWith({
      actorId: "membership-editor",
      workspaceId: "workspace_home",
      schemaVersion: "1.2.0",
      baseRevision: 2,
      edits: [
        {
          path: "section_hero.title",
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

  it("creates a schema-valid post through the authenticated revision boundary", async () => {
    const callToAction = referenceSiteDefinition.home.sections.find(
      ({ type }) => type === "callToAction",
    );
    if (callToAction?.type !== "callToAction") {
      throw new Error("call_to_action_fixture_missing");
    }
    const body = callToAction.body;
    mocks.createBlogPost.mockResolvedValue({
      workspaceId: "workspace_home",
      revision: 1,
      bookmark: "d1-bookmark",
      definition: {
        ...referenceSiteDefinition,
        blog: {
          id: "blog",
          posts: [
            {
              id: routePostId,
              revision: 1,
              collectionState: "active",
              targetVisibility: "public",
              slug: "route-post",
              title: "Route post",
              excerpt: "Created through the route.",
              seo: {
                title: "Route post | Foundry",
                description: "Created through the authenticated route.",
              },
              body,
            },
          ],
        },
      },
      inputs: {
        contentHash: "abc",
        schemaVersion: referenceSiteDefinition.schemaVersion,
        rendererVersion: "renderer-a",
        productionBase: "published-a",
      },
    });
    const response = await POST(
      request({
        operation: "create_blog_post",
        workspaceId: "workspace_home",
        schemaVersion: referenceSiteDefinition.schemaVersion,
        baseRevision: 0,
        post: {
          id: routePostId,
          slug: "route-post",
          title: "Route post",
          excerpt: "Created through the route.",
          seo: {
            title: "Route post | Foundry",
            description: "Created through the authenticated route.",
          },
          body: serializeRichTextDocument(body),
        },
      }, "create-blog-route-0001"),
    );

    expect(response.status).toBe(201);
    expect(mocks.createBlogPost).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "membership-editor",
        workspaceId: "workspace_home",
        siteId: referenceSiteDefinition.site.id,
        baseRevision: 0,
        idempotencyKey: "create-blog-route-0001",
        post: expect.objectContaining({
          id: routePostId,
          slug: "route-post",
          body,
        }),
      }),
    );
    await expect(response.json()).resolves.toMatchObject({
      revision: 1,
      previewUrl:
        "/api/foundry-cms/revisions?workspaceId=workspace_home&revision=1&post=route-post",
    });
  });

  it("audits a malformed recognized blog command at the authenticated boundary", async () => {
    const response = await POST(
      request(
        {
          operation: "create_blog_post",
          workspaceId: "not a workspace",
          schemaVersion: referenceSiteDefinition.schemaVersion,
          baseRevision: 0,
          post: {
            id: "not-a-post-id",
            slug: "bad slug",
          },
        },
        "malformed-blog-route-0001",
      ),
    );

    expect(response.status).toBe(400);
    expect(mocks.loadApplication).toHaveBeenCalledWith(
      "workspace_default",
      "membership-editor",
    );
    expect(mocks.recordRejectedBlogPostCommand).toHaveBeenCalledWith({
      actorId: "membership-editor",
      postId: null,
      commandType: "blog.post.create",
      reasonCode: "blog_command_invalid",
      requestId: "malformed-blog-route-0001",
    });
    expect(mocks.createBlogPost).not.toHaveBeenCalled();
  });

  it("attributes malformed blog commands to an accessible submitted workspace", async () => {
    const response = await POST(
      request(
        {
          operation: "edit_blog_post",
          workspaceId: "workspace_collaborator",
          schemaVersion: referenceSiteDefinition.schemaVersion,
          baseRevision: 1,
          postId: routePostId,
          post: { slug: "bad slug" },
        },
        "malformed-blog-route-0002",
      ),
    );

    expect(response.status).toBe(400);
    expect(mocks.requireExistingAccess).toHaveBeenCalledWith(
      "workspace_collaborator",
      "membership-editor",
    );
    expect(mocks.loadApplication).toHaveBeenCalledWith(
      "workspace_collaborator",
      "membership-editor",
    );
    expect(mocks.recordRejectedBlogPostCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        postId: routePostId,
        commandType: "blog.post.edit",
        requestId: "malformed-blog-route-0002",
      }),
    );
  });

  it("audits malformed post rich text as an invalid blog command", async () => {
    const response = await POST(
      request(
        {
          operation: "create_blog_post",
          workspaceId: "workspace_home",
          schemaVersion: referenceSiteDefinition.schemaVersion,
          baseRevision: 0,
          post: {
            id: routePostId,
            slug: "invalid-rich-text",
            title: "Invalid rich text",
            excerpt: "The body is not canonical rich text.",
            seo: {
              title: "Invalid rich text | Foundry",
              description: "The body is not canonical rich text.",
            },
            body: "{",
          },
        },
        "malformed-blog-rich-text-0001",
      ),
    );

    expect(response.status).toBe(400);
    expect(mocks.loadApplication).toHaveBeenCalledWith(
      "workspace_home",
      "membership-editor",
    );
    expect(mocks.recordRejectedBlogPostCommand).toHaveBeenCalledWith({
      actorId: "membership-editor",
      postId: routePostId,
      commandType: "blog.post.create",
      reasonCode: "blog_command_invalid",
      requestId: "malformed-blog-rich-text-0001",
    });
    expect(mocks.createBlogPost).not.toHaveBeenCalled();
  });

  it("preserves a canonical rich-text edit at the API boundary", async () => {
    mocks.save.mockResolvedValue({
      workspaceId: "workspace_home",
      revision: 3,
      bookmark: "d1-bookmark",
      definition: referenceSiteDefinition,
      inputs: {
        contentHash: "abc",
        schemaVersion: "1.2.0",
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
        schemaVersion: "1.2.0",
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
        schemaVersion: "1.2.0",
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
      definition: { schemaVersion: "1.2.0" },
      inputs: {
        contentHash: "abc",
        schemaVersion: "1.2.0",
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
        schemaVersion: "1.2.0",
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
        schemaVersion: "1.2.0",
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
      definition: { schemaVersion: "1.2.0" },
      inputs: {
        contentHash: "abc",
        schemaVersion: "1.2.0",
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
      definition: { schemaVersion: "1.2.0" },
      inputs: {
        contentHash: "abc",
        schemaVersion: "1.2.0",
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
      definition: {
        home: {
          media: [
            {
              occurrenceId: "occurrence_home_hero",
              asset: { assetId: "asset_historical" },
            },
          ],
        },
      },
    });
    const response = await GET(
      new Request(
        "https://foundry.example/api/foundry-cms/revisions" +
          "?workspaceId=workspace_home&revision=3&accessToken=exact-media-access",
      ),
    );

    expect(response.status).toBe(307);
    expect(mocks.requireExistingAccess).toHaveBeenCalledWith(
      "workspace_home",
      "membership-editor",
    );
    expect(response.headers.get("location")).toBe(
      "https://foundry.example/__foundry/preview/workspace_home/3" +
        "?capability=preview-capability&bookmark=fresh-d1-bookmark" +
        "&accessToken=exact-media-access",
    );
    expect(mocks.verifyMediaAccessToken).toHaveBeenCalledWith(
      "exact-media-access",
      expect.objectContaining({
        binding: { issuer: "issuer", subject: "subject" },
      }),
      "asset_historical",
    );
    expect(mocks.createMediaAccessToken).not.toHaveBeenCalled();
  });

  it("audits exact revision media before returning a fresh preview URL", async () => {
    mocks.getRevisionWithBookmark.mockResolvedValue({
      workspaceId: "workspace_home",
      revision: 2,
      bookmark: "historical-bookmark",
      definition: {
        home: {
          media: [
            {
              occurrenceId: "occurrence_home_hero",
              asset: { assetId: "asset_historical" },
            },
          ],
        },
      },
    });

    const response = await POST(
      request(
        {
          operation: "open_preview",
          workspaceId: "workspace_home",
          revision: 2,
        },
        "open-historical-preview-0001",
      ),
    );

    expect(response.status).toBe(200);
    expect(mocks.grantRevisionAccess).toHaveBeenCalledWith({
      actorId: "membership-editor",
      workspaceId: "workspace_home",
      assetIds: ["asset_historical"],
      idempotencyKey: "open-historical-preview-0001",
    });
    expect(mocks.createMediaAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({
        binding: { issuer: "issuer", subject: "subject" },
      }),
      ["asset_historical"],
      "2026-07-27T12:00:00.000Z",
    );
    await expect(response.json()).resolves.toEqual({
      previewUrl:
        "/__foundry/preview/workspace_home/2" +
        "?capability=preview-capability&bookmark=historical-bookmark" +
        "&accessToken=revision-media-access",
    });
  });

  it("rejects a preview token that does not cover the exact revision asset", async () => {
    mocks.getRevisionWithBookmark.mockResolvedValue({
      workspaceId: "workspace_home",
      revision: 2,
      bookmark: "historical-bookmark",
      definition: {
        home: {
          media: [
            {
              occurrenceId: "occurrence_home_hero",
              asset: { assetId: "asset_historical" },
            },
          ],
        },
      },
    });
    mocks.verifyMediaAccessToken.mockRejectedValue(
      new HumanRequestIntegrityError(),
    );

    const response = await GET(
      new Request(
        "https://foundry.example/api/foundry-cms/revisions" +
          "?workspaceId=workspace_home&revision=2&accessToken=current-only",
      ),
    );

    expect(response.status).toBe(403);
  });

  it("rejects malformed preview grant keys before media access", async () => {
    const response = await POST(
      request(
        {
          operation: "open_preview",
          workspaceId: "workspace_home",
          revision: 2,
        },
        "short",
      ),
    );

    expect(response.status).toBe(400);
    expect(mocks.grantRevisionAccess).not.toHaveBeenCalled();
  });

  it("rejects malformed preview workspace IDs as client errors", async () => {
    const response = await POST(
      request(
        {
          operation: "open_preview",
          workspaceId: "invalid",
          revision: 2,
        },
        "invalid-preview-workspace-0001",
      ),
    );

    expect(response.status).toBe(400);
    expect(mocks.loadApplication).not.toHaveBeenCalled();
    expect(mocks.grantRevisionAccess).not.toHaveBeenCalled();
  });

  it("maps a conflicting exact-preview grant replay to 409", async () => {
    mocks.getRevisionWithBookmark.mockResolvedValue({
      workspaceId: "workspace_home",
      revision: 2,
      bookmark: "historical-bookmark",
      definition: { home: { media: [] } },
    });
    mocks.grantRevisionAccess.mockRejectedValue(
      new MediaValidationError("idempotencyKey"),
    );

    const response = await POST(
      request(
        {
          operation: "open_preview",
          workspaceId: "workspace_home",
          revision: 2,
        },
        "conflicting-preview-grant-0001",
      ),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "idempotency_key_conflict",
    });
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
        schemaVersion: "1.2.0",
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
        schemaVersion: "1.2.0",
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
        schemaVersion: "1.2.0",
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
        schemaVersion: "1.2.0",
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
        schemaVersion: "1.2.0",
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
        schemaVersion: "1.2.0",
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
        schemaVersion: "1.2.0",
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
        schemaVersion: "1.2.0",
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
