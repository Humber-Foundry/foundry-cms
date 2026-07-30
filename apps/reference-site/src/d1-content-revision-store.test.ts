import { readFile } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";

import {
  ContentRevisionConflictError,
  ContentRevisionConfigurationError,
  ContentRevisionBookmarkError,
  ContentRevisionIdempotencyError,
  ContentWorkspaceAccessError,
  createContentActorId,
  createContentRevisionApplication,
  createContentWorkspaceId,
} from "@foundry/application";
import {
  createBlogPostId,
  createRichTextDocumentFromPlainText,
  referenceSiteDefinition,
} from "@foundry/site-definition";

import {
  createD1ContentRevisionStore,
  findContentRevision,
  findLatestContentWorkspaceIdForActor,
  hydrateManagedBlogPosts,
  reconcileVerifiedBlogPostPublication,
} from "./d1-content-revision-store";

describe("D1 content revision store", () => {
  const editorActorId = createContentActorId("membership-editor");
  const collaboratorActorId = createContentActorId(
    "membership-collaborator",
  );
  const outsiderActorId = createContentActorId("membership-outsider");
  const workspaceId = createContentWorkspaceId("workspace_home");
  let miniflare: Miniflare;
  let database: Awaited<ReturnType<Miniflare["getD1Database"]>>;

  beforeEach(async () => {
    miniflare = new Miniflare({
      compatibilityDate: "2026-07-26",
      modules: true,
      script: "export default { fetch() { return new Response('ok') } }",
      d1Databases: ["FOUNDRY_DB"],
    });
    database = await miniflare.getD1Database("FOUNDRY_DB");
    for (const name of [
      "0005_content_revisions.sql",
      "0007_content_publication.sql",
      "0008_media_assets.sql",
      "0011_blog_post_transition_audit.sql",
      "0013_blog_post_verified_state.sql",
      "0014_blog_post_artifact_fingerprints.sql",
      "0015_blog_post_render_artifacts.sql",
    ]) {
      const migration = await readFile(
        new URL(`../migrations/${name}`, import.meta.url),
        "utf8",
      );
      for (const statement of migration.trim().split(/\n\n+/)) {
        await database.prepare(statement).run();
      }
    }
  });

  afterEach(async () => {
    await miniflare.dispose();
  });

  function createApplication(
    actorId = editorActorId,
    targetWorkspaceId = workspaceId,
    now = "2026-07-27T12:00:00.000Z",
    siteDefinition = referenceSiteDefinition,
  ) {
    return createContentRevisionApplication({
      siteDefinition,
      store: createD1ContentRevisionStore(
        database,
        siteDefinition.site.id,
        targetWorkspaceId,
      ),
      workspaceId: targetWorkspaceId,
      actorId,
      rendererVersion: "renderer-test-commit",
      productionBase: "published:site_foundry_reference@1.1.0",
      now: () => now,
    });
  }

  async function createWorkspace(
    application: ReturnType<typeof createApplication>,
    idempotencyKey: string,
  ) {
    return application.commands.create({
      actorId: editorActorId,
      workspaceId: application.workspaceId,
      idempotencyKey,
    });
  }

  it("persists immutable revisions and replays a completed key", async () => {
    const application = createApplication();
    await createWorkspace(application, "d1-content-create-save-0001");
    const command = {
      actorId: editorActorId,
      workspaceId,
      schemaVersion: referenceSiteDefinition.schemaVersion,
      baseRevision: 0,
      edits: [{ path: "section_hero.title", value: "Persisted in D1" }],
      idempotencyKey: "d1-content-save-0001",
    } as const;

    const first = await application.commands.save(command);
    const replay = await application.commands.save(command);
    const stored = await application.queries.getRevision(1, first.bookmark);

    expect(replay).toEqual(
      expect.objectContaining({
        workspaceId: first.workspaceId,
        revision: first.revision,
        definition: first.definition,
        inputs: first.inputs,
      }),
    );
    expect(first.bookmark).not.toBe("");
    expect(stored).toEqual(
      expect.objectContaining({
        workspaceId,
        revision: first.revision,
        definition: first.definition,
      }),
    );
    expect(
      await database
        .prepare("SELECT COUNT(*) AS count FROM content_revisions")
        .first<{ count: number }>(),
    ).toEqual({ count: 2 });
    expect(
      await database
        .prepare("SELECT COUNT(*) AS count FROM content_revision_audit_events")
        .first<{ count: number }>(),
    ).toEqual({ count: 1 });
    expect(
      await database
        .prepare(
          `SELECT owner_actor_id
           FROM content_workspaces
           WHERE workspace_id = ?1`,
        )
        .bind(workspaceId)
        .first<{ owner_actor_id: string }>(),
    ).toEqual({ owner_actor_id: "membership-editor" });
    expect(
      await database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM content_workspace_collaborators
           WHERE workspace_id = ?1`,
        )
        .bind(workspaceId)
        .first<{ count: number }>(),
    ).toEqual({ count: 0 });
  });

  it("loads an immutable revision from its own workspace during global recovery", async () => {
    const firstWorkspaceId = createContentWorkspaceId(
      "workspace_recovery_first",
    );
    const secondWorkspaceId = createContentWorkspaceId(
      "workspace_recovery_second",
    );
    const first = createApplication(
      editorActorId,
      firstWorkspaceId,
    );
    const second = createApplication(
      editorActorId,
      secondWorkspaceId,
    );
    await first.commands.create({
      actorId: editorActorId,
      workspaceId: firstWorkspaceId,
      idempotencyKey: "d1-recovery-first-create",
    });
    await second.commands.create({
      actorId: editorActorId,
      workspaceId: secondWorkspaceId,
      idempotencyKey: "d1-recovery-second-create",
    });
    await first.commands.save({
      actorId: editorActorId,
      workspaceId: firstWorkspaceId,
      schemaVersion: referenceSiteDefinition.schemaVersion,
      baseRevision: 0,
      edits: [{ path: "section_hero.title", value: "First workspace" }],
      idempotencyKey: "d1-recovery-first-save",
    });
    await second.commands.save({
      actorId: editorActorId,
      workspaceId: secondWorkspaceId,
      schemaVersion: referenceSiteDefinition.schemaVersion,
      baseRevision: 0,
      edits: [{ path: "section_hero.title", value: "Second workspace" }],
      idempotencyKey: "d1-recovery-second-save",
    });

    await expect(
      findContentRevision(database, firstWorkspaceId, 1),
    ).resolves.toMatchObject({
      workspaceId: firstWorkspaceId,
      definition: {
        home: {
          sections: [
            expect.objectContaining({
              id: "section_hero",
              title: "First workspace",
            }),
            ...referenceSiteDefinition.home.sections.slice(1),
          ],
        },
      },
    });
    await expect(
      findContentRevision(database, secondWorkspaceId, 1),
    ).resolves.toMatchObject({
      workspaceId: secondWorkspaceId,
      definition: {
        home: {
          sections: [
            expect.objectContaining({
              id: "section_hero",
              title: "Second workspace",
            }),
            ...referenceSiteDefinition.home.sections.slice(1),
          ],
        },
      },
    });
  });

  it("rejects an unpublish whose verified lifecycle changes before persistence", async () => {
    const postId = createBlogPostId(
      "00000000-0000-4000-8000-0000000000ca",
    );
    const definition = {
      ...referenceSiteDefinition,
      blog: {
        ...referenceSiteDefinition.blog,
        posts: [
          {
            id: postId,
            revision: 1,
            collectionState: "active" as const,
            targetVisibility: "public" as const,
            slug: "raced-unpublish",
            title: "Raced unpublish",
            excerpt: "A verified callback races the draft transition.",
            seo: {
              title: "Raced unpublish | Foundry",
              description: "A verified callback races the draft transition.",
            },
            body: createRichTextDocumentFromPlainText("Initially live."),
          },
        ],
      },
    };
    const initial = createApplication(
      editorActorId,
      workspaceId,
      "2026-07-27T12:00:00.000Z",
      definition,
    );
    await createWorkspace(initial, "d1-raced-unpublish-create");
    const durableStore = createD1ContentRevisionStore(
      database,
      definition.site.id,
      workspaceId,
    );
    let lifecycleRaced = false;
    const racingStore = {
      ...durableStore,
      async getBlogPostAggregate(targetPostId: typeof postId) {
        const observed =
          await durableStore.getBlogPostAggregate(targetPostId);
        if (!lifecycleRaced) {
          lifecycleRaced = true;
          await database
            .prepare(
              `UPDATE blog_posts
               SET live_revision = NULL,
                   last_verified_visibility = 'unpublished',
                   last_verified_publication_id = 'publication-raced',
                   last_verified_publication_sequence = 2,
                   version = version + 1,
                   updated_at = ?1
               WHERE site_id = ?2 AND post_id = ?3`,
            )
            .bind(
              "2026-07-27T12:01:00.000Z",
              definition.site.id,
              postId,
            )
            .run();
        }
        return observed;
      },
    };
    const raced = createContentRevisionApplication({
      siteDefinition: definition,
      store: racingStore,
      workspaceId,
      actorId: editorActorId,
      rendererVersion: "renderer-test-commit",
      productionBase: "published:site_foundry_reference@1.1.0",
      now: () => "2026-07-27T12:02:00.000Z",
    });

    await expect(
      raced.commands.unpublishBlogPost({
        actorId: editorActorId,
        workspaceId,
        siteId: definition.site.id,
        schemaVersion: definition.schemaVersion,
        baseRevision: 0,
        postId,
        idempotencyKey: "d1-raced-unpublish-command",
      }),
    ).rejects.toBeInstanceOf(ContentRevisionConflictError);
    await expect(raced.queries.getCurrent()).resolves.toMatchObject({
      revision: 0,
      definition: {
        blog: {
          posts: [
            expect.objectContaining({
              id: postId,
              targetVisibility: "public",
            }),
          ],
        },
      },
    });
  });

  it("preserves create and successor aggregate invariants at persistence", async () => {
    const existingPostId = createBlogPostId(
      "00000000-0000-4000-8000-0000000000cb",
    );
    const createApplicationWithoutPost = createApplication();
    await createWorkspace(
      createApplicationWithoutPost,
      "d1-global-id-create-workspace",
    );
    await database
      .prepare(
        `INSERT INTO blog_posts (
           site_id, post_id, collection_state, current_revision,
           live_revision, last_verified_revision, last_verified_visibility,
           last_verified_publication_id, last_verified_publication_sequence,
           version, updated_at
         ) VALUES (?1, ?2, 'active', 1, NULL, NULL, NULL, NULL, NULL, 1, ?3)`,
      )
      .bind(
        referenceSiteDefinition.site.id,
        existingPostId,
        "2026-07-27T12:05:00.000Z",
      )
      .run();

    await expect(
      createApplicationWithoutPost.commands.createBlogPost({
        actorId: editorActorId,
        workspaceId,
        siteId: referenceSiteDefinition.site.id,
        schemaVersion: referenceSiteDefinition.schemaVersion,
        baseRevision: 0,
        post: {
          id: existingPostId,
          slug: "global-id-collision",
          title: "Global ID collision",
          excerpt: "The stable identity already exists outside this draft.",
          seo: {
            title: "Global ID collision | Foundry",
            description:
              "The stable identity already exists outside this draft.",
          },
          body: createRichTextDocumentFromPlainText("Must conflict."),
        },
        idempotencyKey: "d1-global-id-create-command",
      }),
    ).rejects.toBeInstanceOf(ContentRevisionConflictError);

    const missingPostId = createBlogPostId(
      "00000000-0000-4000-8000-0000000000cc",
    );
    const missingWorkspaceId = createContentWorkspaceId(
      "workspace_missing_successor",
    );
    const definitionWithPost = {
      ...referenceSiteDefinition,
      blog: {
        ...referenceSiteDefinition.blog,
        posts: [
          {
            id: missingPostId,
            revision: 1,
            collectionState: "active" as const,
            targetVisibility: "public" as const,
            slug: "missing-successor",
            title: "Missing successor",
            excerpt: "The draft post has lost its aggregate.",
            seo: {
              title: "Missing successor | Foundry",
              description: "The draft post has lost its aggregate.",
            },
            body: createRichTextDocumentFromPlainText("Original body."),
          },
        ],
      },
    };
    const successorApplication = createApplication(
      editorActorId,
      missingWorkspaceId,
      "2026-07-27T12:06:00.000Z",
      definitionWithPost,
    );
    await database.batch([
      database
        .prepare(
          `INSERT INTO content_workspaces (
             workspace_id, site_id, owner_actor_id, production_base,
             schema_version, renderer_version, current_revision,
             current_content_hash, lifecycle, created_at, updated_at
           ) VALUES (
             ?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, 'open', ?8, ?8
           )`,
        )
        .bind(
          missingWorkspaceId,
          definitionWithPost.site.id,
          editorActorId,
          "published:site_foundry_reference@1.1.0",
          definitionWithPost.schemaVersion,
          "renderer-test-commit",
          "missing-aggregate-content-hash",
          "2026-07-27T12:06:00.000Z",
        ),
      database
        .prepare(
          `INSERT INTO content_revisions (
             workspace_id, revision, definition_json, content_hash,
             schema_version, renderer_version, production_base, request_hash,
             created_at, created_by
           ) VALUES (?1, 0, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
        )
        .bind(
          missingWorkspaceId,
          JSON.stringify(definitionWithPost),
          "missing-aggregate-content-hash",
          definitionWithPost.schemaVersion,
          "renderer-test-commit",
          "published:site_foundry_reference@1.1.0",
          "missing-aggregate-request-hash",
          "2026-07-27T12:06:00.000Z",
          editorActorId,
        ),
    ]);

    await expect(
      successorApplication.commands.save({
        actorId: editorActorId,
        workspaceId: missingWorkspaceId,
        schemaVersion: definitionWithPost.schemaVersion,
        baseRevision: 0,
        edits: [
          {
            path: `${missingPostId}.title`,
            value: "Missing successor, edited",
          },
        ],
        idempotencyKey: "d1-missing-successor-command",
      }),
    ).rejects.toBeInstanceOf(ContentRevisionConflictError);
  });

  it(
    "persists blog revisions, transition audit, and live unpublish history in D1",
    { timeout: 60_000 },
    async () => {
    const application = createApplication();
    await createWorkspace(application, "d1-blog-create-workspace");
    const postId = createBlogPostId(
      "00000000-0000-4000-8000-000000000008",
    );
    await application.commands.createBlogPost({
      actorId: editorActorId,
      workspaceId,
      siteId: referenceSiteDefinition.site.id,
      schemaVersion: referenceSiteDefinition.schemaVersion,
      baseRevision: 0,
      post: {
        id: postId,
        slug: "durable-post",
        title: "Durable post",
        excerpt: "Persisted in D1.",
        seo: {
          title: "Durable post | Foundry",
          description: "A post whose immutable history is persisted in D1.",
        },
        body: createRichTextDocumentFromPlainText("Durable body."),
      },
      idempotencyKey: "d1-blog-create-post",
    });
    await application.commands.save({
      actorId: editorActorId,
      workspaceId,
      schemaVersion: referenceSiteDefinition.schemaVersion,
      baseRevision: 1,
      edits: [{ path: `${postId}.title`, value: "Durable post, edited" }],
      idempotencyKey: "d1-blog-edit-post",
    });
    await expect(
      application.commands.createBlogPost({
        actorId: editorActorId,
        workspaceId,
        siteId: referenceSiteDefinition.site.id,
        schemaVersion: referenceSiteDefinition.schemaVersion,
        baseRevision: 2,
        post: {
          id: postId,
          slug: "durable-post",
          title: "Duplicate durable post",
          excerpt: "This duplicate must fail closed.",
          seo: {
            title: "Duplicate durable post | Foundry",
            description: "This duplicate must fail closed.",
          },
          body: createRichTextDocumentFromPlainText("Duplicate."),
        },
        idempotencyKey: "d1-blog-duplicate-post",
      }),
    ).rejects.toMatchObject({
      fields: { blog: "post_already_exists" },
    });
    await expect(
      application.commands.unpublishBlogPost({
        actorId: editorActorId,
        workspaceId,
        siteId: referenceSiteDefinition.site.id,
        schemaVersion: referenceSiteDefinition.schemaVersion,
        baseRevision: 2,
        postId,
        idempotencyKey: "d1-blog-unpublish-post",
      }),
    ).rejects.toMatchObject({
      fields: { blog: "post_not_live" },
    });

    const reloaded = createApplication();
    await expect(reloaded.queries.getCurrent()).resolves.toMatchObject({
      revision: 2,
      definition: {
        blog: {
          posts: [expect.objectContaining({ id: postId, revision: 2 })],
        },
      },
    });
    await expect(reloaded.queries.getRevision(1)).resolves.toMatchObject({
      definition: {
        blog: {
          posts: [expect.objectContaining({ id: postId, revision: 1 })],
        },
      },
    });
    expect(
      await database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM content_revision_audit_events
           WHERE workspace_id = ?1`,
        )
        .bind(workspaceId)
        .first<{ count: number }>(),
    ).toEqual({ count: 2 });
    expect(
      await database
        .prepare(
          `SELECT command_type, reason_code, request_id, outcome, post_id,
                  before_state_json, after_state_json
           FROM blog_post_transition_audit_events
           WHERE workspace_id = ?1 AND request_id = ?2`,
        )
        .bind(workspaceId, "d1-blog-duplicate-post")
        .first(),
    ).toEqual({
      command_type: "blog.post.create",
      reason_code: "post_already_exists",
      request_id: "d1-blog-duplicate-post",
      outcome: "rejected",
      post_id: postId,
      before_state_json: JSON.stringify({
        revision: 2,
        targetVisibility: "public",
        aggregateRevision: 1,
        liveRevision: null,
        aggregateVersion: 1,
      }),
      after_state_json: JSON.stringify({
        revision: 2,
        targetVisibility: "public",
        aggregateRevision: 1,
        liveRevision: null,
        aggregateVersion: 1,
      }),
    });
    expect(
      await database
        .prepare(
          `SELECT command_type, reason_code
           FROM blog_post_transition_audit_events
           WHERE workspace_id = ?1 AND request_id = ?2`,
        )
        .bind(workspaceId, "d1-blog-unpublish-post")
        .first(),
    ).toEqual({
      command_type: "blog.post.unpublish",
      reason_code: "post_not_live",
    });
    expect(
      await database
        .prepare(
          `SELECT outcome, post_id, before_state_json, after_state_json,
                  revision
           FROM blog_post_transition_audit_events
           WHERE workspace_id = ?1 AND request_id = ?2`,
        )
        .bind(workspaceId, "d1-blog-create-post")
        .first(),
    ).toEqual({
      outcome: "accepted",
      post_id: postId,
      before_state_json: null,
      after_state_json: JSON.stringify({
        revision: 1,
        targetVisibility: "public",
      }),
      revision: 1,
    });
    expect(
      await database
        .prepare(
          `SELECT command_type, outcome, post_id, before_state_json,
                  after_state_json, revision
           FROM blog_post_transition_audit_events
           WHERE workspace_id = ?1 AND request_id = ?2`,
        )
        .bind(workspaceId, "d1-blog-edit-post")
        .first(),
    ).toEqual({
      command_type: "blog.post.edit",
      outcome: "accepted",
      post_id: postId,
      before_state_json: JSON.stringify({
        revision: 1,
        targetVisibility: "public",
      }),
      after_state_json: JSON.stringify({
        revision: 2,
        targetVisibility: "public",
      }),
      revision: 2,
    });

    await expect(
      hydrateManagedBlogPosts(database, referenceSiteDefinition),
    ).resolves.toMatchObject({ blog: { posts: [] } });
    const current = await reloaded.queries.getCurrent();
    await reconcileVerifiedBlogPostPublication(
      database,
      referenceSiteDefinition.site.id,
      current.definition,
      { id: "publication-blog-live", sequence: 1 },
      "2026-07-27T12:30:00.000Z",
    );

    await database.batch([
      database.prepare(
        `INSERT INTO content_approvals (
           id, workspace_id, revision, fingerprint, channel,
           channel_configuration_hash, content_hash, design_hash,
           schema_version, renderer_version, production_base,
           artifact_hash, serialization_version, approved_by, approved_at
         ) VALUES (
           'approval_blog_in_progress', ?1, 2, ?2, 'site', 'channel',
           ?2, ?2, '1.3.0', 'renderer-test-commit',
           'published:site_foundry_reference@1.1.0', ?2,
           'foundry.site-publication-artifacts.v2', ?3, ?4
         )`,
      ).bind(
        workspaceId,
        "a".repeat(64),
        editorActorId,
        "2026-07-27T12:31:00.000Z",
      ),
      database.prepare(
        `INSERT INTO content_publications (
           id, workspace_id, revision, approval_id, fingerprint,
           idempotency_key, command_identity, requested_by,
           contributors_json, expected_head, status, commit_sha,
           deployment_id, deployment_requested_at, detail, lease_token,
           lease_expires_at, requested_at, updated_at, mutation_token
         ) VALUES (
           'publish_blog_in_progress', ?1, 2, 'approval_blog_in_progress',
           ?2, 'publish-blog-in-progress', '{}', ?3, '[]', ?4, 'building',
           ?4, NULL, NULL, NULL, NULL, NULL, ?5, ?5, 'mutation-blog'
         )`,
      ).bind(
        workspaceId,
        "a".repeat(64),
        editorActorId,
        "b".repeat(40),
        "2026-07-27T12:32:00.000Z",
      ),
    ]);
    await expect(
      reloaded.commands.save({
        actorId: editorActorId,
        workspaceId,
        schemaVersion: referenceSiteDefinition.schemaVersion,
        baseRevision: 2,
        edits: [
          {
            path: `${postId}.title`,
            value: "Durable post, edited during publication",
          },
        ],
        idempotencyKey: "d1-blog-edit-during-publication",
      }),
    ).resolves.toMatchObject({
      revision: 3,
      definition: {
        blog: {
          posts: [
            expect.objectContaining({
              id: postId,
              revision: 3,
              title: "Durable post, edited during publication",
            }),
          ],
        },
      },
    });
    await expect(
      reloaded.commands.unpublishBlogPost({
        actorId: editorActorId,
        workspaceId,
        siteId: referenceSiteDefinition.site.id,
        schemaVersion: referenceSiteDefinition.schemaVersion,
        baseRevision: 3,
        postId,
        idempotencyKey: "d1-blog-unpublish-conflicting-publication",
      }),
    ).rejects.toBeInstanceOf(ContentRevisionConflictError);
    await database
      .prepare(
        `UPDATE content_publications
         SET status = 'failed', updated_at = ?1
         WHERE id = 'publish_blog_in_progress'`,
      )
      .bind("2026-07-27T12:33:00.000Z")
      .run();

    const unpublishedRevision =
      await reloaded.commands.unpublishBlogPost({
        actorId: editorActorId,
        workspaceId,
        siteId: referenceSiteDefinition.site.id,
        schemaVersion: referenceSiteDefinition.schemaVersion,
        baseRevision: 3,
        postId,
        idempotencyKey: "d1-live-blog-unpublish-post",
      });

    await expect(reloaded.queries.getCurrent()).resolves.toMatchObject({
      revision: 4,
      definition: {
        blog: {
          posts: [
            expect.objectContaining({
              id: postId,
              revision: 4,
              targetVisibility: "unpublished",
            }),
          ],
        },
      },
    });
    await expect(reloaded.queries.getRevision(3)).resolves.toMatchObject({
      definition: {
        blog: {
          posts: [
            expect.objectContaining({
              id: postId,
              revision: 3,
              targetVisibility: "public",
            }),
          ],
        },
      },
    });
    await reconcileVerifiedBlogPostPublication(
      database,
      referenceSiteDefinition.site.id,
      unpublishedRevision.definition,
      { id: "publication-blog-unpublished", sequence: 2 },
      "2026-07-27T13:00:00.000Z",
    );
    await expect(
      reloaded.commands.unpublishBlogPost({
        actorId: editorActorId,
        workspaceId,
        siteId: referenceSiteDefinition.site.id,
        schemaVersion: referenceSiteDefinition.schemaVersion,
        baseRevision: 3,
        postId,
        idempotencyKey: "d1-live-blog-unpublish-post",
      }),
    ).resolves.toMatchObject({
      revision: unpublishedRevision.revision,
      definition: unpublishedRevision.definition,
      createdBy: unpublishedRevision.createdBy,
      createdAt: unpublishedRevision.createdAt,
    });
    await reconcileVerifiedBlogPostPublication(
      database,
      referenceSiteDefinition.site.id,
      current.definition,
      { id: "publication-blog-live", sequence: 1 },
      "2026-07-27T13:00:00.000Z",
    );
    expect(
      await database
        .prepare(
          `SELECT live_revision, last_verified_revision
           FROM blog_posts
           WHERE site_id = ?1 AND post_id = ?2`,
        )
        .bind(referenceSiteDefinition.site.id, postId)
        .first(),
    ).toEqual({ live_revision: null, last_verified_revision: 4 });
    expect(
      await database
        .prepare(
          `SELECT outcome, post_id, before_state_json, after_state_json,
                  revision
           FROM blog_post_transition_audit_events
           WHERE workspace_id = ?1 AND request_id = ?2`,
        )
        .bind(workspaceId, "d1-live-blog-unpublish-post")
        .first(),
    ).toEqual({
      outcome: "accepted",
      post_id: postId,
      before_state_json: JSON.stringify({
        revision: 3,
        targetVisibility: "public",
      }),
      after_state_json: JSON.stringify({
        revision: 4,
        targetVisibility: "unpublished",
      }),
      revision: 4,
    });

    const hydrated = await hydrateManagedBlogPosts(
      database,
      referenceSiteDefinition,
    );
    expect(hydrated.blog.posts).toEqual([
      expect.objectContaining({
        id: postId,
        revision: 4,
        targetVisibility: "unpublished",
      }),
    ]);
    const republishWorkspaceId = createContentWorkspaceId(
      "workspace_republish_blog",
    );
    const republishApplication = createContentRevisionApplication({
      siteDefinition: referenceSiteDefinition,
      initialDefinition: hydrated,
      store: createD1ContentRevisionStore(
        database,
        referenceSiteDefinition.site.id,
        republishWorkspaceId,
      ),
      workspaceId: republishWorkspaceId,
      actorId: editorActorId,
      rendererVersion: "renderer-test-commit",
      productionBase: "published:site_foundry_reference@1.3.0",
      now: () => "2026-07-27T13:10:00.000Z",
    });
    await republishApplication.commands.create({
      actorId: editorActorId,
      workspaceId: republishWorkspaceId,
      idempotencyKey: "d1-republish-create-workspace",
    });
    await expect(
      republishApplication.commands.save({
        actorId: editorActorId,
        workspaceId: republishWorkspaceId,
        schemaVersion: referenceSiteDefinition.schemaVersion,
        baseRevision: 0,
        edits: [
          {
            path: `${postId}.title`,
            value: "Edited while verified unpublished",
          },
        ],
        idempotencyKey: "d1-edit-verified-unpublished-post",
      }),
    ).resolves.toMatchObject({
      revision: 1,
      definition: {
        blog: {
          posts: [
            expect.objectContaining({
              revision: 5,
              targetVisibility: "unpublished",
            }),
          ],
        },
      },
    });
    const republished =
      await republishApplication.commands.republishBlogPost({
        actorId: editorActorId,
        workspaceId: republishWorkspaceId,
        siteId: referenceSiteDefinition.site.id,
        schemaVersion: referenceSiteDefinition.schemaVersion,
        baseRevision: 1,
        postId,
        idempotencyKey: "d1-republish-blog-post",
      });
    expect(republished).toMatchObject({
      revision: 2,
      definition: {
        blog: {
          posts: [
            expect.objectContaining({
              id: postId,
              revision: 6,
              targetVisibility: "public",
            }),
          ],
        },
      },
    });
    await reconcileVerifiedBlogPostPublication(
      database,
      referenceSiteDefinition.site.id,
      republished.definition,
      { id: "publication-blog-republished", sequence: 3 },
      "2026-07-27T13:20:00.000Z",
    );
    await expect(
      republishApplication.commands.republishBlogPost({
        actorId: editorActorId,
        workspaceId: republishWorkspaceId,
        siteId: referenceSiteDefinition.site.id,
        schemaVersion: referenceSiteDefinition.schemaVersion,
        baseRevision: 1,
        postId,
        idempotencyKey: "d1-republish-blog-post",
      }),
    ).resolves.toMatchObject({
      revision: republished.revision,
      definition: republished.definition,
      createdBy: republished.createdBy,
      createdAt: republished.createdAt,
    });
    await reconcileVerifiedBlogPostPublication(
      database,
      referenceSiteDefinition.site.id,
      referenceSiteDefinition,
      { id: "publication-blog-restored-without-post", sequence: 4 },
      "2026-07-27T13:30:00.000Z",
    );
    expect(
      await database
        .prepare(
          `SELECT live_revision, last_verified_visibility
           FROM blog_posts
           WHERE site_id = ?1 AND post_id = ?2`,
        )
        .bind(referenceSiteDefinition.site.id, postId)
        .first(),
    ).toEqual({
      live_revision: null,
      last_verified_visibility: "absent",
    });
    const restoredAfterAbsence = await hydrateManagedBlogPosts(
      database,
      referenceSiteDefinition,
    );
    expect(restoredAfterAbsence).toMatchObject({
      blog: {
        posts: [
          expect.objectContaining({
            id: postId,
            revision: 7,
            targetVisibility: "unpublished",
          }),
        ],
      },
    });
    const absentRecoveryWorkspaceId = createContentWorkspaceId(
      "workspace_absent_blog_recovery",
    );
    const absentRecoveryApplication = createContentRevisionApplication({
      siteDefinition: referenceSiteDefinition,
      initialDefinition: restoredAfterAbsence,
      store: createD1ContentRevisionStore(
        database,
        referenceSiteDefinition.site.id,
        absentRecoveryWorkspaceId,
      ),
      workspaceId: absentRecoveryWorkspaceId,
      actorId: editorActorId,
      rendererVersion: "renderer-test-commit",
      productionBase: "published:site_foundry_reference@1.3.0",
      now: () => "2026-07-27T13:40:00.000Z",
    });
    await absentRecoveryApplication.commands.create({
      actorId: editorActorId,
      workspaceId: absentRecoveryWorkspaceId,
      idempotencyKey: "d1-create-absent-recovery-workspace",
    });
    await expect(
      absentRecoveryApplication.commands.save({
        actorId: editorActorId,
        workspaceId: absentRecoveryWorkspaceId,
        schemaVersion: referenceSiteDefinition.schemaVersion,
        baseRevision: 0,
        edits: [
          {
            path: `${postId}.title`,
            value: "Edited only in the recovery workspace",
          },
        ],
        idempotencyKey: "d1-edit-recovered-absent-post",
      }),
    ).resolves.toMatchObject({
      revision: 1,
      definition: {
        blog: {
          posts: [
            expect.objectContaining({
              id: postId,
              revision: 8,
              targetVisibility: "unpublished",
            }),
          ],
        },
      },
    });
    await expect(
      hydrateManagedBlogPosts(database, referenceSiteDefinition),
    ).resolves.toMatchObject({ blog: { posts: [] } });
    await expect(
      absentRecoveryApplication.commands.republishBlogPost({
        actorId: editorActorId,
        workspaceId: absentRecoveryWorkspaceId,
        siteId: referenceSiteDefinition.site.id,
        schemaVersion: referenceSiteDefinition.schemaVersion,
        baseRevision: 1,
        postId,
        idempotencyKey: "d1-republish-restored-absent-post",
      }),
    ).resolves.toMatchObject({
      revision: 2,
      definition: {
        blog: {
          posts: [
            expect.objectContaining({
              id: postId,
              revision: 9,
              targetVisibility: "public",
            }),
          ],
        },
      },
    });
    expect(
      await database
        .prepare(
          `SELECT snapshot_json, revision_id AS post_revision_id, content_hash,
                  schema_version, renderer_version, serialization_version,
                  rendered_bytes_hash, artifact_fingerprint
           FROM blog_post_revisions
           WHERE site_id = ?1 AND post_id = ?2 AND revision = 6`,
        )
        .bind(referenceSiteDefinition.site.id, postId)
        .first<{
          snapshot_json: string;
          post_revision_id: string;
          content_hash: string;
          schema_version: string;
          renderer_version: string;
          serialization_version: string;
          rendered_bytes_hash: string;
          artifact_fingerprint: string;
        }>(),
    ).toMatchObject({
      snapshot_json: expect.stringContaining('"targetVisibility":"public"'),
      post_revision_id: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      ),
      content_hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      schema_version: referenceSiteDefinition.schemaVersion,
      renderer_version: "renderer-test-commit",
      serialization_version: "foundry.post-artifact.v1",
      rendered_bytes_hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      artifact_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    },
  );

  it("reconciles more posts than D1's bound-parameter limit", async () => {
    const posts = Array.from({ length: 101 }, (_, index) => {
      const suffix = (index + 1).toString(16).padStart(12, "0");
      return {
        id: createBlogPostId(`00000000-0000-4000-8000-${suffix}`),
        revision: 1,
        collectionState: "active" as const,
        targetVisibility: "public" as const,
        slug: `post-${index + 1}`,
        title: `Post ${index + 1}`,
        excerpt: `Excerpt ${index + 1}`,
        seo: {
          title: `Post ${index + 1} | Foundry`,
          description: `Excerpt ${index + 1}`,
        },
        body: createRichTextDocumentFromPlainText(`Body ${index + 1}.`),
      };
    });
    const definition = {
      ...referenceSiteDefinition,
      blog: { ...referenceSiteDefinition.blog, posts },
    };
    const manyPostsWorkspaceId = createContentWorkspaceId(
      "workspace_many_blog_posts",
    );
    const application = createApplication(
      editorActorId,
      manyPostsWorkspaceId,
      "2026-07-27T14:00:00.000Z",
      definition,
    );
    await application.commands.create({
      actorId: editorActorId,
      workspaceId: manyPostsWorkspaceId,
      idempotencyKey: "d1-create-many-blog-posts",
    });
    await application.commands.save({
      actorId: editorActorId,
      workspaceId: manyPostsWorkspaceId,
      schemaVersion: definition.schemaVersion,
      baseRevision: 0,
      edits: [{ path: "design.colour.accent", value: "clay" }],
      idempotencyKey: "d1-save-many-blog-artifacts",
    });

    await expect(
      reconcileVerifiedBlogPostPublication(
        database,
        referenceSiteDefinition.site.id,
        definition,
        { id: "publication-many-blog-posts", sequence: 1 },
        "2026-07-27T14:10:00.000Z",
      ),
    ).resolves.toBeUndefined();
  });

  it("reconciles a verified legacy revision without blog data as an empty blog", async () => {
    const postId = createBlogPostId(
      "00000000-0000-4000-8000-0000000000ac",
    );
    await database
      .prepare(
        `INSERT INTO blog_posts (
           site_id, post_id, collection_state, current_revision,
           live_revision, last_verified_revision, last_verified_visibility,
           last_verified_publication_id, last_verified_publication_sequence,
           version, updated_at
         ) VALUES (?1, ?2, 'active', 1, 1, 1, 'public', ?3, 1, 1, ?4)`,
      )
      .bind(
        referenceSiteDefinition.site.id,
        postId,
        "publication-modern-with-blog",
        "2026-07-27T14:14:00.000Z",
      )
      .run();
    const legacyDefinition = structuredClone(referenceSiteDefinition) as any;
    legacyDefinition.definitionVersion = "1.2.0";
    legacyDefinition.schemaVersion = "1.2.0";
    delete legacyDefinition.blog;

    await expect(
      reconcileVerifiedBlogPostPublication(
        database,
        referenceSiteDefinition.site.id,
        legacyDefinition,
        { id: "publication-legacy-without-blog", sequence: 2 },
        "2026-07-27T14:15:00.000Z",
      ),
    ).resolves.toBeUndefined();

    await expect(
      database
        .prepare(
          `SELECT live_revision, last_verified_visibility,
                  last_verified_publication_id,
                  last_verified_publication_sequence
           FROM blog_posts
           WHERE site_id = ?1 AND post_id = ?2`,
        )
        .bind(referenceSiteDefinition.site.id, postId)
        .first(),
    ).resolves.toEqual({
      live_revision: null,
      last_verified_visibility: "absent",
      last_verified_publication_id: "publication-legacy-without-blog",
      last_verified_publication_sequence: 2,
    });
  });

  it("fails closed when a current verified revision has no blog data", async () => {
    const invalidDefinition = structuredClone(
      referenceSiteDefinition,
    ) as any;
    delete invalidDefinition.blog;

    await expect(
      reconcileVerifiedBlogPostPublication(
        database,
        referenceSiteDefinition.site.id,
        invalidDefinition,
        { id: "publication-current-without-blog", sequence: 1 },
        "2026-07-27T14:16:00.000Z",
      ),
    ).rejects.toBeInstanceOf(ContentRevisionConfigurationError);
  });

  it("does not let delayed publication resurrect a newer absence", async () => {
    const postId = createBlogPostId(
      "00000000-0000-4000-8000-0000000000dd",
    );
    const post = {
      id: postId,
      revision: 1,
      collectionState: "active" as const,
      targetVisibility: "public" as const,
      slug: "ordered-absence",
      title: "Ordered absence",
      excerpt: "Newer verified absence must win.",
      seo: {
        title: "Ordered absence | Foundry",
        description: "Newer verified absence must win.",
      },
      body: createRichTextDocumentFromPlainText("Publication ordering."),
    };
    const publishedDefinition = {
      ...referenceSiteDefinition,
      blog: { ...referenceSiteDefinition.blog, posts: [post] },
    };
    const orderedWorkspaceId = createContentWorkspaceId(
      "workspace_ordered_absence",
    );
    const application = createApplication(
      editorActorId,
      orderedWorkspaceId,
      "2026-07-27T14:20:00.000Z",
      publishedDefinition,
    );
    await application.commands.create({
      actorId: editorActorId,
      workspaceId: orderedWorkspaceId,
      idempotencyKey: "d1-create-ordered-absence",
    });
    await reconcileVerifiedBlogPostPublication(
      database,
      referenceSiteDefinition.site.id,
      publishedDefinition,
      { id: "publication-ordered-1", sequence: 1 },
      "2026-07-27T14:20:00.000Z",
    );
    await reconcileVerifiedBlogPostPublication(
      database,
      referenceSiteDefinition.site.id,
      referenceSiteDefinition,
      { id: "publication-ordered-2", sequence: 2 },
      "2026-07-27T14:21:00.000Z",
    );
    await reconcileVerifiedBlogPostPublication(
      database,
      referenceSiteDefinition.site.id,
      referenceSiteDefinition,
      { id: "publication-ordered-4", sequence: 4 },
      "2026-07-27T14:23:00.000Z",
    );
    await reconcileVerifiedBlogPostPublication(
      database,
      referenceSiteDefinition.site.id,
      publishedDefinition,
      { id: "publication-ordered-3", sequence: 3 },
      "2026-07-27T14:22:00.000Z",
    );

    await expect(
      database
        .prepare(
          `SELECT live_revision, last_verified_visibility,
                  last_verified_publication_id,
                  last_verified_publication_sequence
           FROM blog_posts
           WHERE site_id = ?1 AND post_id = ?2`,
        )
        .bind(referenceSiteDefinition.site.id, postId)
        .first(),
    ).resolves.toEqual({
      live_revision: null,
      last_verified_visibility: "absent",
      last_verified_publication_id: "publication-ordered-4",
      last_verified_publication_sequence: 4,
    });
  });

  it("reconciles the first verified removal of a bundled live post", async () => {
    const postId = createBlogPostId(
      "00000000-0000-4000-8000-0000000000ee",
    );
    await database
      .prepare(
        `INSERT INTO blog_posts (
           site_id, post_id, collection_state, current_revision,
           live_revision, last_verified_revision, last_verified_visibility,
           last_verified_publication_id, last_verified_publication_sequence,
           version, updated_at
         ) VALUES (?1, ?2, 'active', 1, 1, 1, 'public', NULL, NULL, 1, ?3)`,
      )
      .bind(
        referenceSiteDefinition.site.id,
        postId,
        "2026-07-27T14:30:00.000Z",
      )
      .run();

    await reconcileVerifiedBlogPostPublication(
      database,
      referenceSiteDefinition.site.id,
      referenceSiteDefinition,
      { id: "publication-first-removal", sequence: 1 },
      "2026-07-27T14:31:00.000Z",
    );

    await expect(
      database
        .prepare(
          `SELECT live_revision, last_verified_visibility,
                  last_verified_publication_id,
                  last_verified_publication_sequence
           FROM blog_posts
           WHERE site_id = ?1 AND post_id = ?2`,
        )
        .bind(referenceSiteDefinition.site.id, postId)
        .first(),
    ).resolves.toEqual({
      live_revision: null,
      last_verified_visibility: "absent",
      last_verified_publication_id: "publication-first-removal",
      last_verified_publication_sequence: 1,
    });
  });

  it("preserves a render artifact for each site revision", async () => {
    const postId = createBlogPostId(
      "00000000-0000-4000-8000-0000000000cc",
    );
    const post = {
      id: postId,
      revision: 1,
      collectionState: "active" as const,
      targetVisibility: "public" as const,
      slug: "shared-render-inputs",
      title: "Shared render inputs",
      excerpt: "The post content remains unchanged.",
      seo: {
        title: "Shared render inputs | Foundry",
        description: "The post content remains unchanged.",
      },
      body: createRichTextDocumentFromPlainText("Unchanged post body."),
    };
    const definition = {
      ...referenceSiteDefinition,
      blog: { ...referenceSiteDefinition.blog, posts: [post] },
    };
    const artifactWorkspaceId = createContentWorkspaceId(
      "workspace_blog_render_artifacts",
    );
    const application = createApplication(
      editorActorId,
      artifactWorkspaceId,
      "2026-07-27T15:00:00.000Z",
      definition,
    );
    await application.commands.create({
      actorId: editorActorId,
      workspaceId: artifactWorkspaceId,
      idempotencyKey: "d1-create-blog-render-artifacts",
    });
    await application.commands.save({
      actorId: editorActorId,
      workspaceId: artifactWorkspaceId,
      schemaVersion: definition.schemaVersion,
      baseRevision: 0,
      edits: [{ path: "design.colour.accent", value: "clay" }],
      idempotencyKey: "d1-change-shared-blog-render-input",
    });

    const artifacts = await database
      .prepare(
        `SELECT content_revision, post_revision, content_hash,
                rendered_bytes_hash, artifact_fingerprint
         FROM blog_post_render_artifacts
         WHERE workspace_id = ?1 AND post_id = ?2
         ORDER BY content_revision`,
      )
      .bind(artifactWorkspaceId, postId)
      .all<{
        content_revision: number;
        post_revision: number;
        content_hash: string;
        rendered_bytes_hash: string;
        artifact_fingerprint: string;
      }>();
    expect(artifacts.results).toHaveLength(2);
    expect(
      artifacts.results.map(
        ({ content_revision }: { content_revision: number }) =>
          content_revision,
      ),
    ).toEqual([0, 1]);
    expect(artifacts.results[0]!.post_revision).toBe(1);
    expect(artifacts.results[1]!.post_revision).toBe(1);
    expect(artifacts.results[1]!.content_hash).toBe(
      artifacts.results[0]!.content_hash,
    );
    expect(artifacts.results[1]!.rendered_bytes_hash).not.toBe(
      artifacts.results[0]!.rendered_bytes_hash,
    );
    expect(artifacts.results[1]!.artifact_fingerprint).not.toBe(
      artifacts.results[0]!.artifact_fingerprint,
    );
  });

  it("allows parallel workspaces to branch from a shared post revision", async () => {
    const postId = createBlogPostId(
      "00000000-0000-4000-8000-00000000000b",
    );
    const definition = {
      ...referenceSiteDefinition,
      blog: {
        ...referenceSiteDefinition.blog,
        posts: [
          {
            id: postId,
            revision: 1,
            collectionState: "active" as const,
            targetVisibility: "public" as const,
            slug: "shared-post",
            title: "Shared post",
            excerpt: "One aggregate shared across workspaces.",
            seo: {
              title: "Shared post | Foundry",
              description: "One aggregate shared across workspaces.",
            },
            body: createRichTextDocumentFromPlainText("Shared body."),
          },
        ],
      },
    };
    const otherWorkspaceId = createContentWorkspaceId(
      "workspace_shared_blog_other",
    );
    const first = createApplication(
      editorActorId,
      workspaceId,
      "2026-07-27T14:00:00.000Z",
      definition,
    );
    const second = createApplication(
      editorActorId,
      otherWorkspaceId,
      "2026-07-27T14:00:00.000Z",
      definition,
    );
    await createWorkspace(first, "d1-shared-blog-create-first");
    await createWorkspace(second, "d1-shared-blog-create-second");

    const results = await Promise.allSettled([
      first.commands.save({
        actorId: editorActorId,
        workspaceId,
        schemaVersion: definition.schemaVersion,
        baseRevision: 0,
        edits: [{ path: `${postId}.title`, value: "First edit" }],
        idempotencyKey: "d1-shared-blog-edit-first",
      }),
      second.commands.save({
        actorId: editorActorId,
        workspaceId: otherWorkspaceId,
        schemaVersion: definition.schemaVersion,
        baseRevision: 0,
        edits: [{ path: `${postId}.title`, value: "Second edit" }],
        idempotencyKey: "d1-shared-blog-edit-second",
      }),
    ]);

    expect(results).toEqual([
      expect.objectContaining({
        status: "fulfilled",
        value: expect.objectContaining({
          definition: expect.objectContaining({
            blog: expect.objectContaining({
              posts: [
                expect.objectContaining({
                  revision: 2,
                  title: "First edit",
                }),
              ],
            }),
          }),
        }),
      }),
      expect.objectContaining({
        status: "fulfilled",
        value: expect.objectContaining({
          definition: expect.objectContaining({
            blog: expect.objectContaining({
              posts: [
                expect.objectContaining({
                  revision: 2,
                  title: "Second edit",
                }),
              ],
            }),
          }),
        }),
      }),
    ]);
    expect(
      await database
        .prepare(
          `SELECT current_revision, live_revision, version
           FROM blog_posts
           WHERE site_id = ?1 AND post_id = ?2`,
        )
        .bind(definition.site.id, postId)
        .first(),
    ).toEqual({ current_revision: 1, live_revision: 1, version: 1 });
    expect(
      await database
        .prepare(
          `SELECT COUNT(*) AS count, COUNT(DISTINCT revision_id) AS ids,
                  COUNT(DISTINCT content_hash) AS contents
           FROM blog_post_revisions
           WHERE site_id = ?1 AND post_id = ?2`,
        )
        .bind(definition.site.id, postId)
        .first(),
    ).toEqual({ count: 3, ids: 3, contents: 3 });
  });

  it("fails verified-live reconciliation when a post aggregate is missing", async () => {
    const missingPostDefinition = {
      ...referenceSiteDefinition,
      blog: {
        ...referenceSiteDefinition.blog,
        posts: [
          {
            id: createBlogPostId(
              "00000000-0000-4000-8000-00000000000d",
            ),
            revision: 1,
            collectionState: "active" as const,
            targetVisibility: "public" as const,
            slug: "missing-aggregate",
            title: "Missing aggregate",
            excerpt: "The callback must not silently succeed.",
            seo: {
              title: "Missing aggregate | Foundry",
              description: "The callback must not silently succeed.",
            },
            body: createRichTextDocumentFromPlainText("Missing."),
          },
        ],
      },
    };

    await expect(
      reconcileVerifiedBlogPostPublication(
        database,
        referenceSiteDefinition.site.id,
        missingPostDefinition,
        { id: "publication-missing-aggregate", sequence: 1 },
        "2026-07-27T15:00:00.000Z",
      ),
    ).rejects.toBeInstanceOf(ContentRevisionConfigurationError);
  });

  it("fails verified-live reconciliation before mutating an aggregate whose immutable revision is missing", async () => {
    const postId = createBlogPostId(
      "00000000-0000-4000-8000-00000000000e",
    );
    const missingRevisionDefinition = {
      ...referenceSiteDefinition,
      blog: {
        ...referenceSiteDefinition.blog,
        posts: [
          {
            id: postId,
            revision: 1,
            collectionState: "active" as const,
            targetVisibility: "public" as const,
            slug: "missing-revision",
            title: "Missing revision",
            excerpt: "The callback must require immutable evidence.",
            seo: {
              title: "Missing revision | Foundry",
              description: "The callback must require immutable evidence.",
            },
            body: createRichTextDocumentFromPlainText("Missing evidence."),
          },
        ],
      },
    };
    const danglingRevisionId =
      "00000000-0000-8000-8000-00000000000e";
    await database
      .prepare(
        `INSERT INTO blog_posts (
           site_id, post_id, collection_state, current_revision,
           current_revision_id, live_revision, last_verified_revision,
           last_verified_visibility, last_verified_publication_id,
           last_verified_publication_sequence, version, updated_at
         ) VALUES (?1, ?2, 'active', 1, ?3, NULL, NULL, NULL, NULL, NULL, 1, ?4)`,
      )
      .bind(
        referenceSiteDefinition.site.id,
        postId,
        danglingRevisionId,
        "2026-07-27T15:05:00.000Z",
      )
      .run();

    await expect(
      reconcileVerifiedBlogPostPublication(
        database,
        referenceSiteDefinition.site.id,
        missingRevisionDefinition,
        { id: "publication-missing-revision", sequence: 1 },
        "2026-07-27T15:10:00.000Z",
      ),
    ).rejects.toBeInstanceOf(ContentRevisionConfigurationError);
    await expect(
      database
        .prepare(
          `SELECT current_revision_id, live_revision,
                  last_verified_publication_id
           FROM blog_posts
           WHERE site_id = ?1 AND post_id = ?2`,
        )
        .bind(referenceSiteDefinition.site.id, postId)
        .first(),
    ).resolves.toEqual({
      current_revision_id: danglingRevisionId,
      live_revision: null,
      last_verified_publication_id: null,
    });
  });

  it("preserves immutable stored 1.0 revisions without rewriting their fingerprinted definition", async () => {
    const legacy = structuredClone(
      referenceSiteDefinition,
    ) as unknown as Record<string, any>;
    legacy.definitionVersion = "1.0.0";
    legacy.schemaVersion = "1.0.0";
    delete legacy.design;
    legacy.home.sections.forEach(
      (section: Record<string, unknown>) => delete section.variant,
    );
    await database.batch([
      database
        .prepare(
          `INSERT INTO content_workspaces (
             workspace_id, site_id, owner_actor_id, production_base,
             schema_version, renderer_version, current_revision,
             current_content_hash, lifecycle, created_at, updated_at
           ) VALUES (?1, ?2, ?3, ?4, '1.0.0', ?5, 0, ?6, 'open', ?7, ?7)`,
        )
        .bind(
          workspaceId,
          referenceSiteDefinition.site.id,
          editorActorId,
          "published:site_foundry_reference@1.0.0",
          "renderer-test-commit",
          "legacy-content-hash",
          "2026-07-26T12:00:00.000Z",
        ),
      database
        .prepare(
          `INSERT INTO content_revisions (
             workspace_id, revision, definition_json, content_hash,
             schema_version, renderer_version, production_base, request_hash,
             created_at, created_by
           ) VALUES (?1, 0, ?2, ?3, '1.0.0', ?4, ?5, ?6, ?7, ?8)`,
        )
        .bind(
          workspaceId,
          JSON.stringify(legacy),
          "legacy-content-hash",
          "renderer-test-commit",
          "published:site_foundry_reference@1.0.0",
          "legacy-request-hash",
          "2026-07-26T12:00:00.000Z",
          "system:published-base",
        ),
    ]);
    const store = createD1ContentRevisionStore(
      database,
      referenceSiteDefinition.site.id,
      workspaceId,
    );
    await store.requireAccess(editorActorId);

    const restored = await store.getRevision(0);

    expect(restored?.inputs.schemaVersion).toBe("1.0.0");
    expect(restored?.definition).toEqual(legacy);
    expect(
      (restored?.definition as unknown as Record<string, unknown>).design,
    ).toBeUndefined();
  });

  it("atomically rejects a media binding after the occurrence head advances", async () => {
    const application = createApplication();
    await createWorkspace(application, "d1-content-media-race-create");
    await database
      .prepare(
        `INSERT INTO media_assets (
           site_id, asset_id, object_key, source_hash, file_name, content_type,
           byte_length, width, height, created_at, created_by
         ) VALUES (?1, 'asset_hero', 'media/site/asset/source', ?2,
           'hero.png', 'image/png', 128, 1600, 900, ?3, ?4)`,
      )
      .bind(
        referenceSiteDefinition.site.id,
        "a".repeat(64),
        "2026-07-27T12:00:00.000Z",
        editorActorId,
      )
      .run();
    for (const revision of [1, 2]) {
      await database
        .prepare(
          `INSERT INTO media_occurrence_revisions (
             site_id, workspace_id, occurrence_id, revision, asset_id,
             crop_json, created_at, created_by
           ) VALUES (?1, ?2, 'occurrence_home_hero', ?3, 'asset_hero',
             NULL, ?4, ?5)`,
        )
        .bind(
          referenceSiteDefinition.site.id,
          workspaceId,
          revision,
          "2026-07-27T12:00:00.000Z",
          editorActorId,
        )
        .run();
    }
    await database
      .prepare(
        `INSERT INTO media_occurrences (
           site_id, workspace_id, occurrence_id, current_revision,
           current_asset_id
         ) VALUES (?1, ?2, 'occurrence_home_hero', 2, 'asset_hero')`,
      )
      .bind(referenceSiteDefinition.site.id, workspaceId)
      .run();

    await expect(
      application.commands.saveMediaOccurrence({
        actorId: editorActorId,
        workspaceId,
        schemaVersion: referenceSiteDefinition.schemaVersion,
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
        idempotencyKey: "d1-content-media-raced-head",
      }),
    ).rejects.toBeInstanceOf(ContentRevisionConflictError);
    await expect(application.queries.getCurrent()).resolves.toMatchObject({
      revision: 0,
    });
  });

  it.each(["before", "after"] as const)(
    "converges on one restored revision when the D1 response is lost %s commit",
    async (faultBoundary) => {
      const restoredDefinition = structuredClone(referenceSiteDefinition);
      (
        restoredDefinition.home.sections[0] as {
          title: string;
        }
      ).title = "Historical D1 release";
      let injected = false;
      const faultingDatabase = {
        prepare: database.prepare.bind(database),
        withSession: database.withSession?.bind(database),
        async batch(
          statements: Parameters<typeof database.batch>[0],
        ) {
          if (!injected && faultBoundary === "before") {
            injected = true;
            throw new Error("injected_response_loss_before_d1_commit");
          }
          const result = await database.batch(statements);
          if (!injected && faultBoundary === "after") {
            injected = true;
            throw new Error("injected_response_loss_after_d1_commit");
          }
          return result;
        },
      } as typeof database;
      const applicationInputs = {
        siteDefinition: referenceSiteDefinition,
        initialDefinition: restoredDefinition,
        initialCreatedBy: editorActorId,
        workspaceId,
        actorId: editorActorId,
        rendererVersion: "renderer-test-commit",
        productionBase: "published:site_foundry_reference@1.0.0",
        now: () => "2026-07-27T12:00:00.000Z",
      } as const;
      const command = {
        actorId: editorActorId,
        workspaceId,
        idempotencyKey: `d1-restore-${faultBoundary}-commit`,
      };
      const interrupted = createContentRevisionApplication({
        ...applicationInputs,
        store: createD1ContentRevisionStore(
          faultingDatabase,
          referenceSiteDefinition.site.id,
          workspaceId,
        ),
      });

      await expect(interrupted.commands.create(command)).rejects.toThrow(
        `injected_response_loss_${faultBoundary}_d1_commit`,
      );
      const retried = await createContentRevisionApplication({
        ...applicationInputs,
        store: createD1ContentRevisionStore(
          database,
          referenceSiteDefinition.site.id,
          workspaceId,
        ),
      }).commands.create(command);

      expect(retried).toEqual(
        expect.objectContaining({
          revision: 0,
          createdBy: editorActorId,
          definition: expect.objectContaining({
            home: expect.objectContaining({
              sections: expect.arrayContaining([
                expect.objectContaining({
                  title: "Historical D1 release",
                }),
              ]),
            }),
          }),
        }),
      );
      expect(
        await database
          .prepare(
            `SELECT COUNT(*) AS count
             FROM content_revisions
             WHERE workspace_id = ?1`,
          )
          .bind(workspaceId)
          .first<{ count: number }>(),
      ).toEqual({ count: 1 });
    },
  );

  it("allows explicit collaborators and rejects outsiders", async () => {
    const owner = createApplication();
    await createWorkspace(owner, "d1-content-create-collaborator");
    await owner.commands.addCollaborator(collaboratorActorId);
    const collaborator = createApplication(collaboratorActorId);
    await expect(collaborator.queries.getCurrent()).resolves.toEqual(
      expect.objectContaining({ workspaceId }),
    );

    const outsider = createApplication(outsiderActorId);
    await expect(outsider.queries.getCurrent()).rejects.toThrow(
      "content_workspace_access_denied",
    );
    await expect(
      outsider.commands.createBlogPost({
        actorId: outsiderActorId,
        workspaceId,
        siteId: referenceSiteDefinition.site.id,
        schemaVersion: referenceSiteDefinition.schemaVersion,
        baseRevision: 0,
        post: {
          id: createBlogPostId(
            "00000000-0000-4000-8000-00000000000c",
          ),
          slug: "unauthorized-post",
          title: "Unauthorized post",
          excerpt: "This must not enter another workspace audit.",
          seo: {
            title: "Unauthorized post | Foundry",
            description: "This must not enter another workspace audit.",
          },
          body: createRichTextDocumentFromPlainText("Unauthorized."),
        },
        idempotencyKey: "d1-unauthorized-blog-post",
      }),
    ).rejects.toBeInstanceOf(ContentWorkspaceAccessError);
    await expect(
      outsider.commands.recordRejectedBlogPostCommand({
        actorId: outsiderActorId,
        postId: null,
        commandType: "blog.post.create",
        reasonCode: "unauthorized_probe",
        requestId: "d1-unauthorized-rejected-audit",
      }),
    ).rejects.toBeInstanceOf(ContentWorkspaceAccessError);
    expect(
      await database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM blog_post_transition_audit_events
           WHERE workspace_id = ?1`,
        )
        .bind(workspaceId)
        .first<{ count: number }>(),
    ).toEqual({ count: 0 });
  });

  it("does not create a missing workspace during an access check", async () => {
    const missingWorkspaceId = createContentWorkspaceId("workspace_missing");
    const store = createD1ContentRevisionStore(
      database,
      referenceSiteDefinition.site.id,
      missingWorkspaceId,
    );

    await expect(store.requireAccess(editorActorId)).rejects.toBeInstanceOf(
      ContentWorkspaceAccessError,
    );
    expect(
      await database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM content_workspaces
           WHERE workspace_id = ?1`,
        )
        .bind(missingWorkspaceId)
        .first<{ count: number }>(),
    ).toEqual({ count: 0 });
  });

  it("resumes the most recently updated accessible workspace", async () => {
    await expect(
      findLatestContentWorkspaceIdForActor(
        database,
        referenceSiteDefinition.site.id,
        editorActorId,
      ),
    ).resolves.toBeNull();

    await createApplication().commands.create({
      actorId: editorActorId,
      workspaceId,
      idempotencyKey: "d1-content-create-default",
    });
    const freshWorkspaceId = createContentWorkspaceId("workspace_fresh");
    await createApplication(
      editorActorId,
      freshWorkspaceId,
      "2026-07-27T13:00:00.000Z",
    ).commands.create({
      actorId: editorActorId,
      workspaceId: freshWorkspaceId,
      idempotencyKey: "d1-content-create-fresh",
    });

    await expect(
      findLatestContentWorkspaceIdForActor(
        database,
        referenceSiteDefinition.site.id,
        editorActorId,
      ),
    ).resolves.toBe(freshWorkspaceId);
    await expect(
      findLatestContentWorkspaceIdForActor(
        database,
        referenceSiteDefinition.site.id,
        outsiderActorId,
      ),
    ).resolves.toBeNull();
  });

  it("returns the current revision when optimistic concurrency fails", async () => {
    const application = createApplication();
    await createWorkspace(application, "d1-content-create-conflict");
    await application.commands.save({
      actorId: editorActorId,
      workspaceId,
      schemaVersion: referenceSiteDefinition.schemaVersion,
      baseRevision: 0,
      edits: [{ path: "section_hero.title", value: "Current revision" }],
      idempotencyKey: "d1-content-save-0002",
    });

    await expect(
      application.commands.save({
        actorId: editorActorId,
        workspaceId,
        schemaVersion: referenceSiteDefinition.schemaVersion,
        baseRevision: 0,
        edits: [{ path: "section_hero.title", value: "Stale revision" }],
        idempotencyKey: "d1-content-save-0003",
      }),
    ).rejects.toEqual(new ContentRevisionConflictError(1));
  });

  it("never acknowledges the losing definition in a concurrent save", async () => {
    const firstApplication = createApplication();
    const secondApplication = createApplication();
    await createWorkspace(firstApplication, "d1-content-create-concurrent");
    const [first, second] = await Promise.allSettled([
      firstApplication.commands.save({
        actorId: editorActorId,
        workspaceId,
        schemaVersion: referenceSiteDefinition.schemaVersion,
        baseRevision: 0,
        edits: [{ path: "section_hero.title", value: "Concurrent first" }],
        idempotencyKey: "d1-content-concurrent-0001",
      }),
      secondApplication.commands.save({
        actorId: editorActorId,
        workspaceId,
        schemaVersion: referenceSiteDefinition.schemaVersion,
        baseRevision: 0,
        edits: [{ path: "section_hero.title", value: "Concurrent second" }],
        idempotencyKey: "d1-content-concurrent-0002",
      }),
    ]);
    const fulfilled = [first, second].filter(
      (result) => result.status === "fulfilled",
    );
    const rejected = [first, second].filter(
      (result) => result.status === "rejected",
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const acknowledged = fulfilled[0] as PromiseFulfilledResult<
      Awaited<ReturnType<typeof firstApplication.commands.save>>
    >;
    const persisted = await firstApplication.queries.getRevision(1);
    expect(persisted?.definition).toEqual(acknowledged.value.definition);
    expect(rejected[0]).toEqual(
      expect.objectContaining({
        reason: expect.any(ContentRevisionConflictError),
      }),
    );
  });

  it("records one audit event for concurrent retries of the same key", async () => {
    const firstApplication = createApplication();
    const secondApplication = createApplication();
    await createWorkspace(firstApplication, "d1-content-create-retry");
    const command = {
      actorId: editorActorId,
      workspaceId,
      schemaVersion: referenceSiteDefinition.schemaVersion,
      baseRevision: 0,
      edits: [{ path: "section_hero.title", value: "One retried save" }],
      idempotencyKey: "d1-content-concurrent-0003",
    } as const;

    const [first, second] = await Promise.all([
      firstApplication.commands.save(command),
      secondApplication.commands.save(command),
    ]);

    expect(second).toEqual(
      expect.objectContaining({
        workspaceId: first.workspaceId,
        revision: first.revision,
        definition: first.definition,
      }),
    );
    expect(
      await database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM content_revision_audit_events
           WHERE workspace_id = ?1 AND revision = ?2`,
        )
        .bind(workspaceId, first.revision)
        .first<{ count: number }>(),
    ).toEqual({ count: 1 });
  });

  it("rechecks a raced receipt before reporting a stale base", async () => {
    const application = createApplication();
    await createWorkspace(application, "d1-content-create-raced-receipt");
    const base = await application.queries.getCurrent();
    const realStore = createD1ContentRevisionStore(
      database,
      referenceSiteDefinition.site.id,
      workspaceId,
    );
    const command: Parameters<typeof realStore.persist>[0] = {
      baseRevision: 0,
      idempotencyKey: "d1-content-raced-receipt",
      requestHash: "matching-request-hash",
      revision: {
        ...base,
        revision: 1,
        createdAt: "2026-07-27T12:01:00.000Z",
        createdBy: editorActorId,
      },
      blogArtifacts: [],
    };

    function storeWithFirstReceiptMiss(onMiss: () => Promise<void>) {
      let firstReceiptLookup = true;
      const racingDatabase = {
        prepare(query: string) {
          return database.prepare(query);
        },
        batch(statements: Parameters<typeof database.batch>[0]) {
          return database.batch(statements);
        },
        withSession(constraint?: "first-primary" | string) {
          const session = database.withSession(constraint);
          return {
            prepare(query: string) {
              const statement = session.prepare(query);
              if (
                firstReceiptLookup &&
                query.includes("FROM content_revision_receipts")
              ) {
                return {
                  bind(...values: unknown[]) {
                    const bound = statement.bind(...values);
                    return {
                      async first() {
                        firstReceiptLookup = false;
                        await onMiss();
                        return null;
                      },
                      run() {
                        return bound.run();
                      },
                    };
                  },
                };
              }
              return statement;
            },
            batch(statements: Parameters<typeof session.batch>[0]) {
              return session.batch(statements);
            },
            getBookmark() {
              return session.getBookmark();
            },
          };
        },
      } as unknown as Parameters<typeof createD1ContentRevisionStore>[0];
      return createD1ContentRevisionStore(
        racingDatabase,
        referenceSiteDefinition.site.id,
        workspaceId,
      );
    }

    const racedStore = storeWithFirstReceiptMiss(async () => {
      await realStore.persist(command);
    });
    await expect(racedStore.persist(command)).resolves.toEqual(
      {
        revision: expect.objectContaining({ workspaceId, revision: 1 }),
        replayed: true,
      },
    );

    const mismatchedStore = storeWithFirstReceiptMiss(async () => {});
    await expect(
      mismatchedStore.persist({
        ...command,
        requestHash: "different-request-hash",
      }),
    ).rejects.toBeInstanceOf(ContentRevisionIdempotencyError);
  });

  it("rejects a key reused for different mutation input", async () => {
    const application = createApplication();
    await createWorkspace(application, "d1-content-create-idempotency");
    await application.commands.save({
      actorId: editorActorId,
      workspaceId,
      schemaVersion: referenceSiteDefinition.schemaVersion,
      baseRevision: 0,
      edits: [{ path: "section_hero.title", value: "First input" }],
      idempotencyKey: "d1-content-save-0004",
    });

    await expect(
      application.commands.save({
        actorId: editorActorId,
        workspaceId,
        schemaVersion: referenceSiteDefinition.schemaVersion,
        baseRevision: 0,
        edits: [{ path: "section_hero.title", value: "Different input" }],
        idempotencyKey: "d1-content-save-0004",
      }),
    ).rejects.toBeInstanceOf(ContentRevisionIdempotencyError);
  });

  it("scopes idempotency keys to one workspace", async () => {
    const otherWorkspaceId = createContentWorkspaceId("workspace_other");
    const first = createApplication();
    const second = createApplication(editorActorId, otherWorkspaceId);
    const sharedKey = "d1-content-save-shared";
    await createWorkspace(first, "d1-content-create-first");
    await createWorkspace(second, "d1-content-create-second");

    await first.commands.save({
      actorId: editorActorId,
      workspaceId,
      schemaVersion: referenceSiteDefinition.schemaVersion,
      baseRevision: 0,
      edits: [{ path: "section_hero.title", value: "First workspace" }],
      idempotencyKey: sharedKey,
    });
    await expect(
      second.commands.save({
        actorId: editorActorId,
        workspaceId: otherWorkspaceId,
        schemaVersion: referenceSiteDefinition.schemaVersion,
        baseRevision: 0,
        edits: [{ path: "section_hero.title", value: "Second workspace" }],
        idempotencyKey: sharedKey,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        workspaceId: otherWorkspaceId,
        revision: 1,
      }),
    );
    expect(
      await database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM content_revision_receipts
           WHERE idempotency_key = ?1`,
        )
        .bind(sharedKey)
        .first<{ count: number }>(),
    ).toEqual({ count: 2 });
  });

  it("prevents update and deletion of persisted revision rows", async () => {
    const application = createApplication();
    await application.commands.create({
      actorId: editorActorId,
      workspaceId,
      idempotencyKey: "d1-content-create-0001",
    });

    await expect(
      database
        .prepare(
          "UPDATE content_revisions SET created_by = 'changed' WHERE revision = 0",
        )
        .run(),
    ).rejects.toThrow(/content_revisions_are_immutable/);
    await expect(
      database
        .prepare("DELETE FROM content_revisions WHERE revision = 0")
        .run(),
    ).rejects.toThrow(/content_revisions_are_immutable/);
  });

  it("translates malformed bookmarks into a preview-safe domain error", async () => {
    const failingDatabase = {
      withSession() {
        return {
          prepare() {
            return {
              bind() {
                return {
                  async first() {
                    throw new Error("invalid_bookmark");
                  },
                };
              },
            };
          },
        };
      },
    } as unknown as Parameters<typeof createD1ContentRevisionStore>[0];
    const store = createD1ContentRevisionStore(
      failingDatabase,
      referenceSiteDefinition.site.id,
      workspaceId,
    );

    await expect(
      store.getRevision(0, "not-a-d1-bookmark"),
    ).rejects.toBeInstanceOf(ContentRevisionBookmarkError);
  });
});
