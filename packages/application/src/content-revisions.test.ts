import { describe, expect, it } from "vitest";

import {
  createDefaultPageSection,
  createBlogPostId,
  createRichTextDocumentFromPlainText,
  createSiteId,
  referenceSiteDefinition,
  toPageComposition,
  type PageSection,
} from "@humber-foundry/site-definition";

import {
  ContentRevisionConflictError,
  ContentRevisionIdempotencyError,
  ContentRevisionStaleError,
  ContentWorkspaceAccessError,
  createContentActorId,
  ContentRevisionValidationError,
  createContentWorkspaceId,
  createContentRevisionApplication,
  createInMemoryMediaContentCoordinator,
  createInMemoryContentRevisionStore,
  isContentRevisionRenderableBy,
} from "./content-revisions";

const editorActorId = createContentActorId("membership-editor");
const collaboratorActorId = createContentActorId(
  "membership-collaborator",
);
const outsiderActorId = createContentActorId("membership-outsider");

const applicationInputs = {
  workspaceId: createContentWorkspaceId("workspace_home"),
  actorId: editorActorId,
  rendererVersion: "renderer-commit-a",
  productionBase: "published:site_foundry_reference@1.1.0",
} as const;

const commandInputs = {
  workspaceId: applicationInputs.workspaceId,
  schemaVersion: "1.3.0",
} as const;

async function createWorkspace(
  application: ReturnType<typeof createContentRevisionApplication>,
  idempotencyKey: string,
) {
  return application.commands.create({
    actorId: editorActorId,
    workspaceId: applicationInputs.workspaceId,
    idempotencyKey,
  });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function legacyRequestHash(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(value)),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

describe("content revision application", () => {
  it("preserves aggregate create and successor invariants in memory", async () => {
    const postId = createBlogPostId(
      "00000000-0000-4000-8000-0000000000cd",
    );
    const post = {
      id: postId,
      revision: 1,
      collectionState: "active" as const,
      targetVisibility: "public" as const,
      slug: "memory-aggregate-invariant",
      title: "Memory aggregate invariant",
      excerpt: "The adapter must preserve command shape.",
      seo: {
        title: "Memory aggregate invariant | Foundry",
        description: "The adapter must preserve command shape.",
      },
      body: createRichTextDocumentFromPlainText("Invariant body."),
    };
    const definitionWithPost = {
      ...referenceSiteDefinition,
      blog: {
        ...referenceSiteDefinition.blog,
        posts: [post],
      },
    };
    const revision = (
      definition: typeof referenceSiteDefinition,
      revisionNumber: number,
    ) => ({
      workspaceId: applicationInputs.workspaceId,
      revision: revisionNumber,
      definition,
      inputs: {
        contentHash: `content-${revisionNumber}`,
        schemaVersion: definition.schemaVersion,
        rendererVersion: applicationInputs.rendererVersion,
        productionBase: applicationInputs.productionBase,
      },
      createdAt: `2026-07-27T10:0${revisionNumber}:00.000Z`,
      createdBy: editorActorId,
    });
    const transition = {
      postId,
      commandType: "blog.post.edit" as const,
      requestId: "memory-aggregate-transition",
      occurredAt: "2026-07-27T10:01:00.000Z",
      revisionId: "00000000-0000-8000-8000-0000000000cd",
      artifact: {} as any,
    };

    const existingStore = createInMemoryContentRevisionStore();
    await existingStore.initialize(
      revision(definitionWithPost, 0),
      editorActorId,
    );
    const existingAggregate =
      await existingStore.getBlogPostAggregate(postId);
    await expect(
      existingStore.persist({
        baseRevision: 0,
        idempotencyKey: "memory-create-existing-aggregate",
        requestHash: "create-existing",
        revision: revision(definitionWithPost, 1),
        blogArtifacts: [],
        blogTransitions: [
          {
            ...transition,
            commandType: "blog.post.create",
            beforeState: null,
            afterState: {
              revision: 1,
              targetVisibility: "public",
            },
            observedAggregate: existingAggregate,
          },
        ],
      }),
    ).rejects.toBeInstanceOf(ContentRevisionConflictError);

    const missingStore = createInMemoryContentRevisionStore();
    await missingStore.initialize(
      revision(referenceSiteDefinition, 0),
      editorActorId,
    );
    await expect(
      missingStore.persist({
        baseRevision: 0,
        idempotencyKey: "memory-successor-missing-aggregate",
        requestHash: "successor-missing",
        revision: revision(definitionWithPost, 1),
        blogArtifacts: [],
        blogTransitions: [
          {
            ...transition,
            beforeState: {
              revision: 1,
              targetVisibility: "public",
            },
            afterState: {
              revision: 2,
              targetVisibility: "public",
            },
            observedAggregate: null,
          },
        ],
      }),
    ).rejects.toBeInstanceOf(ContentRevisionConflictError);
  });

  it("creates and edits a first-class post through immutable site revisions", async () => {
    const store = createInMemoryContentRevisionStore();
    const application = createContentRevisionApplication({
      siteDefinition: referenceSiteDefinition,
      store,
      ...applicationInputs,
    });
    await createWorkspace(application, "create-blog-workspace-0001");
    const postId = createBlogPostId(
      "00000000-0000-4000-8000-000000000001",
    );
    const created = await application.commands.createBlogPost({
      actorId: editorActorId,
      ...commandInputs,
      siteId: referenceSiteDefinition.site.id,
      baseRevision: 0,
      post: {
        id: postId,
        slug: "first-post",
        title: "First post",
        excerpt: "The first post excerpt.",
        seo: {
          title: "First post | Foundry",
          description: "The first post from Foundry.",
        },
        body: createRichTextDocumentFromPlainText("Original body."),
      },
      idempotencyKey: "create-blog-post-0001",
    });
    expect(created.definition.blog.posts[0]).toMatchObject({
      id: postId,
      revision: 1,
      targetVisibility: "public",
      title: "First post",
    });

    const fieldEdited = await application.commands.save({
      actorId: editorActorId,
      ...commandInputs,
      baseRevision: 1,
      edits: [{ path: `${postId}.title`, value: "First post via editor" }],
      idempotencyKey: "edit-blog-post-fields-0001",
    });
    expect(fieldEdited.definition.blog.posts[0]).toMatchObject({
      id: postId,
      revision: 2,
      title: "First post via editor",
    });

    const edited = await application.commands.editBlogPost({
      actorId: editorActorId,
      ...commandInputs,
      siteId: referenceSiteDefinition.site.id,
      baseRevision: 2,
      postId,
      post: {
        slug: "first-post",
        title: "First post, revised",
        excerpt: "The revised excerpt.",
        seo: {
          title: "First post, revised | Foundry",
          description: "The revised first post from Foundry.",
        },
        body: createRichTextDocumentFromPlainText("Revised body."),
      },
      idempotencyKey: "edit-blog-post-0001",
    });
    expect(edited.definition.blog.posts[0]).toMatchObject({
      id: postId,
      revision: 3,
      title: "First post, revised",
    });
    expect(
      (await application.queries.getRevision(1))?.definition.blog.posts[0],
    ).toMatchObject({ revision: 1, title: "First post" });

    await expect(
      application.commands.unpublishBlogPost({
        actorId: editorActorId,
        ...commandInputs,
        siteId: referenceSiteDefinition.site.id,
        baseRevision: 3,
        postId,
        idempotencyKey: "unpublish-blog-post-0001",
      }),
    ).rejects.toMatchObject({
      fields: { blog: "post_not_live" },
    });
    expect(
      (await application.queries.getRevision(2))?.definition.blog.posts[0],
    ).toMatchObject({ revision: 2, title: "First post via editor" });
    await expect(store.getBlogPostAggregate(postId)).resolves.toEqual({
      currentRevision: 1,
      liveRevision: null,
      lastVerifiedRevision: null,
      lastVerifiedVisibility: null,
      version: 1,
    });
  });

  it("unpublishes only a post present in the immutable published base", async () => {
    const postId = createBlogPostId(
      "00000000-0000-4000-8000-000000000002",
    );
    const liveDefinition = {
      ...referenceSiteDefinition,
      blog: {
        ...referenceSiteDefinition.blog,
        posts: [
          {
            id: postId,
            revision: 1,
            collectionState: "active" as const,
            targetVisibility: "public" as const,
            slug: "live-post",
            title: "Live post",
            excerpt: "This post is currently live.",
            seo: {
              title: "Live post | Foundry",
              description: "A live post ready to be unpublished.",
            },
            body: createRichTextDocumentFromPlainText("Live body."),
          },
        ],
      },
    };
    const application = createContentRevisionApplication({
      siteDefinition: liveDefinition,
      store: createInMemoryContentRevisionStore(),
      ...applicationInputs,
    });
    await createWorkspace(application, "create-live-blog-workspace-0001");

    const unpublished = await application.commands.unpublishBlogPost({
      actorId: editorActorId,
      ...commandInputs,
      siteId: liveDefinition.site.id,
      baseRevision: 0,
      postId,
      idempotencyKey: "unpublish-live-blog-post-0001",
    });

    expect(unpublished.definition.blog.posts[0]).toMatchObject({
      id: postId,
      revision: 2,
      targetVisibility: "unpublished",
    });
    expect(
      (await application.queries.getRevision(0))?.definition.blog.posts[0],
    ).toMatchObject({ id: postId, revision: 1, title: "Live post" });
    await expect(
      application.commands.createBlogPost({
        actorId: editorActorId,
        ...commandInputs,
        siteId: liveDefinition.site.id,
        baseRevision: 1,
        post: {
          id: postId,
          slug: "recreated-post",
          title: "Recreated post",
          excerpt: "Identity reuse must fail.",
          seo: {
            title: "Recreated post | Foundry",
            description: "Identity reuse must fail.",
          },
          body: createRichTextDocumentFromPlainText("Recreated body."),
        },
        idempotencyKey: "recreate-unpublished-blog-post",
      }),
    ).rejects.toMatchObject({
      fields: { blog: "post_already_exists" },
    });
    await expect(
      application.commands.republishBlogPost({
        actorId: editorActorId,
        ...commandInputs,
        siteId: liveDefinition.site.id,
        baseRevision: 1,
        postId,
        idempotencyKey: "republish-before-unpublish-verification",
      }),
    ).rejects.toMatchObject({
      fields: { blog: "post_not_unpublished" },
    });

    const publishedWithoutPost = {
      ...liveDefinition,
      blog: { ...liveDefinition.blog, posts: [] },
    };
    const freshApplication = createContentRevisionApplication({
      siteDefinition: publishedWithoutPost,
      initialDefinition: unpublished.definition,
      store: createInMemoryContentRevisionStore(),
      ...applicationInputs,
    });
    await createWorkspace(
      freshApplication,
      "create-hydrated-unpublished-workspace",
    );
    const republished =
      await freshApplication.commands.republishBlogPost({
        actorId: editorActorId,
        ...commandInputs,
        siteId: liveDefinition.site.id,
        baseRevision: 0,
        postId,
        idempotencyKey: "republish-unpublished-blog-post",
      });
    expect(republished.definition.blog.posts[0]).toMatchObject({
      id: postId,
      revision: 3,
      collectionState: "active",
      targetVisibility: "public",
    });
  });

  it("replays blog commands and fails closed for concurrency, invalid schemas, and cross-site IDs", async () => {
    const application = createContentRevisionApplication({
      siteDefinition: referenceSiteDefinition,
      store: createInMemoryContentRevisionStore(),
      ...applicationInputs,
    });
    await createWorkspace(application, "create-blog-workspace-0002");
    const command = {
      actorId: editorActorId,
      ...commandInputs,
      siteId: referenceSiteDefinition.site.id,
      baseRevision: 0,
      post: {
        id: createBlogPostId(
          "00000000-0000-4000-8000-000000000003",
        ),
        slug: "concurrent-post",
        title: "Concurrent post",
        excerpt: "A concurrency test.",
        seo: {
          title: "Concurrent post | Foundry",
          description: "A concurrency test post.",
        },
        body: createRichTextDocumentFromPlainText("Body."),
      },
      idempotencyKey: "create-blog-post-0002",
    } as const;
    const created = await application.commands.createBlogPost(command);
    await expect(application.commands.createBlogPost(command)).resolves.toEqual(
      created,
    );
    await expect(
      application.commands.createBlogPost({
        ...command,
        baseRevision: 1,
        idempotencyKey: "create-blog-post-0003",
      }),
    ).rejects.toMatchObject({
      fields: { blog: "post_already_exists" },
    });
    await expect(
      application.commands.createBlogPost({
        ...command,
        siteId: createSiteId("site_other"),
        baseRevision: 1,
        idempotencyKey: "create-blog-post-0004",
        post: {
          ...command.post,
          id: createBlogPostId(
            "00000000-0000-4000-8000-000000000004",
          ),
        },
      }),
    ).rejects.toMatchObject({
      fields: { blog: "cross_site_identifier" },
    });
    const results = await Promise.allSettled([
      application.commands.editBlogPost({
        ...command,
        baseRevision: 1,
        postId: command.post.id,
        post: { ...command.post, title: "Winner A" },
        idempotencyKey: "edit-blog-concurrent-a",
      }),
      application.commands.editBlogPost({
        ...command,
        baseRevision: 1,
        postId: command.post.id,
        post: { ...command.post, title: "Winner B" },
        idempotencyKey: "edit-blog-concurrent-b",
      }),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(
      1,
    );
    expect(
      (results.find(({ status }) => status === "rejected") as PromiseRejectedResult)
        .reason,
    ).toBeInstanceOf(ContentRevisionConflictError);
  });

  it("keeps reads side-effect free until an explicit create command", async () => {
    const application = createContentRevisionApplication({
      siteDefinition: referenceSiteDefinition,
      store: createInMemoryContentRevisionStore(),
      ...applicationInputs,
    });

    await expect(application.queries.getCurrent()).rejects.toBeInstanceOf(
      ContentWorkspaceAccessError,
    );

    const command = {
      actorId: editorActorId,
      workspaceId: applicationInputs.workspaceId,
      idempotencyKey: "create-workspace-0001",
    } as const;
    const created = await application.commands.create(command);
    const replay = await application.commands.create(command);

    expect(created).toEqual(expect.objectContaining({ revision: 0 }));
    expect(replay).toEqual(created);
    await expect(application.queries.getCurrent()).resolves.toEqual(created);
  });

  it("creates one restored draft from a historical definition across response-loss retries", async () => {
    const historical = structuredClone(referenceSiteDefinition);
    (
      historical.home.sections[0] as {
        title: string;
      }
    ).title = "Historical published headline";
    const store = createInMemoryContentRevisionStore();
    const application = createContentRevisionApplication({
      siteDefinition: referenceSiteDefinition,
      initialDefinition: historical,
      initialCreatedBy: editorActorId,
      store,
      ...applicationInputs,
    });
    const command = {
      actorId: editorActorId,
      workspaceId: applicationInputs.workspaceId,
      idempotencyKey: "restore-response-loss-0001",
    } as const;

    const committedBeforeResponseLoss =
      await application.commands.create(command);
    const retried = await createContentRevisionApplication({
      siteDefinition: referenceSiteDefinition,
      initialDefinition: historical,
      initialCreatedBy: editorActorId,
      store,
      ...applicationInputs,
    }).commands.create(command);

    expect(retried).toEqual(committedBeforeResponseLoss);
    expect(retried).toEqual(
      expect.objectContaining({
        revision: 0,
        createdBy: editorActorId,
        definition: expect.objectContaining({
          home: expect.objectContaining({
            sections: expect.arrayContaining([
              expect.objectContaining({
                title: "Historical published headline",
              }),
            ]),
          }),
        }),
      }),
    );
    await expect(store.getRevision(1)).resolves.toBeNull();
  });

  it("creates an immutable revision for a schema-valid edit", async () => {
    const application = createContentRevisionApplication({
      siteDefinition: referenceSiteDefinition,
      store: createInMemoryContentRevisionStore(),
      ...applicationInputs,
    });
    await createWorkspace(application, "create-workspace-save-0001");

    const saved = await application.commands.save({
      actorId: editorActorId,
      ...commandInputs,
      baseRevision: 0,
      edits: [
        {
          path: "section_hero.title",
          value: "A saved headline",
        },
      ],
      idempotencyKey: "save-section-hero-0001",
    });

    expect(saved.revision).toBe(1);
    expect(saved.definition.home.sections[0]).toEqual(
      expect.objectContaining({ title: "A saved headline" }),
    );
    expect(saved.inputs).toEqual({
      contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      schemaVersion: "1.3.0",
      rendererVersion: "renderer-commit-a",
      productionBase: "published:site_foundry_reference@1.1.0",
    });
    expect(Object.isFrozen(saved)).toBe(true);
    expect(
      isContentRevisionRenderableBy(saved, {
        schemaVersion: "1.3.0",
        rendererVersion: "renderer-commit-a",
        productionBase: applicationInputs.productionBase,
      }),
    ).toBe(true);
    expect(
      isContentRevisionRenderableBy(saved, {
        schemaVersion: "1.3.0",
        rendererVersion: "renderer-commit-b",
        productionBase: applicationInputs.productionBase,
      }),
    ).toBe(false);
    expect(
      isContentRevisionRenderableBy(
        {
          ...saved,
          inputs: { ...saved.inputs, schemaVersion: "1.0.0" },
        },
        {
          schemaVersion: "1.3.0",
          rendererVersion: "renderer-commit-a",
          productionBase: applicationInputs.productionBase,
        },
      ),
    ).toBe(false);
    await expect(application.queries.getRevision(0)).resolves.toEqual(
      expect.objectContaining({ definition: referenceSiteDefinition }),
    );
  });

  it("includes controlled design changes in the canonical revision fingerprint", async () => {
    const application = createContentRevisionApplication({
      siteDefinition: referenceSiteDefinition,
      store: createInMemoryContentRevisionStore(),
      ...applicationInputs,
    });
    const initial = await createWorkspace(
      application,
      "create-workspace-design-hash",
    );

    const saved = await application.commands.save({
      actorId: editorActorId,
      ...commandInputs,
      baseRevision: 0,
      edits: [
        { path: "design.colour.accent", value: "clay" },
        { path: "section_hero.variant", value: "focused" },
      ],
      idempotencyKey: "save-controlled-design-0001",
    });

    expect(saved.definition.design.colour.accent).toBe("clay");
    expect(saved.definition.home.sections[0].variant).toBe("focused");
    expect(saved.inputs.contentHash).not.toBe(initial.inputs.contentHash);
  });

  it("keeps pre-composition request hashes stable for retry compatibility", async () => {
    const baseStore = createInMemoryContentRevisionStore();
    let observedRequestHash = "";
    const store = {
      ...baseStore,
      async replay(idempotencyKey: string, requestHash: string) {
        observedRequestHash = requestHash;
        return baseStore.replay(idempotencyKey, requestHash);
      },
    };
    const application = createContentRevisionApplication({
      siteDefinition: referenceSiteDefinition,
      store,
      ...applicationInputs,
    });
    await createWorkspace(application, "create-workspace-legacy-hash");
    const edits = [{ path: "section_hero.title", value: "Retry me" }];

    await application.commands.save({
      actorId: editorActorId,
      ...commandInputs,
      baseRevision: 0,
      edits,
      idempotencyKey: "legacy-copy-only-save",
    });

    await expect(
      legacyRequestHash({
        actorId: editorActorId,
        workspaceId: commandInputs.workspaceId,
        schemaVersion: commandInputs.schemaVersion,
        baseRevision: 0,
        edits,
      }),
    ).resolves.toBe(observedRequestHash);
  });

  it("creates an immutable revision through the registered page-composition command", async () => {
    const application = createContentRevisionApplication({
      siteDefinition: referenceSiteDefinition,
      store: createInMemoryContentRevisionStore(),
      ...applicationInputs,
    });
    await createWorkspace(application, "create-workspace-compose-0001");
    const composition = {
      ...toPageComposition(referenceSiteDefinition),
      components: [
        ...referenceSiteDefinition.home.sections,
      ] as PageSection[],
    };
    composition.components.splice(
      0,
      1,
      createDefaultPageSection("proof", "section_new_proof"),
    );

    const saved = await application.commands.save({
      actorId: editorActorId,
      ...commandInputs,
      baseRevision: 0,
      edits: [],
      composition,
      idempotencyKey: "compose-page-components-0001",
    });

    expect(saved.revision).toBe(1);
    expect(saved.definition.home.sections.map(({ id }) => id)).toEqual([
      "section_new_proof",
      "section_services",
      "section_proof",
      "section_contact",
    ]);
    await expect(application.queries.getRevision(0)).resolves.toEqual(
      expect.objectContaining({ definition: referenceSiteDefinition }),
    );
  });

  it("rejects a composition-only save with empty required rich text", async () => {
    const application = createContentRevisionApplication({
      siteDefinition: referenceSiteDefinition,
      store: createInMemoryContentRevisionStore(),
      ...applicationInputs,
    });
    await createWorkspace(application, "create-workspace-empty-rich-text");
    const composition = structuredClone(
      toPageComposition(referenceSiteDefinition),
    );
    const callToAction = composition.components.find(
      (section) => section.type === "callToAction",
    );
    if (callToAction?.type !== "callToAction") {
      throw new Error("expected_call_to_action_fixture");
    }
    (
      callToAction as unknown as {
        body: typeof callToAction.body;
      }
    ).body = {
      version: "1.0.0",
      type: "document",
      children: [],
    };

    await expect(
      application.commands.save({
        actorId: editorActorId,
        ...commandInputs,
        baseRevision: 0,
        edits: [],
        composition,
        idempotencyKey: "composition-empty-rich-text",
      }),
    ).rejects.toEqual(
      new ContentRevisionValidationError({
        "section_contact.body": "Enter at least one visible character.",
      }),
    );
    await expect(application.queries.getCurrent()).resolves.toEqual(
      expect.objectContaining({
        revision: 0,
        definition: referenceSiteDefinition,
      }),
    );
  });

  it("combines structural composition with allowed nested copy edits", async () => {
    const application = createContentRevisionApplication({
      siteDefinition: referenceSiteDefinition,
      store: createInMemoryContentRevisionStore(),
      ...applicationInputs,
    });
    await createWorkspace(application, "create-workspace-compose-copy");
    const composition = structuredClone(
      toPageComposition(referenceSiteDefinition),
    );
    const hero = composition.components[0]!;
    if (hero.type !== "hero") {
      throw new Error("expected_hero_fixture");
    }
    (hero.primaryAction as { label: string }).label = "Start here";
    const reorderedComposition = {
      ...composition,
      components: [
        composition.components[1]!,
        composition.components[0]!,
        ...composition.components.slice(2),
      ],
    };

    const saved = await application.commands.save({
      actorId: editorActorId,
      ...commandInputs,
      baseRevision: 0,
      edits: [{ path: "action_start.label", value: "Start here" }],
      composition: reorderedComposition,
      idempotencyKey: "compose-with-nested-copy",
    });

    expect(saved.definition.home.sections[0]?.id).toBe(
      "section_services",
    );
    const savedHero = saved.definition.home.sections[1]!;
    expect(savedHero.type).toBe("hero");
    if (savedHero.type === "hero") {
      expect(savedHero.primaryAction.label).toBe("Start here");
    }
  });

  it("combines authoritative variant edits with structural composition", async () => {
    const application = createContentRevisionApplication({
      siteDefinition: referenceSiteDefinition,
      store: createInMemoryContentRevisionStore(),
      ...applicationInputs,
    });
    await createWorkspace(
      application,
      "create-workspace-compose-variant",
    );
    const composition = structuredClone(
      toPageComposition(referenceSiteDefinition),
    );
    const originalHero = composition.components[0]!;
    if (originalHero.type !== "hero") {
      throw new Error("expected_hero_fixture");
    }
    const hero = { ...originalHero, variant: "focused" as const };
    const added = createDefaultPageSection(
      "proof",
      "section_added_proof",
      referenceSiteDefinition,
    );
    if (added.type !== "proof") {
      throw new Error("expected_proof_fixture");
    }
    const nonDefaultAdded = { ...added, variant: "plain" as const };

    const saved = await application.commands.save({
      actorId: editorActorId,
      ...commandInputs,
      baseRevision: 0,
      edits: [{ path: "section_hero.variant", value: "focused" }],
      composition: {
        ...composition,
        components: [
          composition.components[1]!,
          hero,
          ...composition.components.slice(2),
          nonDefaultAdded,
        ],
      },
      idempotencyKey: "compose-with-variants",
    });

    expect(saved.definition.home.sections[0]?.id).toBe(
      "section_services",
    );
    expect(
      saved.definition.home.sections.find(
        ({ id }) => id === "section_hero",
      )?.variant,
    ).toBe("focused");
    expect(
      saved.definition.home.sections.find(
        ({ id }) => id === "section_added_proof",
      )?.variant,
    ).toBe("plain");
  });

  it("rejects composition outside the registered slot before persistence", async () => {
    const application = createContentRevisionApplication({
      siteDefinition: referenceSiteDefinition,
      store: createInMemoryContentRevisionStore(),
      ...applicationInputs,
    });
    await createWorkspace(application, "create-workspace-compose-0002");

    await expect(
      application.commands.save({
        actorId: editorActorId,
        ...commandInputs,
        baseRevision: 0,
        edits: [],
        composition: {
          slotId: "slot_home_sections",
          components: [
            {
              ...referenceSiteDefinition.home.sections[0],
              type: "script",
            },
          ],
        } as never,
        idempotencyKey: "compose-page-components-0002",
      }),
    ).rejects.toEqual(
      new ContentRevisionValidationError({
        "section_hero.type":
          "This component is not registered for the page slot.",
      }),
    );
  });

  it("binds media occurrence revisions into the immutable content fingerprint", async () => {
    const application = createContentRevisionApplication({
      siteDefinition: referenceSiteDefinition,
      store: createInMemoryContentRevisionStore(),
      ...applicationInputs,
    });
    await createWorkspace(application, "create-workspace-media-0001");

    const first = await application.commands.saveMediaOccurrence({
      actorId: editorActorId,
      ...commandInputs,
      baseRevision: 0,
      occurrence: {
        occurrenceId: "occurrence_home_hero",
        revision: 1,
        asset: {
          assetId: "asset_hero",
          width: 1600,
          height: 900,
          contentType: "image/png",
        },
        crop: null,
      },
      idempotencyKey: "save-media-hero-0001",
    });
    const cropped = await application.commands.saveMediaOccurrence({
      actorId: editorActorId,
      ...commandInputs,
      baseRevision: 1,
      occurrence: {
        ...first.definition.home.media![0]!,
        revision: 2,
        crop: { x: 0.1, y: 0.2, width: 0.5, height: 0.5 },
      },
      idempotencyKey: "save-media-hero-0002",
    });

    expect(first.definition.home.media![0]).toMatchObject({
      occurrenceId: "occurrence_home_hero",
      revision: 1,
      crop: null,
    });
    expect(cropped.definition.home.media![0]).toMatchObject({
      revision: 2,
      crop: { x: 0.1, y: 0.2, width: 0.5, height: 0.5 },
    });
    expect(cropped.inputs.contentHash).not.toBe(first.inputs.contentHash);
    await expect(application.queries.getRevision(1)).resolves.toEqual(
      expect.objectContaining({
        revision: first.revision,
        definition: first.definition,
        inputs: first.inputs,
      }),
    );
  });

  it("rejects a media binding when its occurrence is no longer current", async () => {
    const application = createContentRevisionApplication({
      siteDefinition: referenceSiteDefinition,
      store: createInMemoryContentRevisionStore({
        isMediaOccurrenceCurrent: async () => false,
      }),
      ...applicationInputs,
    });
    await createWorkspace(application, "create-workspace-media-race");

    await expect(
      application.commands.saveMediaOccurrence({
        actorId: editorActorId,
        ...commandInputs,
        baseRevision: 0,
        occurrence: {
          occurrenceId: "occurrence_home_hero",
          revision: 1,
          asset: {
            assetId: "asset_hero",
            width: 1600,
            height: 900,
            contentType: "image/png",
          },
          crop: null,
        },
        idempotencyKey: "save-media-raced-head",
      }),
    ).rejects.toBeInstanceOf(ContentRevisionConflictError);
    await expect(application.queries.getCurrent()).resolves.toMatchObject({
      revision: 0,
    });
  });

  it("serializes a local media head change with content binding", async () => {
    const coordinator = createInMemoryMediaContentCoordinator();
    let signalValidation = () => {};
    const validationStarted = new Promise<void>((resolve) => {
      signalValidation = resolve;
    });
    let releaseValidation = () => {};
    const validationMayFinish = new Promise<void>((resolve) => {
      releaseValidation = resolve;
    });
    const application = createContentRevisionApplication({
      siteDefinition: referenceSiteDefinition,
      store: createInMemoryContentRevisionStore({
        mediaContentCoordinator: coordinator,
        isMediaOccurrenceCurrent: async () => {
          signalValidation();
          await validationMayFinish;
          return true;
        },
      }),
      ...applicationInputs,
    });
    await createWorkspace(application, "create-workspace-media-atomic");

    const contentSave = application.commands.saveMediaOccurrence({
      actorId: editorActorId,
      ...commandInputs,
      baseRevision: 0,
      occurrence: {
        occurrenceId: "occurrence_home_hero",
        revision: 1,
        asset: {
          assetId: "asset_hero",
          width: 1600,
          height: 900,
          contentType: "image/png",
        },
        crop: null,
      },
      idempotencyKey: "save-media-atomic-head",
    });
    await validationStarted;

    let mediaHeadChanged = false;
    const mediaHeadChange = coordinator.runExclusive(async () => {
      mediaHeadChanged = true;
    });
    await Promise.resolve();
    expect(mediaHeadChanged).toBe(false);

    releaseValidation();
    await contentSave;
    await mediaHeadChange;
    expect(mediaHeadChanged).toBe(true);
  });

  it("serializes an ordinary local content save with media validation", async () => {
    const coordinator = createInMemoryMediaContentCoordinator();
    let signalValidation = () => {};
    const validationStarted = new Promise<void>((resolve) => {
      signalValidation = resolve;
    });
    let releaseValidation = () => {};
    const validationMayFinish = new Promise<void>((resolve) => {
      releaseValidation = resolve;
    });
    const application = createContentRevisionApplication({
      siteDefinition: referenceSiteDefinition,
      store: createInMemoryContentRevisionStore({
        mediaContentCoordinator: coordinator,
        isMediaOccurrenceCurrent: async () => {
          signalValidation();
          await validationMayFinish;
          return true;
        },
      }),
      ...applicationInputs,
    });
    await createWorkspace(application, "create-workspace-content-atomic");

    const mediaSave = application.commands.saveMediaOccurrence({
      actorId: editorActorId,
      ...commandInputs,
      baseRevision: 0,
      occurrence: {
        occurrenceId: "occurrence_home_hero",
        revision: 1,
        asset: {
          assetId: "asset_hero",
          width: 1600,
          height: 900,
          contentType: "image/png",
        },
        crop: null,
      },
      idempotencyKey: "save-media-before-copy",
    });
    await validationStarted;

    let copySaveSettled = false;
    const copySave = application.commands
      .save({
        actorId: editorActorId,
        ...commandInputs,
        baseRevision: 0,
        edits: [{ path: "section_hero.title", value: "Concurrent copy" }],
        idempotencyKey: "save-copy-during-media",
      })
      .finally(() => {
        copySaveSettled = true;
      });
    await Promise.resolve();
    expect(copySaveSettled).toBe(false);

    releaseValidation();
    await mediaSave;
    await expect(copySave).rejects.toBeInstanceOf(
      ContentRevisionConflictError,
    );
    await expect(application.queries.getCurrent()).resolves.toMatchObject({
      revision: 1,
      definition: {
        home: {
          media: [
            expect.objectContaining({
              occurrenceId: "occurrence_home_hero",
            }),
          ],
        },
      },
    });
  });

  it("replays one idempotency key without creating another revision", async () => {
    const application = createContentRevisionApplication({
      siteDefinition: referenceSiteDefinition,
      store: createInMemoryContentRevisionStore(),
      ...applicationInputs,
    });
    await createWorkspace(application, "create-workspace-replay-0001");
    const command = {
      actorId: editorActorId,
      ...commandInputs,
      baseRevision: 0,
      edits: [{ path: "section_hero.title", value: "One save" }],
      idempotencyKey: "save-section-hero-0002",
    } as const;

    const first = await application.commands.save(command);
    const replay = await application.commands.save(command);

    expect(replay).toEqual(first);
    await expect(application.queries.getCurrent()).resolves.toEqual(
      expect.objectContaining({ revision: 1 }),
    );
  });

  it("rejects reuse of an idempotency key for different input", async () => {
    const application = createContentRevisionApplication({
      siteDefinition: referenceSiteDefinition,
      store: createInMemoryContentRevisionStore(),
      ...applicationInputs,
    });
    await createWorkspace(application, "create-workspace-conflict-0001");

    await application.commands.save({
      actorId: editorActorId,
      ...commandInputs,
      baseRevision: 0,
      edits: [{ path: "section_hero.title", value: "First input" }],
      idempotencyKey: "save-section-hero-0003",
    });

    await expect(
      application.commands.save({
        actorId: editorActorId,
        ...commandInputs,
        baseRevision: 0,
        edits: [{ path: "section_hero.title", value: "Different input" }],
        idempotencyKey: "save-section-hero-0003",
      }),
    ).rejects.toBeInstanceOf(ContentRevisionIdempotencyError);
  });

  it("returns an explicit conflict for a stale base revision", async () => {
    const application = createContentRevisionApplication({
      siteDefinition: referenceSiteDefinition,
      store: createInMemoryContentRevisionStore(),
      ...applicationInputs,
    });
    await createWorkspace(application, "create-workspace-stale-0001");
    await application.commands.save({
      actorId: editorActorId,
      ...commandInputs,
      baseRevision: 0,
      edits: [{ path: "section_hero.title", value: "First editor" }],
      idempotencyKey: "save-section-hero-0004",
    });

    await expect(
      application.commands.save({
        actorId: editorActorId,
        ...commandInputs,
        baseRevision: 0,
        edits: [{ path: "section_hero.title", value: "Stale editor" }],
        idempotencyKey: "save-section-hero-0005",
      }),
    ).rejects.toEqual(new ContentRevisionConflictError(1));
  });

  it("authorizes workspace collaborators without conflating workspaces", async () => {
    const store = createInMemoryContentRevisionStore();
    const owner = createContentRevisionApplication({
      siteDefinition: referenceSiteDefinition,
      store,
      ...applicationInputs,
    });
    await createWorkspace(owner, "create-workspace-collaborator-0001");
    await owner.commands.addCollaborator(collaboratorActorId);
    const collaborator = createContentRevisionApplication({
      siteDefinition: referenceSiteDefinition,
      store,
      ...applicationInputs,
      actorId: collaboratorActorId,
    });

    await expect(collaborator.queries.getCurrent()).resolves.toEqual(
      expect.objectContaining({ workspaceId: applicationInputs.workspaceId }),
    );

    const outsider = createContentRevisionApplication({
      siteDefinition: referenceSiteDefinition,
      store,
      ...applicationInputs,
      actorId: outsiderActorId,
    });
    await expect(outsider.queries.getCurrent()).rejects.toBeInstanceOf(
      ContentWorkspaceAccessError,
    );
  });

  it("rejects revisions whose production base has gone stale", async () => {
    const store = createInMemoryContentRevisionStore();
    const original = createContentRevisionApplication({
      siteDefinition: referenceSiteDefinition,
      store,
      ...applicationInputs,
    });
    await original.commands.create({
      actorId: editorActorId,
      workspaceId: applicationInputs.workspaceId,
      idempotencyKey: "create-workspace-0002",
    });
    const changedBase = createContentRevisionApplication({
      siteDefinition: referenceSiteDefinition,
      store,
      ...applicationInputs,
      productionBase: "published:site_foundry_reference@2.0.0",
    });

    await expect(
      changedBase.commands.save({
        actorId: editorActorId,
        ...commandInputs,
        baseRevision: 0,
        edits: [{ path: "section_hero.title", value: "Stale base" }],
        idempotencyKey: "save-section-hero-0009",
      }),
    ).rejects.toBeInstanceOf(ContentRevisionStaleError);
  });

  it("acknowledges a replay that became stale after a production-base change", async () => {
    const store = createInMemoryContentRevisionStore();
    const original = createContentRevisionApplication({
      siteDefinition: referenceSiteDefinition,
      store,
      ...applicationInputs,
    });
    await createWorkspace(original, "create-workspace-replay-stale-0001");
    const command = {
      actorId: editorActorId,
      ...commandInputs,
      baseRevision: 0,
      edits: [{ path: "section_hero.title", value: "Recovered save" }],
      idempotencyKey: "save-section-hero-0010",
    } as const;
    const saved = await original.commands.save(command);
    const changedBase = createContentRevisionApplication({
      siteDefinition: referenceSiteDefinition,
      store,
      ...applicationInputs,
      productionBase: "published:site_foundry_reference@2.0.0",
    });

    await expect(changedBase.commands.save(command)).rejects.toEqual(
      expect.objectContaining({
        name: "ContentRevisionStaleError",
        acknowledgedRevision: saved.revision,
      }),
    );
  });

  it("rejects invalid fields with path-keyed feedback", async () => {
    const application = createContentRevisionApplication({
      siteDefinition: referenceSiteDefinition,
      store: createInMemoryContentRevisionStore(),
      ...applicationInputs,
    });
    await createWorkspace(application, "create-workspace-validation-0001");

    await expect(
      application.commands.save({
        actorId: editorActorId,
        ...commandInputs,
        baseRevision: 0,
        edits: [{ path: "section_hero.title", value: "" }],
        idempotencyKey: "save-section-hero-0006",
      }),
    ).rejects.toEqual(
      new ContentRevisionValidationError({
        "section_hero.title": "Enter at least one visible character.",
      }),
    );
  });

  it("rejects mutation metadata from another workspace or schema", async () => {
    const application = createContentRevisionApplication({
      siteDefinition: referenceSiteDefinition,
      store: createInMemoryContentRevisionStore(),
      ...applicationInputs,
    });
    await createWorkspace(application, "create-workspace-metadata-0001");

    await expect(
      application.commands.save({
        actorId: editorActorId,
        workspaceId: createContentWorkspaceId("workspace_other"),
        schemaVersion: "1.3.0",
        baseRevision: 0,
        edits: [{ path: "section_hero.title", value: "Wrong workspace" }],
        idempotencyKey: "save-section-hero-0007",
      }),
    ).rejects.toEqual(
      new ContentRevisionValidationError({
        workspaceId: "This workspace is not available.",
      }),
    );
    await expect(
      application.commands.save({
        actorId: editorActorId,
        workspaceId: applicationInputs.workspaceId,
        schemaVersion: "2.0.0" as "1.3.0",
        baseRevision: 0,
        edits: [{ path: "section_hero.title", value: "Wrong schema" }],
        idempotencyKey: "save-section-hero-0008",
      }),
    ).rejects.toEqual(
      new ContentRevisionValidationError({
        schemaVersion: "Use Site Definition schema 1.3.0.",
      }),
    );
  });

  it("requires explicit creation before a save can claim a workspace", async () => {
    const application = createContentRevisionApplication({
      siteDefinition: referenceSiteDefinition,
      store: createInMemoryContentRevisionStore(),
      ...applicationInputs,
    });

    await expect(
      application.commands.save({
        actorId: editorActorId,
        ...commandInputs,
        baseRevision: 0,
        edits: [{ path: "section_hero.title", value: "Do not create" }],
        idempotencyKey: "save-without-workspace-0001",
      }),
    ).rejects.toBeInstanceOf(ContentWorkspaceAccessError);
    await expect(application.queries.getCurrent()).rejects.toBeInstanceOf(
      ContentWorkspaceAccessError,
    );
  });
});
