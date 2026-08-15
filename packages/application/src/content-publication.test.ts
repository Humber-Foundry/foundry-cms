import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createBlogPostId,
  createRichTextDocumentFromPlainText,
  referenceSiteDefinition,
  serializeSiteDefinitionRichTextForPublication,
} from "@humber-foundry/site-definition";

import {
  createContentActorId,
  createContentRevisionApplication,
  createContentWorkspaceId,
  createInMemoryContentRevisionStore,
} from "./content-revisions";
import {
  createInMemoryPublishedSiteRepository,
  createPublishedSiteBundle,
  createSiteApplication,
} from "./index";
import {
  createMcpPublicationApplication,
  type McpPublicationAuditEvent,
} from "./mcp-publications";
import {
  createMcpReadApplication,
  mcpContentDraftScope,
  mcpInitialScope,
  mcpPublicationPublishScope,
  type McpConnectionPrincipal,
} from "./mcp-read";
import { createHumanMembershipId } from "./human-access";
import {
  ContentApprovalInvalidError,
  ContentPublicationIdempotencyError,
  ContentPublicationValidationError,
  createContentApprovalFingerprint,
  createContentPublicationApplication,
  createContentPublicationId,
  createInMemoryContentPublicationStore,
  hashContentPublicationArtifacts,
  hashPublishedSiteDefinition,
  parseProductionBase,
  serializeContentPublicationArtifacts,
  serializeContentPublicationArtifactsForVersion,
  serializePublishedSiteDefinition,
  type ContentPublicationRevisionRepository,
  type ContentPublicationDraftRestorer,
  type ContentPublishedRevisionReader,
  type ContentPublisher,
} from "./content-publication";

const workspaceId = createContentWorkspaceId("workspace_publish");
const editorId = createContentActorId("membership-editor");
const membershipId = createHumanMembershipId("membership-editor");
const productionCommit = "a".repeat(40);
const liveContentHash = "b".repeat(64);
const productionBase = `git:${productionCommit}@content:${liveContentHash}`;

async function revisionFixture() {
  const store = createInMemoryContentRevisionStore();
  const application = createContentRevisionApplication({
    siteDefinition: referenceSiteDefinition,
    store,
    workspaceId,
    actorId: editorId,
    rendererVersion: "renderer-v1",
    productionBase,
    now: () => "2026-07-27T10:00:00.000Z",
  });
  await application.commands.create({
    actorId: editorId,
    workspaceId,
    idempotencyKey: "create-publish-workspace-1",
  });
  const saved = await application.commands.save({
    actorId: editorId,
    workspaceId,
    schemaVersion: referenceSiteDefinition.schemaVersion,
    baseRevision: 0,
    edits: [{ path: "section_hero.title", value: "Approved headline" }],
    idempotencyKey: "save-publish-workspace-0001",
  });
  return { application, saved };
}

describe("content publication application", () => {
  let revisionApplication: Awaited<ReturnType<typeof revisionFixture>>;
  let publisher: ContentPublisher;
  let createCommit: ReturnType<
    typeof vi.fn<ContentPublisher["createCommit"]>
  >;
  let getDeploymentStatus: ReturnType<
    typeof vi.fn<ContentPublisher["getDeploymentStatus"]>
  >;
  let isReleaseLive: ReturnType<
    typeof vi.fn<ContentPublisher["isReleaseLive"]>
  >;
  let repository: ContentPublicationRevisionRepository;
  let clock: string[];

  beforeEach(async () => {
    revisionApplication = await revisionFixture();
    clock = [
      "2026-07-27T10:01:00.000Z",
      "2026-07-27T10:02:00.000Z",
      "2026-07-27T10:03:00.000Z",
      "2026-07-27T10:04:00.000Z",
    ];
    createCommit = vi.fn<ContentPublisher["createCommit"]>().mockResolvedValue({
      state: "committed",
      commitSha: "c".repeat(40),
    });
    getDeploymentStatus =
      vi.fn<ContentPublisher["getDeploymentStatus"]>().mockResolvedValue(
        "building",
      );
    isReleaseLive =
      vi.fn<ContentPublisher["isReleaseLive"]>().mockResolvedValue(true);
    publisher = {
      getChannelConfigurationHash: vi.fn().mockResolvedValue("channel-a"),
      getProductionHead: vi.fn().mockResolvedValue(productionCommit),
      isReleaseLive,
      createCommit,
      reconcileCommit: vi.fn().mockResolvedValue({ state: "not-found" }),
      retryReference: vi.fn().mockResolvedValue({
        state: "committed",
        commitSha: "c".repeat(40),
      }),
      getDeploymentStatus,
      retryDeployment: vi.fn(async ({ assertDispatch }) =>
        (await assertDispatch())
          ? {
              state: "requested" as const,
              deploymentId: "build-123",
            }
          : {
              state: "blocked" as const,
              detail: "deployment_retry_claim_lost" as const,
            },
      ),
    };
    repository = {
      getRevision: async (_workspaceId, revision) =>
        revisionApplication.application.queries.getRevision(revision),
      getCurrent: async () =>
        revisionApplication.application.queries.getCurrent(),
      isCurrent: async (revision) =>
        revisionApplication.application.queries.isRevisionCurrent(revision),
      listContributors: async () => [editorId],
    };
  });

  it("rejects approval when legacy input metadata cannot render the current definition", async () => {
    await expect(
      createContentApprovalFingerprint(
        {
          ...revisionApplication.saved,
          inputs: {
            ...revisionApplication.saved.inputs,
            schemaVersion: "1.0.0",
          },
        },
        "channel-a",
      ),
    ).rejects.toEqual(new ContentApprovalInvalidError("revision_stale"));
  });

  it("hashes the full publication manifest without path or byte ambiguity", async () => {
    const jsonArtifact = {
      path: "foundry/published-site.json" as const,
      bytes: "{}\n",
    };
    const richPath =
      "content/rich-text/section_contact/body.md" as const;
    const [left, right] = await Promise.all([
      hashContentPublicationArtifacts([
        jsonArtifact,
        { path: richPath, bytes: "One.\n" },
      ]),
      hashContentPublicationArtifacts([
        jsonArtifact,
        { path: richPath, bytes: "Two.\n" },
      ]),
    ]);
    expect(left).not.toBe(right);
    await expect(
      hashContentPublicationArtifacts([
        jsonArtifact,
        jsonArtifact,
      ]),
    ).rejects.toThrow("content_publication_artifacts_invalid");
  });

  it("hashes an empty managed Markdown artifact for valid empty rich text", async () => {
    await expect(
      hashContentPublicationArtifacts([
        {
          path: "foundry/published-site.json",
          bytes: "{}\n",
        },
        {
          path: "content/rich-text/section_contact/body.md",
          bytes: "",
        },
      ]),
    ).resolves.toMatch(/^[a-f0-9]{64}$/u);
  });

  function application(
    onVerifiedLive?: Parameters<
      typeof createContentPublicationApplication
    >[0]["onVerifiedLive"],
  ) {
    return createContentPublicationApplication({
      store: createInMemoryContentPublicationStore(),
      revisions: repository,
      publisher,
      onVerifiedLive,
      now: () => clock.shift() ?? "2026-07-27T10:05:00.000Z",
    });
  }

  async function approve(
    app = application(),
  ) {
    const approval = await app.commands.approve({
      workspaceId,
      revision: 1,
      approvedBy: membershipId,
      previewConfirmed: true,
    });
    return { app, approval };
  }

  it("binds human approval to exact content, design, schema, renderer, base, artifact, and channel", async () => {
    const { approval } = await approve();

    expect(approval).toEqual(
      expect.objectContaining({
        workspaceId,
        revision: 1,
        approvedBy: membershipId,
        invalidatedAt: null,
        fingerprint: {
          value: expect.stringMatching(/^[a-f0-9]{64}$/u),
          channel: "site",
          channelConfigurationHash: "channel-a",
          contentHash: revisionApplication.saved.inputs.contentHash,
          revisionContentHash:
            revisionApplication.saved.inputs.contentHash,
          designHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
          schemaVersion: referenceSiteDefinition.schemaVersion,
          rendererVersion: "renderer-v1",
          productionBase,
          artifactHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
          serializationVersion:
            "foundry.site-publication-artifacts.v3",
          postArtifacts: [],
        },
      }),
    );
  });

  it("publishes a post through the exact site fingerprint and verified-live pipeline", async () => {
    const postId = createBlogPostId(
      "00000000-0000-4000-8000-000000000009",
    );
    createCommit
      .mockResolvedValueOnce({
        state: "committed",
        commitSha: "c".repeat(40),
      })
      .mockResolvedValueOnce({
        state: "committed",
        commitSha: "d".repeat(40),
      });
    const savedPost = await revisionApplication.application.commands
      .createBlogPost({
        actorId: editorId,
        workspaceId,
        siteId: referenceSiteDefinition.site.id,
        schemaVersion: referenceSiteDefinition.schemaVersion,
        baseRevision: 1,
        post: {
          id: postId,
          slug: "exact-pipeline",
          title: "Exact pipeline",
          excerpt: "Published through the site pipeline.",
          seo: {
            title: "Exact pipeline | Foundry",
            description: "A post using the exact site publication pipeline.",
            keywords: [],
            shareImage: null
          },
          body: createRichTextDocumentFromPlainText("Exact post body."),
        },
        idempotencyKey: "create-exact-pipeline-post",
      });
    getDeploymentStatus.mockResolvedValue("deployed");
    isReleaseLive.mockResolvedValue(true);
    const onVerifiedLive = vi.fn();
    const app = application(onVerifiedLive);
    const approval = await app.commands.approve({
      workspaceId,
      revision: savedPost.revision,
      approvedBy: membershipId,
      previewConfirmed: true,
    });
    expect(approval.fingerprint.postArtifacts).toEqual([
      expect.objectContaining({
        postId,
        postRevisionId: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
        ),
        revision: 1,
        contentHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        renderedBytesHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        value: expect.stringMatching(/^[a-f0-9]{64}$/u),
      }),
    ]);
    const publication = await app.commands.publish({
      workspaceId,
      approvalId: approval.id,
      requestedBy: membershipId,
      idempotencyKey: "publish-exact-pipeline-post",
    });
    expect(onVerifiedLive).not.toHaveBeenCalled();
    expect(publication).toMatchObject({
      approvalId: approval.id,
      fingerprint: approval.fingerprint.value,
    });
    expect(createCommit).toHaveBeenCalledWith(
      expect.objectContaining({
        contentHash: approval.fingerprint.contentHash,
        artifactHash: approval.fingerprint.artifactHash,
        artifacts: expect.arrayContaining([
          expect.objectContaining({
            path: `content/rich-text/${postId}/body.md`,
            bytes: "Exact post body\\.\n",
          }),
        ]),
      }),
    );
    await app.commands.refresh(publication.id);
    await expect(app.queries.get(publication.id)).resolves.toMatchObject({
      status: "verified-live",
      commitSha: "c".repeat(40),
      fingerprint: approval.fingerprint.value,
    });
    expect(onVerifiedLive).toHaveBeenCalledTimes(1);
    expect(onVerifiedLive).toHaveBeenCalledWith(
      expect.objectContaining({
        id: publication.id,
        status: "verified-live",
        revision: savedPost.revision,
      }),
      expect.objectContaining({
        revision: savedPost.revision,
        definition: savedPost.definition,
      }),
    );

    const removalWorkspaceId = createContentWorkspaceId(
      "workspace_unpublish_post",
    );
    const removalStore = createInMemoryContentRevisionStore();
    const removalRevisions = createContentRevisionApplication({
      siteDefinition: savedPost.definition,
      initialDefinition: savedPost.definition,
      store: removalStore,
      workspaceId: removalWorkspaceId,
      actorId: editorId,
      rendererVersion: "renderer-v1",
      productionBase:
        `git:${"c".repeat(40)}@content:${approval.fingerprint.contentHash}`,
      now: () => "2026-07-27T10:06:00.000Z",
    });
    await removalRevisions.commands.create({
      actorId: editorId,
      workspaceId: removalWorkspaceId,
      idempotencyKey: "create-unpublish-workspace",
    });
    const removalRevision =
      await removalRevisions.commands.unpublishBlogPost({
        actorId: editorId,
        workspaceId: removalWorkspaceId,
        siteId: referenceSiteDefinition.site.id,
        schemaVersion: referenceSiteDefinition.schemaVersion,
        baseRevision: 0,
        postId,
        idempotencyKey: "create-unpublish-revision",
      });
    vi.mocked(publisher.getProductionHead).mockResolvedValue("c".repeat(40));
    const removalApplication = createContentPublicationApplication({
      store: createInMemoryContentPublicationStore(),
      revisions: {
        getRevision: async (_workspace, revision) =>
          removalRevisions.queries.getRevision(revision),
        getCurrent: async () => removalRevisions.queries.getCurrent(),
        isCurrent: async (revision) =>
          removalRevisions.queries.isRevisionCurrent(revision),
        listContributors: async () => [editorId],
      },
      publisher,
      now: () => "2026-07-27T10:07:00.000Z",
    });
    const removalApproval = await removalApplication.commands.approve({
      workspaceId: removalWorkspaceId,
      revision: removalRevision.revision,
      approvedBy: membershipId,
      previewConfirmed: true,
    });
    const removalPublicDefinition = {
      ...removalRevision.definition,
      blog: { ...removalRevision.definition.blog, posts: [] },
    };
    expect(removalApproval.fingerprint).toMatchObject({
      contentHash: await hashPublishedSiteDefinition(
        removalPublicDefinition,
      ),
      revisionContentHash: removalRevision.inputs.contentHash,
    });
    expect(removalApproval.fingerprint.contentHash).not.toBe(
      removalApproval.fingerprint.revisionContentHash,
    );
    const removalPublication = await removalApplication.commands.publish({
      workspaceId: removalWorkspaceId,
      approvalId: removalApproval.id,
      requestedBy: membershipId,
      idempotencyKey: "publish-unpublish-revision",
    });

    expect(removalPublication).toMatchObject({
      approvalId: removalApproval.id,
      requestedBy: membershipId,
      fingerprint: removalApproval.fingerprint.value,
    });
    const removalCommit = createCommit.mock.calls[1]?.[0];
    const removalJson = removalCommit?.artifacts.find(
      ({ path }) =>
        path === "foundry/published-site.json",
    );
    expect(JSON.parse(removalJson?.bytes ?? "{}")).toMatchObject({
      blog: { posts: [] },
    });
    expect(removalCommit?.artifacts).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: `content/rich-text/${postId}/body.md`,
        }),
      ]),
    );
    await expect(removalRevisions.queries.getRevision(0)).resolves.toMatchObject({
      definition: {
        blog: {
          posts: [
            expect.objectContaining({
              id: postId,
              revision: 1,
            }),
          ],
        },
      },
    });
  });

  it("retries verified-live reconciliation after the durable callback fails", async () => {
    getDeploymentStatus.mockResolvedValue("deployed");
    const onVerifiedLive = vi
      .fn()
      .mockRejectedValueOnce(new Error("aggregate_write_unavailable"))
      .mockResolvedValueOnce(undefined);
    const { app, approval } = await approve(application(onVerifiedLive));
    const publication = await app.commands.publish({
      workspaceId,
      approvalId: approval.id,
      requestedBy: membershipId,
      idempotencyKey: "publish-with-reconciliation-retry",
    });

    await expect(app.commands.refresh(publication.id)).rejects.toThrow(
      "aggregate_write_unavailable",
    );
    await expect(app.queries.get(publication.id)).resolves.toMatchObject({
      status: "verified-live",
    });

    await expect(app.commands.refresh(publication.id)).resolves.toMatchObject({
      status: "verified-live",
    });
    expect(onVerifiedLive).toHaveBeenCalledTimes(2);
    expect(onVerifiedLive).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "verified-live" }),
      expect.objectContaining({ revision: 1 }),
    );
  });

  it("rejects a stored legacy schema before creating a publication fingerprint", async () => {
    await expect(
      createContentApprovalFingerprint(
        {
          ...revisionApplication.saved,
          inputs: {
            ...revisionApplication.saved.inputs,
            schemaVersion: "1.0.0",
          },
        },
        "channel-a",
      ),
    ).rejects.toEqual(new ContentApprovalInvalidError("revision_stale"));

    const coherentLegacyDefinition = {
      ...revisionApplication.saved.definition,
      definitionVersion: "1.0.0",
      schemaVersion: "1.0.0",
    } as unknown as typeof revisionApplication.saved.definition;
    await expect(
      createContentApprovalFingerprint(
        {
          ...revisionApplication.saved,
          definition: coherentLegacyDefinition,
          inputs: {
            ...revisionApplication.saved.inputs,
            contentHash:
              await hashPublishedSiteDefinition(coherentLegacyDefinition),
            schemaVersion: "1.0.0",
          },
        },
        "channel-a",
      ),
    ).rejects.toEqual(new ContentApprovalInvalidError("revision_stale"));
  });

  it.each([
    [
      "an unregistered design token",
      (definition: Record<string, any>) => {
        definition.design.colour.accent = "url(javascript:alert(1))";
      },
    ],
    [
      "a cross-component variant",
      (definition: Record<string, any>) => {
        definition.home.sections[0].variant = "cards";
      },
    ],
    [
      "an arbitrary URL",
      (definition: Record<string, any>) => {
        definition.site.navigation[0].href = "https://attacker.example";
      },
    ],
    [
      "an extra property",
      (definition: Record<string, any>) => {
        definition.design.rawCss = "body{display:none}";
      },
    ],
  ])("rejects %s at the approval boundary", async (_name, mutate) => {
    const malformed = structuredClone(
      revisionApplication.saved.definition,
    ) as unknown as Record<string, any>;
    mutate(malformed);
    const definition =
      malformed as unknown as typeof revisionApplication.saved.definition;

    await expect(
      createContentApprovalFingerprint(
        {
          ...revisionApplication.saved,
          definition,
          inputs: {
            ...revisionApplication.saved.inputs,
            contentHash: await hashPublishedSiteDefinition(definition),
          },
        },
        "channel-a",
      ),
    ).rejects.toEqual(new ContentApprovalInvalidError("revision_stale"));
  });

  it("fingerprints tokens and variants as design while ignoring copy-only changes", async () => {
    const base = revisionApplication.saved;
    const hero = base.definition.home.sections[0]!;
    if (hero.type !== "hero") {
      throw new TypeError("expected_hero_fixture");
    }
    const revisionWith = async (
      definition: typeof base.definition,
    ): Promise<typeof base> => ({
      ...base,
      definition,
      inputs: {
        ...base.inputs,
        contentHash: await hashPublishedSiteDefinition(definition),
      },
    });
    const copyRevision = await revisionWith({
      ...base.definition,
      home: {
        ...base.definition.home,
        sections: [
          { ...hero, title: "Copy-only fingerprint change" },
          ...base.definition.home.sections.slice(1),
        ],
      },
    });
    const tokenRevision = await revisionWith({
      ...base.definition,
      design: {
        ...base.definition.design,
        colour: { accent: "clay" },
      },
    });
    const variantRevision = await revisionWith({
      ...base.definition,
      home: {
        ...base.definition.home,
        sections: [
          { ...hero, variant: "focused" },
          ...base.definition.home.sections.slice(1),
        ],
      },
    });

    const [baseFingerprint, copyFingerprint, tokenFingerprint, variantFingerprint] =
      await Promise.all(
        [base, copyRevision, tokenRevision, variantRevision].map((revision) =>
          createContentApprovalFingerprint(revision, "channel-a"),
        ),
      );

    expect(copyFingerprint.designHash).toBe(baseFingerprint.designHash);
    expect(tokenFingerprint.designHash).not.toBe(baseFingerprint.designHash);
    expect(variantFingerprint.designHash).not.toBe(
      baseFingerprint.designHash,
    );
  });

  it("requires the human to confirm the exact canonical preview", async () => {
    const app = application();
    await expect(
      app.commands.approve({
        workspaceId,
        revision: 1,
        approvedBy: membershipId,
        previewConfirmed: false,
      }),
    ).rejects.toEqual(
      new ContentPublicationValidationError(
        "preview_confirmation_required",
      ),
    );
  });

  it("invalidates approval when the publication channel changes", async () => {
    const { app, approval } = await approve();
    vi.mocked(publisher.getChannelConfigurationHash).mockResolvedValue(
      "channel-b",
    );

    await expect(
      app.commands.publish({
        workspaceId,
        approvalId: approval.id,
        requestedBy: membershipId,
        idempotencyKey: "publish-channel-changed",
      }),
    ).rejects.toEqual(new ContentApprovalInvalidError("approval_stale"));
    expect(createCommit).not.toHaveBeenCalled();
  });

  it("rejects a no-op publication before creating Git objects", async () => {
    const noOpRevision = {
      ...revisionApplication.saved,
      inputs: {
        ...revisionApplication.saved.inputs,
        productionBase:
          `git:${productionCommit}@content:` +
          revisionApplication.saved.inputs.contentHash,
      },
    };
    const noOpRepository: ContentPublicationRevisionRepository = {
      getRevision: async (_workspaceId, revision) =>
        revision === noOpRevision.revision ? noOpRevision : null,
      getCurrent: async () => noOpRevision,
      isCurrent: async () => true,
      listContributors: async () => [editorId],
    };
    const app = createContentPublicationApplication({
      store: createInMemoryContentPublicationStore(),
      revisions: noOpRepository,
      publisher,
    });
    const approval = await app.commands.approve({
      workspaceId,
      revision: noOpRevision.revision,
      approvedBy: membershipId,
      previewConfirmed: true,
    });

    await expect(
      app.commands.publish({
        workspaceId,
        approvalId: approval.id,
        requestedBy: membershipId,
        idempotencyKey: "publish-no-op-revision-0001",
      }),
    ).rejects.toEqual(
      new ContentPublicationValidationError("publication_no_changes"),
    );
    expect(createCommit).not.toHaveBeenCalled();

    vi.mocked(publisher.getProductionHead).mockResolvedValue("d".repeat(40));
    await expect(
      app.commands.publish({
        workspaceId,
        approvalId: approval.id,
        requestedBy: membershipId,
        idempotencyKey: "publish-no-op-stale-base",
      }),
    ).rejects.toEqual(
      new ContentApprovalInvalidError("production_head_moved"),
    );
    await expect(
      app.commands.publish({
        workspaceId,
        approvalId: approval.id,
        requestedBy: membershipId,
        idempotencyKey: "publish-no-op-invalidated",
      }),
    ).rejects.toEqual(
      new ContentApprovalInvalidError("approval_invalidated"),
    );
    expect(createCommit).not.toHaveBeenCalled();
  });

  it("invalidates approval when a later render-affecting revision exists", async () => {
    const { app, approval } = await approve();
    await revisionApplication.application.commands.save({
      actorId: editorId,
      workspaceId,
      schemaVersion: referenceSiteDefinition.schemaVersion,
      baseRevision: 1,
      edits: [{ path: "section_hero.summary", value: "Changed after approval" }],
      idempotencyKey: "save-after-approval-0001",
    });

    await expect(
      app.commands.publish({
        workspaceId,
        approvalId: approval.id,
        requestedBy: membershipId,
        idempotencyKey: "publish-after-edit-0001",
      }),
    ).rejects.toEqual(
      new ContentApprovalInvalidError("revision_not_current"),
    );
    expect(createCommit).not.toHaveBeenCalled();
  });

  it("blocks before Git when the production head or live marker no longer matches approval", async () => {
    const { app, approval } = await approve();
    vi.mocked(publisher.getProductionHead).mockResolvedValue("d".repeat(40));

    await expect(
      app.commands.publish({
        workspaceId,
        approvalId: approval.id,
        requestedBy: membershipId,
        idempotencyKey: "publish-stale-head-0001",
      }),
    ).rejects.toEqual(
      new ContentApprovalInvalidError("production_head_moved"),
    );
    expect(createCommit).not.toHaveBeenCalled();
    await expect(
      app.commands.publish({
        workspaceId,
        approvalId: approval.id,
        requestedBy: membershipId,
        idempotencyKey: "publish-invalidated-head-1",
      }),
    ).rejects.toEqual(
      new ContentApprovalInvalidError("approval_invalidated"),
    );

    vi.mocked(publisher.getProductionHead).mockResolvedValue(productionCommit);
    isReleaseLive.mockResolvedValue(false);
    const replacement = await app.commands.approve({
      workspaceId,
      revision: 1,
      approvedBy: membershipId,
      previewConfirmed: true,
    });
    await expect(
      app.commands.publish({
        workspaceId,
        approvalId: replacement.id,
        requestedBy: membershipId,
        idempotencyKey: "publish-stale-marker-001",
      }),
    ).rejects.toEqual(
      new ContentApprovalInvalidError("release_marker_mismatch"),
    );
    expect(createCommit).not.toHaveBeenCalled();
    await expect(
      app.commands.publish({
        workspaceId,
        approvalId: replacement.id,
        requestedBy: membershipId,
        idempotencyKey: "publish-invalid-marker-1",
      }),
    ).rejects.toEqual(
      new ContentApprovalInvalidError("approval_invalidated"),
    );
  });

  it("preserves approval when the live release probe is temporarily unavailable", async () => {
    const { app, approval } = await approve();
    isReleaseLive.mockRejectedValueOnce(
      new Error("release_marker_unavailable"),
    );

    await expect(
      app.commands.publish({
        workspaceId,
        approvalId: approval.id,
        requestedBy: membershipId,
        idempotencyKey: "publish-probe-unavailable",
      }),
    ).rejects.toThrow("release_marker_unavailable");

    isReleaseLive.mockResolvedValue(true);
    await expect(
      app.commands.publish({
        workspaceId,
        approvalId: approval.id,
        requestedBy: membershipId,
        idempotencyKey: "publish-after-probe-retry",
      }),
    ).resolves.toEqual(expect.objectContaining({ status: "committed" }));
  });

  it("invalidates drift observed by either base probe when its sibling is unavailable", async () => {
    const headDrift = await approve();
    vi.mocked(publisher.getProductionHead).mockResolvedValue("d".repeat(40));
    isReleaseLive.mockRejectedValue(new Error("release_marker_unavailable"));

    await expect(
      headDrift.app.commands.publish({
        workspaceId,
        approvalId: headDrift.approval.id,
        requestedBy: membershipId,
        idempotencyKey: "publish-head-drift-sibling-down",
      }),
    ).rejects.toEqual(
      new ContentApprovalInvalidError("production_head_moved"),
    );
    await expect(
      headDrift.app.commands.publish({
        workspaceId,
        approvalId: headDrift.approval.id,
        requestedBy: membershipId,
        idempotencyKey: "publish-head-drift-invalidated",
      }),
    ).rejects.toEqual(
      new ContentApprovalInvalidError("approval_invalidated"),
    );

    const markerDrift = await approve();
    vi.mocked(publisher.getProductionHead).mockRejectedValue(
      new Error("github_temporarily_unavailable"),
    );
    isReleaseLive.mockResolvedValue(false);

    await expect(
      markerDrift.app.commands.publish({
        workspaceId,
        approvalId: markerDrift.approval.id,
        requestedBy: membershipId,
        idempotencyKey: "publish-marker-drift-sibling-down",
      }),
    ).rejects.toEqual(
      new ContentApprovalInvalidError("release_marker_mismatch"),
    );
    await expect(
      markerDrift.app.commands.publish({
        workspaceId,
        approvalId: markerDrift.approval.id,
        requestedBy: membershipId,
        idempotencyKey: "publish-marker-drift-invalidated",
      }),
    ).rejects.toEqual(
      new ContentApprovalInvalidError("approval_invalidated"),
    );
    expect(createCommit).not.toHaveBeenCalled();
  });

  it("invalidates approval when Git's final compare-and-swap sees a moved head", async () => {
    createCommit.mockResolvedValue({
      state: "blocked",
      detail: "production_head_moved",
    });
    const { app, approval } = await approve();

    await expect(
      app.commands.publish({
        workspaceId,
        approvalId: approval.id,
        requestedBy: membershipId,
        idempotencyKey: "publish-raced-head-0001",
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        status: "blocked",
        detail: "production_head_moved",
      }),
    );
    await expect(
      app.commands.publish({
        workspaceId,
        approvalId: approval.id,
        requestedBy: membershipId,
        idempotencyKey: "publish-raced-head-0002",
      }),
    ).rejects.toEqual(
      new ContentApprovalInvalidError("approval_invalidated"),
    );
  });

  it("starts a new publication after a definite Git rejection is repaired", async () => {
    createCommit
      .mockResolvedValueOnce({
        state: "failed",
        detail: "git_operation_failed",
      })
      .mockResolvedValueOnce({
        state: "committed",
        commitSha: "c".repeat(40),
      });
    const { app, approval } = await approve();

    const failed = await app.commands.publish({
      workspaceId,
      approvalId: approval.id,
      requestedBy: membershipId,
      idempotencyKey: "publish-definite-git-failure",
    });
    expect(failed).toEqual(
      expect.objectContaining({
        status: "failed",
        commitSha: null,
        detail: "git_operation_failed",
      }),
    );

    const retried = await app.commands.publish({
      workspaceId,
      approvalId: approval.id,
      requestedBy: membershipId,
      idempotencyKey: "publish-after-git-repair",
    });
    expect(retried).toEqual(
      expect.objectContaining({
        status: "committed",
        commitSha: "c".repeat(40),
      }),
    );
    expect(retried.id).not.toBe(failed.id);
    expect(createCommit).toHaveBeenCalledTimes(2);
  });

  it("starts a new publication after a lease is lost before Git mutation", async () => {
    createCommit
      .mockResolvedValueOnce({
        state: "blocked",
        detail: "publication_lease_lost",
      })
      .mockResolvedValueOnce({
        state: "committed",
        commitSha: "c".repeat(40),
      });
    const { app, approval } = await approve();

    const blocked = await app.commands.publish({
      workspaceId,
      approvalId: approval.id,
      requestedBy: membershipId,
      idempotencyKey: "publish-before-lease-loss",
    });
    expect(blocked).toEqual(
      expect.objectContaining({
        status: "blocked",
        commitSha: null,
        detail: "publication_lease_lost",
      }),
    );

    const retried = await app.commands.publish({
      workspaceId,
      approvalId: approval.id,
      requestedBy: membershipId,
      idempotencyKey: "publish-after-lease-loss",
    });
    expect(retried).toEqual(
      expect.objectContaining({
        status: "committed",
        commitSha: "c".repeat(40),
      }),
    );
    expect(retried.id).not.toBe(blocked.id);
    expect(createCommit).toHaveBeenCalledTimes(2);
  });

  it("starts a new publication after its competing global claim ends", async () => {
    const store = createInMemoryContentPublicationStore();
    const app = createContentPublicationApplication({
      store,
      revisions: repository,
      publisher,
      now: () => clock.shift() ?? "2026-07-27T10:05:00.000Z",
    });
    const approval = await app.commands.approve({
      workspaceId,
      revision: 1,
      approvedBy: membershipId,
      previewConfirmed: true,
    });
    const competing = {
      id: createContentPublicationId(`publish_${"8".repeat(32)}`),
      workspaceId: createContentWorkspaceId("workspace_competing"),
      revision: 1,
      approvalId: approval.id,
      fingerprint: approval.fingerprint.value,
      idempotencyKey: "competing-publication-claim",
      requestedBy: membershipId,
      contributors: [editorId],
      expectedHead: productionCommit,
      status: "requested" as const,
      commitSha: null,
      deploymentId: null,
      deploymentRequestedAt: null,
      detail: null,
      leaseToken: "competing-lease",
      leaseExpiresAt: "2026-07-27T11:00:00.000Z",
      requestedAt: "2026-07-27T09:00:00.000Z",
      updatedAt: "2026-07-27T09:00:00.000Z",
    };
    await store.claimPublication(competing);

    const blocked = await app.commands.publish({
      workspaceId,
      approvalId: approval.id,
      requestedBy: membershipId,
      idempotencyKey: "publish-while-competing",
    });
    expect(blocked).toEqual(
      expect.objectContaining({
        status: "blocked",
        detail: "publication_in_progress",
      }),
    );

    await store.updatePublication({
      ...competing,
      status: "failed",
      detail: "git_operation_failed",
      leaseToken: null,
      leaseExpiresAt: null,
      updatedAt: "2026-07-27T10:03:30.000Z",
    });
    const retried = await app.commands.publish({
      workspaceId,
      approvalId: approval.id,
      requestedBy: membershipId,
      idempotencyKey: "publish-after-competing",
    });

    expect(retried).toEqual(
      expect.objectContaining({
        status: "committed",
        commitSha: "c".repeat(40),
      }),
    );
    expect(retried.id).not.toBe(blocked.id);
    expect(createCommit).toHaveBeenCalledTimes(1);
  });

  it("does not publish an approval through a different workspace boundary", async () => {
    const { app, approval } = await approve();

    await expect(
      app.commands.publish({
        workspaceId: createContentWorkspaceId("workspace_other"),
        approvalId: approval.id,
        requestedBy: membershipId,
        idempotencyKey: "publish-cross-workspace-1",
      }),
    ).rejects.toEqual(
      new ContentApprovalInvalidError("approval_not_found"),
    );
    expect(createCommit).not.toHaveBeenCalled();
  });

  it("serializes one deterministic artifact set and creates one attributed compare-and-swap commit", async () => {
    const { app, approval } = await approve();
    const publication = await app.commands.publish({
      workspaceId,
      approvalId: approval.id,
      requestedBy: membershipId,
      idempotencyKey: "publish-exact-revision-1",
    });

    expect(publication.status).toBe("committed");
    expect(publication.commitSha).toBe("c".repeat(40));
    expect(createCommit).toHaveBeenCalledTimes(1);
    expect(createCommit).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedHead: productionCommit,
        artifacts: [
          {
            path: "foundry/published-site.json",
            bytes: serializePublishedSiteDefinition(
              revisionApplication.saved.definition,
            ),
          },
          ...serializeSiteDefinitionRichTextForPublication(
            revisionApplication.saved.definition,
          ).map(({ filePath, markdown }) => ({
            path: filePath,
            bytes: markdown,
          })),
        ],
        artifactHash: approval.fingerprint.artifactHash,
        message: expect.stringContaining(
          `Foundry-Approved-By: ${membershipId}`,
        ),
      }),
    );
    expect(createCommit.mock.calls[0]![0].message).toContain(
      `Foundry-Content-Hash: ${revisionApplication.saved.inputs.contentHash}`,
    );

    const replay = await app.commands.publish({
      workspaceId,
      approvalId: approval.id,
      requestedBy: membershipId,
      idempotencyKey: "publish-exact-revision-1",
    });
    expect(replay).toEqual(publication);
    expect(createCommit).toHaveBeenCalledTimes(1);
  });

  it("joins one MCP actor and approval through audit identity to attributed Git trailers", async () => {
    const { app, approval } = await approve();
    const actor: McpConnectionPrincipal = {
      connectionId: "connection-trace",
      actorId: "agent-trace",
      clientId: "https://client.example/trace.json",
      siteId: referenceSiteDefinition.site.id,
      scopes: [
        mcpInitialScope,
        mcpContentDraftScope,
        mcpPublicationPublishScope,
      ],
    };
    const mcpAudit: McpPublicationAuditEvent[] = [];
    const read = createMcpReadApplication({
      site: createSiteApplication({
        siteId: referenceSiteDefinition.site.id,
        publishedSites: createInMemoryPublishedSiteRepository([
          createPublishedSiteBundle(referenceSiteDefinition),
        ]),
      }),
      siteMetadata: {
        canonicalUrl: "https://foundry.example",
        locale: "en-CA",
        timeZone: "America/Vancouver",
        async getLiveRelease() {
          return null;
        },
      },
      connections: {
        async findCurrentConnection() {
          return { ...actor, status: "active" };
        },
        async recordInvocation() {},
      },
      cursors: {
        async encode() {
          return "unused";
        },
        async decode() {
          throw new Error("unused");
        },
      },
      createInvocationId: () => "invocation-trace",
      now: () => "2026-07-27T10:01:00.000Z",
    });
    const mcp = createMcpPublicationApplication({
      base: read,
      runtime: {
        async loadRevision() {
          return revisionApplication.application;
        },
        async loadPublication() {
          return app;
        },
        async loadBlogOperations() {
          throw new Error("unused");
        },
        async recordInvocation(event) {
          mcpAudit.push(event);
        },
      },
      now: () => "2026-07-27T10:01:00.000Z",
    });
    const context = {
      throwIfExpired() {},
      run: <Result>(operation: () => Promise<Result>) => operation(),
      finishDurably: <Result>(operation: () => Promise<Result>) => operation(),
    };

    const response = (await mcp.requestPublication(
      actor,
      {
        workspaceId,
        revision: 1,
        approvalId: approval.id,
        idempotencyKey: "56565656-5656-4656-8656-565656565656",
      },
      context,
    )) as {
      invocationId: string;
      result: { operationId: string; state: string; replayed: boolean };
    };
    const commit = createCommit.mock.calls[0]![0];
    expect(mcpAudit).toEqual([
      expect.objectContaining({
        invocationId: response.invocationId,
        actorId: actor.actorId,
        connectionId: actor.connectionId,
        workspaceId,
        revision: 1,
        approvalId: approval.id,
        publicationId: response.result.operationId,
      }),
    ]);
    for (const trailer of [
      `Foundry-Publish-Id: ${response.result.operationId}`,
      `Foundry-Workspace: ${workspaceId}`,
      "Foundry-Revision: 1",
      `Foundry-Approved-By: ${membershipId}`,
      `Foundry-Content-Hash: ${revisionApplication.saved.inputs.contentHash}`,
    ]) {
      expect(commit.message).toContain(trailer);
    }
    expect(JSON.stringify({ audit: mcpAudit, commit })).not.toMatch(
      /authorization|bearer|access[_-]?token|refresh[_-]?token|secret-canary/iu,
    );
  });

  it("exposes release history with immutable approval and state evidence", async () => {
    getDeploymentStatus
      .mockResolvedValueOnce("deployed")
      .mockResolvedValueOnce("deployed");
    isReleaseLive
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const app = application();
    const approval = await app.commands.approve({
      workspaceId,
      revision: 1,
      approvedBy: membershipId,
      previewConfirmed: true,
    });
    const publication = await app.commands.publish({
      workspaceId,
      approvalId: approval.id,
      requestedBy: membershipId,
      idempotencyKey: "publish-history-evidence-1",
    });
    await app.commands.refresh(publication.id);
    await app.commands.refresh(publication.id);

    await expect(app.queries.listHistory()).resolves.toEqual([
      expect.objectContaining({
        publication: expect.objectContaining({
          id: publication.id,
          status: "verified-live",
          commitSha: "c".repeat(40),
        }),
        approval: expect.objectContaining({
          id: approval.id,
          fingerprint: expect.objectContaining({
            contentHash: revisionApplication.saved.inputs.contentHash,
            artifactHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
          }),
        }),
        events: [
          expect.objectContaining({ status: "requested" }),
          expect.objectContaining({ status: "committed" }),
          expect.objectContaining({ status: "deployed" }),
          expect.objectContaining({ status: "verified-live" }),
        ],
      }),
    ]);
  });

  it("restores a verified historical Git artifact into one new draft without publishing it", async () => {
    const store = createInMemoryContentPublicationStore();
    const historicalArtifacts = serializeContentPublicationArtifacts(
      revisionApplication.saved.definition,
    );
    const historicalBytes = historicalArtifacts.find(
      ({ path }) =>
        path === "foundry/published-site.json",
    )!.bytes;
    const reader: ContentPublishedRevisionReader = {
      readPublishedArtifact: vi.fn(async ({ path }) =>
        historicalArtifacts.find((artifact) => artifact.path === path)?.bytes ??
        null,
      ),
    };
    const restoredWorkspaceId =
      createContentWorkspaceId("workspace_restored");
    const restorer: ContentPublicationDraftRestorer = {
      restore: vi.fn().mockResolvedValue({
        workspaceId: restoredWorkspaceId,
        revision: 0,
        sourcePublicationId: createContentPublicationId(
          `publish_${"0".repeat(32)}`,
        ),
      }),
    };
    const app = createContentPublicationApplication({
      store,
      revisions: repository,
      publisher,
      publishedRevisions: reader,
      draftRestorer: restorer,
      now: () => clock.shift() ?? "2026-07-27T10:05:00.000Z",
    });
    const approval = await app.commands.approve({
      workspaceId,
      revision: 1,
      approvedBy: membershipId,
      previewConfirmed: true,
    });
    const publication = await app.commands.publish({
      workspaceId,
      approvalId: approval.id,
      requestedBy: membershipId,
      idempotencyKey: "publish-before-restore-1",
    });
    getDeploymentStatus.mockResolvedValue("deployed");
    await app.commands.refresh(publication.id);
    await app.commands.refresh(publication.id);
    vi.mocked(restorer.restore).mockResolvedValue({
      workspaceId: restoredWorkspaceId,
      revision: 0,
      sourcePublicationId: publication.id,
    });

    const restored = await app.commands.restore({
      sourcePublicationId: publication.id,
      actorId: editorId,
      workspaceId: restoredWorkspaceId,
      idempotencyKey: "restore-published-version-1",
    });

    expect(reader.readPublishedArtifact).toHaveBeenCalledWith({
      commitSha: "c".repeat(40),
      path: "foundry/published-site.json",
    });
    expect(reader.readPublishedArtifact).toHaveBeenCalledTimes(
      historicalArtifacts.length,
    );
    expect(restorer.restore).toHaveBeenCalledWith(
      expect.objectContaining({
        definition: revisionApplication.saved.definition,
        sourcePublicationId: publication.id,
        workspaceId: restoredWorkspaceId,
      }),
    );
    expect(restored).toEqual({
      workspaceId: restoredWorkspaceId,
      revision: 0,
      sourcePublicationId: publication.id,
    });
    expect(createCommit).toHaveBeenCalledTimes(1);
  });

  it("restores a verified legacy v1 artifact without applying the v2 rich-text manifest contract", async () => {
    const store = createInMemoryContentPublicationStore();
    const legacyDefinition = structuredClone(
      revisionApplication.saved.definition,
    ) as any;
    legacyDefinition.definitionVersion = "1.1.0";
    legacyDefinition.schemaVersion = "1.1.0";
    delete legacyDefinition.home.media;
    legacyDefinition.home.sections.find(
      (section: any) => section.type === "callToAction",
    ).body = "Restored legacy CTA copy.";
    const historicalBytes =
      serializePublishedSiteDefinition(legacyDefinition);
    const historicalArtifactHash = [
      ...new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(historicalBytes),
        ),
      ),
    ]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const restoredWorkspaceId = createContentWorkspaceId(
      "workspace_restored_legacy",
    );
    const reader: ContentPublishedRevisionReader = {
      readPublishedArtifact: vi.fn().mockResolvedValue(historicalBytes),
    };
    const restorer: ContentPublicationDraftRestorer = {
      restore: vi.fn().mockResolvedValue({
        workspaceId: restoredWorkspaceId,
        revision: 0,
        sourcePublicationId: createContentPublicationId(
          `publish_${"0".repeat(32)}`,
        ),
      }),
    };
    const app = createContentPublicationApplication({
      store,
      revisions: repository,
      publisher,
      publishedRevisions: reader,
      draftRestorer: restorer,
      now: () => clock.shift() ?? "2026-07-27T10:05:00.000Z",
    });
    const approval = await app.commands.approve({
      workspaceId,
      revision: 1,
      approvedBy: membershipId,
      previewConfirmed: true,
    });
    const publication = await app.commands.publish({
      workspaceId,
      approvalId: approval.id,
      requestedBy: membershipId,
      idempotencyKey: "publish-before-legacy-restore",
    });
    getDeploymentStatus.mockResolvedValue("deployed");
    await app.commands.refresh(publication.id);
    await app.commands.refresh(publication.id);
    await store.saveApproval({
      ...approval,
      fingerprint: {
        ...approval.fingerprint,
        value: "e".repeat(64),
        contentHash: await hashPublishedSiteDefinition(legacyDefinition),
        schemaVersion: "1.1.0",
        artifactHash: historicalArtifactHash,
        serializationVersion:
          "foundry.site-definition.canonical-json.v1",
      },
    });
    vi.mocked(restorer.restore).mockResolvedValue({
      workspaceId: restoredWorkspaceId,
      revision: 0,
      sourcePublicationId: publication.id,
    });

    await expect(
      app.commands.restore({
        sourcePublicationId: publication.id,
        actorId: editorId,
        workspaceId: restoredWorkspaceId,
        idempotencyKey: "restore-legacy-published-version",
      }),
    ).resolves.toEqual({
      workspaceId: restoredWorkspaceId,
      revision: 0,
      sourcePublicationId: publication.id,
    });
    expect(reader.readPublishedArtifact).toHaveBeenCalledTimes(1);
    expect(restorer.restore).toHaveBeenCalledWith(
      expect.objectContaining({
        definition: legacyDefinition,
        sourcePublicationId: publication.id,
        workspaceId: restoredWorkspaceId,
      }),
    );
  });

  it("preserves the legacy v2 path while current v3 uses the installation-owned path", async () => {
    const legacyDefinition = structuredClone(
      revisionApplication.saved.definition,
    ) as any;
    legacyDefinition.definitionVersion = "1.2.0";
    legacyDefinition.schemaVersion = "1.2.0";
    delete legacyDefinition.blog;
    const legacyRichTextDefinition = {
      ...legacyDefinition,
      blog: { id: "blog", posts: [] },
    };

    const v2Artifacts = serializeContentPublicationArtifactsForVersion(
      legacyDefinition,
      "foundry.site-publication-artifacts.v2",
    );
    const v3Artifacts = serializeContentPublicationArtifactsForVersion(
      legacyDefinition,
      "foundry.site-publication-artifacts.v3",
    );

    expect(v2Artifacts).toEqual([
      {
        path: "packages/site-definition/src/published-site.json",
        bytes: serializePublishedSiteDefinition(legacyDefinition),
      },
      ...serializeSiteDefinitionRichTextForPublication(
        legacyRichTextDefinition,
      ).map(({ filePath, markdown }) => ({
        path: filePath,
        bytes: markdown,
      })),
    ]);
    expect(v3Artifacts[0]).toEqual({
      path: "foundry/published-site.json",
      bytes: serializePublishedSiteDefinition(legacyDefinition),
    });
    await expect(hashContentPublicationArtifacts(v2Artifacts)).resolves.not.toBe(
      await hashContentPublicationArtifacts(v3Artifacts),
    );
  });

  it("rejects a current publication definition whose blog data is missing", () => {
    const invalidDefinition = structuredClone(
      revisionApplication.saved.definition,
    ) as any;
    delete invalidDefinition.blog;

    expect(() =>
      serializeContentPublicationArtifacts(invalidDefinition),
    ).toThrow("site_definition_blog_missing");
  });

  it("reconciles and explicitly retries an ambiguous legacy v1 publication after rollout", async () => {
    const backingStore = createInMemoryContentPublicationStore();
    let approvalOverride: Awaited<
      ReturnType<typeof backingStore.findApproval>
    > = null;
    let revisionOverride: Awaited<
      ReturnType<ContentPublicationRevisionRepository["getRevision"]>
    > = null;
    const rolloutStore = {
      ...backingStore,
      findApproval: async (approvalId: Parameters<
        typeof backingStore.findApproval
      >[0]) =>
        approvalOverride?.id === approvalId
          ? approvalOverride
          : backingStore.findApproval(approvalId),
    };
    const rolloutRepository: ContentPublicationRevisionRepository = {
      getRevision: async (targetWorkspaceId, revision) =>
        revisionOverride?.workspaceId === targetWorkspaceId &&
        revisionOverride.revision === revision
          ? revisionOverride
          : repository.getRevision(targetWorkspaceId, revision),
      getCurrent: async (targetWorkspaceId) =>
        revisionOverride?.workspaceId === targetWorkspaceId
          ? revisionOverride
          : repository.getCurrent(targetWorkspaceId),
      isCurrent: repository.isCurrent,
      listContributors: repository.listContributors,
    };
    let currentTime = "2026-07-27T10:00:00.000Z";
    createCommit.mockResolvedValue({
      state: "unknown",
      detail: "git_result_unknown",
    });
    const app = createContentPublicationApplication({
      store: rolloutStore,
      revisions: rolloutRepository,
      publisher,
      now: () => currentTime,
    });
    const approval = await app.commands.approve({
      workspaceId,
      revision: 1,
      approvedBy: membershipId,
      previewConfirmed: true,
    });
    const publication = await app.commands.publish({
      workspaceId,
      approvalId: approval.id,
      requestedBy: membershipId,
      idempotencyKey: "publish-ambiguous-before-v2-rollout",
    });
    const legacyDefinition = structuredClone(
      revisionApplication.saved.definition,
    ) as any;
    legacyDefinition.definitionVersion = "1.1.0";
    legacyDefinition.schemaVersion = "1.1.0";
    delete legacyDefinition.home.media;
    legacyDefinition.home.sections.find(
      (section: any) => section.type === "callToAction",
    ).body = "Ambiguous legacy CTA copy.";
    const legacyBytes = serializePublishedSiteDefinition(legacyDefinition);
    const legacyArtifactHash = [
      ...new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(legacyBytes),
        ),
      ),
    ]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const legacyContentHash =
      await hashPublishedSiteDefinition(legacyDefinition);
    approvalOverride = {
      ...approval,
      fingerprint: {
        ...approval.fingerprint,
        contentHash: legacyContentHash,
        schemaVersion: "1.1.0",
        artifactHash: legacyArtifactHash,
        serializationVersion:
          "foundry.site-definition.canonical-json.v1",
      },
    };
    revisionOverride = {
      ...revisionApplication.saved,
      definition: legacyDefinition,
      inputs: {
        ...revisionApplication.saved.inputs,
        contentHash: legacyContentHash,
        schemaVersion: "1.1.0",
      },
    } as any;
    await expect(
      repository.isCurrent(revisionOverride!),
    ).resolves.toBe(false);
    vi.mocked(
      publisher.getChannelConfigurationHash,
    ).mockImplementation(async (serializationVersion) =>
      serializationVersion ===
      "foundry.site-definition.canonical-json.v1"
        ? "channel-a"
        : "channel-b",
    );
    vi.mocked(publisher.reconcileCommit).mockResolvedValue({
      state: "not-found",
    });
    currentTime = "2026-07-27T10:16:00.000Z";

    await expect(app.commands.refresh(publication.id)).resolves.toEqual(
      expect.objectContaining({
        status: "failed",
        detail: "git_commit_not_found",
      }),
    );
    createCommit.mockResolvedValue({
      state: "committed",
      commitSha: "c".repeat(40),
    });
    await expect(
      app.commands.retryDeployment(publication.id, membershipId),
    ).resolves.toEqual(
      expect.objectContaining({
        status: "committed",
        commitSha: "c".repeat(40),
      }),
    );
    expect(publisher.reconcileCommit).toHaveBeenCalledTimes(2);
    for (const [input] of vi.mocked(publisher.reconcileCommit).mock.calls) {
      expect(input).toEqual(
        expect.objectContaining({
          serializationVersion:
            "foundry.site-definition.canonical-json.v1",
          artifactHash: legacyArtifactHash,
          artifacts: [
            {
              path: "packages/site-definition/src/published-site.json",
              bytes: legacyBytes,
            },
          ],
        }),
      );
    }
    expect(createCommit).toHaveBeenCalledTimes(2);
    expect(createCommit.mock.calls[1]![0]).toEqual(
      expect.objectContaining({
        serializationVersion:
          "foundry.site-definition.canonical-json.v1",
        artifactHash: legacyArtifactHash,
        artifacts: [
          {
            path: "packages/site-definition/src/published-site.json",
            bytes: legacyBytes,
          },
        ],
      }),
    );
  });

  it("revalidates and retries a retained v2 approval with its original path after v3 rollout", async () => {
    const backingStore = createInMemoryContentPublicationStore();
    let approvalOverride: Awaited<
      ReturnType<typeof backingStore.findApproval>
    > = null;
    const rolloutStore = {
      ...backingStore,
      findApproval: async (approvalId: Parameters<
        typeof backingStore.findApproval
      >[0]) =>
        approvalOverride?.id === approvalId
          ? approvalOverride
          : backingStore.findApproval(approvalId),
    };
    let currentTime = "2026-07-27T10:00:00.000Z";
    createCommit.mockResolvedValue({
      state: "unknown",
      detail: "git_result_unknown",
    });
    const app = createContentPublicationApplication({
      store: rolloutStore,
      revisions: repository,
      publisher,
      now: () => currentTime,
    });
    const approval = await app.commands.approve({
      workspaceId,
      revision: 1,
      approvedBy: membershipId,
      previewConfirmed: true,
    });
    const v2Fingerprint = await createContentApprovalFingerprint(
      revisionApplication.saved,
      "channel-a",
      "site",
      "foundry.site-publication-artifacts.v2",
    );
    approvalOverride = { ...approval, fingerprint: v2Fingerprint };
    const publication = await app.commands.publish({
      workspaceId,
      approvalId: approval.id,
      requestedBy: membershipId,
      idempotencyKey: "publish-ambiguous-retained-v2",
    });

    vi.mocked(publisher.getChannelConfigurationHash).mockImplementation(
      async (serializationVersion) =>
        serializationVersion === "foundry.site-publication-artifacts.v2"
          ? "channel-a"
          : "channel-b",
    );
    vi.mocked(publisher.reconcileCommit).mockResolvedValue({
      state: "not-found",
    });
    currentTime = "2026-07-27T10:16:00.000Z";

    await expect(app.commands.refresh(publication.id)).resolves.toEqual(
      expect.objectContaining({
        status: "failed",
        detail: "git_commit_not_found",
      }),
    );
    createCommit.mockResolvedValue({
      state: "committed",
      commitSha: "c".repeat(40),
    });
    await expect(
      app.commands.retryDeployment(publication.id, membershipId),
    ).resolves.toEqual(
      expect.objectContaining({
        status: "committed",
        commitSha: "c".repeat(40),
      }),
    );
    expect(createCommit.mock.calls[1]![0]).toEqual(
      expect.objectContaining({
        serializationVersion: "foundry.site-publication-artifacts.v2",
        artifactHash: v2Fingerprint.artifactHash,
        artifacts: expect.arrayContaining([
          expect.objectContaining({
            path: "packages/site-definition/src/published-site.json",
          }),
        ]),
      }),
    );
  });

  it("fails closed when historical Git bytes do not match the published evidence", async () => {
    const app = createContentPublicationApplication({
      store: createInMemoryContentPublicationStore(),
      revisions: repository,
      publisher,
      publishedRevisions: {
        readPublishedArtifact: vi.fn().mockResolvedValue(
          serializePublishedSiteDefinition(referenceSiteDefinition),
        ),
      },
      draftRestorer: {
        restore: vi.fn(),
      },
      now: () => clock.shift() ?? "2026-07-27T10:05:00.000Z",
    });
    const approval = await app.commands.approve({
      workspaceId,
      revision: 1,
      approvedBy: membershipId,
      previewConfirmed: true,
    });
    const publication = await app.commands.publish({
      workspaceId,
      approvalId: approval.id,
      requestedBy: membershipId,
      idempotencyKey: "publish-before-invalid-restore",
    });
    getDeploymentStatus.mockResolvedValue("deployed");
    await app.commands.refresh(publication.id);
    await app.commands.refresh(publication.id);

    await expect(
      app.commands.restore({
        sourcePublicationId: publication.id,
        actorId: editorId,
        workspaceId: createContentWorkspaceId("workspace_invalid_restore"),
        idempotencyKey: "restore-invalid-artifact-1",
      }),
    ).rejects.toEqual(
      new ContentPublicationValidationError(
        "restore_artifact_mismatch",
      ),
    );
  });

  it("rejects a publication idempotency key reused by another requester", async () => {
    const { app, approval } = await approve();
    await app.commands.publish({
      workspaceId,
      approvalId: approval.id,
      requestedBy: membershipId,
      idempotencyKey: "publish-command-identity-conflict",
    });

    await expect(
      app.commands.publish({
        workspaceId,
        approvalId: approval.id,
        requestedBy: createHumanMembershipId("membership-other"),
        idempotencyKey: "publish-command-identity-conflict",
      }),
    ).rejects.toEqual(new ContentPublicationIdempotencyError());
    expect(createCommit).toHaveBeenCalledTimes(1);
  });

  it("does not enter the publisher after losing the claimed lease", async () => {
    const store = createInMemoryContentPublicationStore();
    vi.spyOn(store, "renewPublicationLease").mockResolvedValue(false);
    const app = createContentPublicationApplication({
      store,
      revisions: repository,
      publisher,
      now: () => clock.shift() ?? "2026-07-27T10:05:00.000Z",
    });
    const approval = await app.commands.approve({
      workspaceId,
      revision: 1,
      approvedBy: membershipId,
      previewConfirmed: true,
    });

    await expect(
      app.commands.publish({
        workspaceId,
        approvalId: approval.id,
        requestedBy: membershipId,
        idempotencyKey: "publish-lease-lost-0001",
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        status: "blocked",
        detail: "publication_lease_lost",
      }),
    );
    expect(createCommit).not.toHaveBeenCalled();
  });

  it("does not enter Git after MCP publication authority is revoked at the commit boundary", async () => {
    const { app, approval } = await approve();
    const assertCurrentAuthority = vi.fn().mockResolvedValue(false);

    const publication = await app.commands.publish({
      workspaceId,
      revision: 1,
      approvalId: approval.id,
      requestedBy: createContentActorId("mcp-agent-56"),
      idempotencyKey: "mcp-revoked-at-publication-boundary",
      assertCurrentAuthority,
    });

    expect(assertCurrentAuthority).toHaveBeenCalled();
    expect(publication.status).toBe("blocked");
    expect(publication.detail).toBe("publication_lease_lost");
    expect(createCommit).not.toHaveBeenCalled();
  });

  it("does not reconcile or verify a refresh after MCP authority is revoked", async () => {
    const { app, approval } = await approve();
    createCommit.mockResolvedValueOnce({
      state: "unknown",
      detail: `git_reference_result_unknown:${"c".repeat(40)}`,
    });
    const inFlight = await app.commands.publish({
      workspaceId,
      revision: 1,
      approvalId: approval.id,
      requestedBy: createContentActorId("mcp-agent-56"),
      idempotencyKey: "mcp-refresh-revoked",
      assertCurrentAuthority: vi.fn().mockResolvedValue(true),
    });
    expect(inFlight.status).toBe("unknown");
    const reconcileCommit = publisher.reconcileCommit as ReturnType<
      typeof vi.fn
    >;
    reconcileCommit.mockClear();
    getDeploymentStatus.mockClear();
    isReleaseLive.mockClear();

    const refreshed = await app.commands.refresh(
      inFlight.id,
      undefined,
      vi.fn().mockResolvedValue(false),
    );

    // No provider read, no deployment signal, no release verification, and no
    // durable state advance: the revoked grant produced no side effect.
    expect(reconcileCommit).not.toHaveBeenCalled();
    expect(getDeploymentStatus).not.toHaveBeenCalled();
    expect(isReleaseLive).not.toHaveBeenCalled();
    expect(refreshed).toEqual(inFlight);
  });

  it("does not verify a release when MCP authority is lost during a refresh", async () => {
    const { app, approval } = await approve();
    const inFlight = await app.commands.publish({
      workspaceId,
      revision: 1,
      approvalId: approval.id,
      requestedBy: createContentActorId("mcp-agent-56"),
      idempotencyKey: "mcp-refresh-revoked-mid-pass",
      assertCurrentAuthority: vi.fn().mockResolvedValue(true),
    });
    getDeploymentStatus.mockClear();
    isReleaseLive.mockClear();
    // The grant is current when the refresh starts and gone by the time it
    // reaches the deployment boundary.
    const assertCurrentAuthority = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);

    const refreshed = await app.commands.refresh(
      inFlight.id,
      undefined,
      assertCurrentAuthority,
    );

    expect(assertCurrentAuthority.mock.calls.length).toBeGreaterThan(1);
    // No Git reconciliation either: the fence is re-checked at every provider
    // crossing this refresh can reach, not only the deployment ones.
    expect(publisher.reconcileCommit).not.toHaveBeenCalled();
    expect(getDeploymentStatus).not.toHaveBeenCalled();
    expect(isReleaseLive).not.toHaveBeenCalled();
    expect(refreshed).toEqual(inFlight);
  });

  it("commits identical bytes, paths and release evidence for human and MCP requests", async () => {
    async function publishOnce(
      requestedBy: Parameters<
        ReturnType<typeof application>["commands"]["publish"]
      >[0]["requestedBy"],
      idempotencyKey: string,
      assertCurrentAuthority?: () => Promise<boolean>,
    ) {
      clock = [
        "2026-07-27T10:01:00.000Z",
        "2026-07-27T10:02:00.000Z",
        "2026-07-27T10:03:00.000Z",
        "2026-07-27T10:04:00.000Z",
      ];
      createCommit.mockClear();
      isReleaseLive.mockClear();
      const { app, approval } = await approve();
      const publication = await app.commands.publish({
        workspaceId,
        revision: 1,
        approvalId: approval.id,
        requestedBy,
        idempotencyKey,
        assertCurrentAuthority,
      });
      const [commitInput] = createCommit.mock.calls[0] ?? [];
      if (commitInput === undefined) {
        throw new Error("expected the shared publisher to be entered");
      }
      // `publishId` is a fresh identity per logical request and
      // `assertLease` is a bound fence, so neither can be equal by value.
      // The commit message carries that same identity as a trailer, so
      // normalize exactly it — nothing else about the message may differ.
      const {
        publishId,
        assertLease: _assertLease,
        message,
        ...rest
      } = commitInput;
      return {
        approval,
        publication,
        publishId,
        committed: {
          ...rest,
          message: message.replaceAll(publishId, "<publish-id>"),
        },
        releaseChecks: isReleaseLive.mock.calls,
      };
    }

    const human = await publishOnce(
      membershipId,
      "publish-parity-human",
    );
    const agent = await publishOnce(
      createContentActorId("mcp-agent-56"),
      "publish-parity-mcp",
      vi.fn().mockResolvedValue(true),
    );

    // Byte-identical serialization, identical Git paths and artifact hash.
    expect(agent.committed).toEqual(human.committed);
    // The normalized trailer really did carry each request's own identity.
    expect(agent.committed.message).toContain("<publish-id>");
    expect(agent.publishId).toBe(agent.publication.id);
    expect(agent.publishId).not.toBe(human.publishId);
    // The commit is attributed to the approving human in both cases, so an
    // agent request cannot present itself as the publication's authority.
    expect(agent.committed.approvedBy).toBe(membershipId);
    // Identical release verification and terminal publication state.
    expect(agent.releaseChecks).toEqual(human.releaseChecks);
    expect(agent.publication.status).toBe(human.publication.status);
    expect(agent.publication.commitSha).toBe(human.publication.commitSha);
    // The approved fingerprint each request published against is the same.
    expect(agent.approval.fingerprint).toEqual(human.approval.fingerprint);
    // Audit evidence still distinguishes who requested the publication.
    expect(agent.publication.requestedBy).not.toBe(
      human.publication.requestedBy,
    );
  });

  it("keeps the lease valid across the bounded GitHub request sequence", async () => {
    let currentTime = "2026-07-27T10:01:00.000Z";
    createCommit.mockImplementation(async (input) => {
      currentTime = "2026-07-27T10:04:30.000Z";
      return (await input.assertLease())
        ? { state: "committed", commitSha: "c".repeat(40) }
        : { state: "blocked", detail: "publication_lease_lost" };
    });
    const app = createContentPublicationApplication({
      store: createInMemoryContentPublicationStore(),
      revisions: repository,
      publisher,
      now: () => currentTime,
    });
    const approval = await app.commands.approve({
      workspaceId,
      revision: 1,
      approvedBy: membershipId,
      previewConfirmed: true,
    });

    await expect(
      app.commands.publish({
        workspaceId,
        approvalId: approval.id,
        requestedBy: membershipId,
        idempotencyKey: "publish-bounded-github-sequence",
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        status: "committed",
        commitSha: "c".repeat(40),
      }),
    );
  });

  it("durably retains a created candidate after its lease expires", async () => {
    let currentTime = "2026-07-27T10:01:00.000Z";
    createCommit.mockImplementation(async (input) => {
      currentTime = "2026-07-27T10:06:01.000Z";
      expect(await input.assertLease()).toBe(false);
      return {
        state: "unknown",
        detail: `git_reference_result_unknown:${"c".repeat(40)}`,
      };
    });
    const app = createContentPublicationApplication({
      store: createInMemoryContentPublicationStore(),
      revisions: repository,
      publisher,
      now: () => currentTime,
    });
    const approval = await app.commands.approve({
      workspaceId,
      revision: 1,
      approvedBy: membershipId,
      previewConfirmed: true,
    });

    await expect(
      app.commands.publish({
        workspaceId,
        approvalId: approval.id,
        requestedBy: membershipId,
        idempotencyKey: "publish-retain-expired-candidate",
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        status: "unknown",
        commitSha: null,
        detail: `git_reference_result_unknown:${"c".repeat(40)}`,
        leaseToken: null,
      }),
    );
  });

  it("loses the application lease when the approved revision stops being current", async () => {
    createCommit.mockImplementation(async (input) => {
      await revisionApplication.application.commands.save({
        actorId: editorId,
        workspaceId,
        schemaVersion: referenceSiteDefinition.schemaVersion,
        baseRevision: 1,
        edits: [{ path: "section_hero.title", value: "Newer headline" }],
        idempotencyKey: "save-after-publication-claim",
      });
      return (await input.assertLease())
        ? { state: "committed", commitSha: "c".repeat(40) }
        : { state: "blocked", detail: "publication_lease_lost" };
    });
    const app = createContentPublicationApplication({
      store: createInMemoryContentPublicationStore(),
      revisions: repository,
      publisher,
      now: () => clock.shift() ?? "2026-07-27T10:05:00.000Z",
    });
    const approval = await app.commands.approve({
      workspaceId,
      revision: 1,
      approvedBy: membershipId,
      previewConfirmed: true,
    });

    await expect(
      app.commands.publish({
        workspaceId,
        approvalId: approval.id,
        requestedBy: membershipId,
        idempotencyKey: "publish-revision-advanced-during-commit",
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        status: "blocked",
        detail: "publication_lease_lost",
      }),
    );
  });

  it("loses the lease when channel configuration changes during Git work", async () => {
    createCommit.mockImplementation(async (input) => {
      vi.mocked(publisher.getChannelConfigurationHash).mockResolvedValue(
        "channel-b",
      );
      return (await input.assertLease())
        ? { state: "committed", commitSha: "c".repeat(40) }
        : { state: "blocked", detail: "publication_lease_lost" };
    });
    const { app, approval } = await approve();

    await expect(
      app.commands.publish({
        workspaceId,
        approvalId: approval.id,
        requestedBy: membershipId,
        idempotencyKey: "publish-channel-changed-during-git",
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        status: "blocked",
        detail: "publication_lease_lost",
      }),
    );
  });

  it("invalidates approval when the live base changes at the final Git boundary", async () => {
    createCommit.mockImplementation(async (input) => {
      isReleaseLive.mockResolvedValue(false);
      return (await input.assertLease())
        ? { state: "committed", commitSha: "c".repeat(40) }
        : { state: "blocked", detail: "publication_lease_lost" };
    });
    const { app, approval } = await approve();

    await expect(
      app.commands.publish({
        workspaceId,
        approvalId: approval.id,
        requestedBy: membershipId,
        idempotencyKey: "publish-live-base-changed-during-git",
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        status: "blocked",
        detail: "publication_lease_lost",
      }),
    );
    await expect(
      app.commands.publish({
        workspaceId,
        approvalId: approval.id,
        requestedBy: membershipId,
        idempotencyKey: "publish-live-base-changed-replay",
      }),
    ).rejects.toEqual(
      new ContentApprovalInvalidError("approval_invalidated"),
    );
  });

  it("replays the recorded operation even after its own commit advanced production", async () => {
    const { app, approval } = await approve();
    const publication = await app.commands.publish({
      workspaceId,
      approvalId: approval.id,
      requestedBy: membershipId,
      idempotencyKey: "publish-after-own-commit-1",
    });
    vi.mocked(publisher.getProductionHead).mockResolvedValue("c".repeat(40));
    isReleaseLive.mockResolvedValue(false);

    await expect(
      app.commands.publish({
        workspaceId,
        approvalId: approval.id,
        requestedBy: membershipId,
        idempotencyKey: "publish-after-own-commit-1",
      }),
    ).resolves.toEqual(publication);
    expect(createCommit).toHaveBeenCalledTimes(1);
  });

  it("preserves an ambiguous Git result as unknown and reconciles without another commit", async () => {
    createCommit.mockRejectedValue(new Error("network lost"));
    const { app, approval } = await approve();
    const publication = await app.commands.publish({
      workspaceId,
      approvalId: approval.id,
      requestedBy: membershipId,
      idempotencyKey: "publish-ambiguous-0001",
    });
    expect(publication.status).toBe("unknown");

    vi.mocked(publisher.reconcileCommit).mockResolvedValue({
      state: "committed",
      commitSha: "e".repeat(40),
    });
    getDeploymentStatus.mockResolvedValue("building");
    const refreshed = await app.commands.refresh(publication.id);

    expect(refreshed).toEqual(
      expect.objectContaining({
        status: "building",
        commitSha: "e".repeat(40),
      }),
    );
    expect(createCommit).toHaveBeenCalledTimes(1);
  });

  it("times out an ambiguous Git result when reconciliation stays unavailable", async () => {
    let currentTime = "2026-07-27T10:01:00.000Z";
    createCommit
      .mockRejectedValueOnce(new Error("network lost"))
      .mockResolvedValueOnce({
        state: "blocked",
        detail: "production_head_moved",
      });
    vi.mocked(publisher.reconcileCommit)
      .mockResolvedValueOnce({ state: "unknown" })
      .mockResolvedValueOnce({ state: "unknown" })
      .mockResolvedValueOnce({ state: "unknown" })
      .mockResolvedValueOnce({
        state: "committed",
        commitSha: "c".repeat(40),
      });
    const store = createInMemoryContentPublicationStore();
    const app = createContentPublicationApplication({
      store,
      revisions: repository,
      publisher,
      now: () => currentTime,
    });
    const approval = await app.commands.approve({
      workspaceId,
      revision: 1,
      approvedBy: membershipId,
      previewConfirmed: true,
    });
    const publication = await app.commands.publish({
      workspaceId,
      approvalId: approval.id,
      requestedBy: membershipId,
      idempotencyKey: "publish-reconcile-timeout",
    });
    expect(publication.status).toBe("unknown");

    currentTime = "2026-07-27T10:16:00.000Z";
    const failed = await app.commands.refresh(publication.id);
    expect(failed).toEqual(
      expect.objectContaining({
        status: "failed",
        detail: "git_reconciliation_timeout",
      }),
    );
    const retried = await app.commands.retryDeployment(
      publication.id,
      membershipId,
    );
    expect(retried).toEqual(
      expect.objectContaining({
        status: "unknown",
        commitSha: null,
        detail: "git_result_unknown",
      }),
    );
    await expect(store.findApproval(approval.id)).resolves.toEqual(
      expect.objectContaining({ invalidatedAt: null }),
    );
    const reconciled = await app.commands.refresh(publication.id);
    expect(reconciled).toEqual(
      expect.objectContaining({
        commitSha: "c".repeat(40),
      }),
    );
    await expect(
      app.commands.publish({
        workspaceId,
        approvalId: approval.id,
        requestedBy: membershipId,
        idempotencyKey: "publish-after-no-sha-timeout",
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        id: reconciled!.id,
        commitSha: "c".repeat(40),
      }),
    );
    expect(createCommit).toHaveBeenCalledTimes(2);
    expect(
      createCommit.mock.calls.map(([input]) => ({
        publishId: input.publishId,
        expectedHead: input.expectedHead,
        message: input.message,
        artifacts: input.artifacts,
        artifactHash: input.artifactHash,
      })),
    ).toEqual([
      expect.objectContaining({
        publishId: publication.id,
        expectedHead: productionCommit,
      }),
      expect.objectContaining({
        publishId: publication.id,
        expectedHead: productionCommit,
      }),
    ]);
    expect(createCommit.mock.calls[1]![0].message).toBe(
      createCommit.mock.calls[0]![0].message,
    );
    expect(createCommit.mock.calls[1]![0].artifacts).toEqual(
      createCommit.mock.calls[0]![0].artifacts,
    );
    expect(createCommit.mock.calls[1]![0].artifactHash).toBe(
      createCommit.mock.calls[0]![0].artifactHash,
    );
    expect(publisher.reconcileCommit).toHaveBeenCalledTimes(4);
    expect(publisher.retryDeployment).not.toHaveBeenCalled();
  });

  it("keeps a missed ambiguous commit active until the reconciliation deadline", async () => {
    let currentTime = "2026-07-27T10:01:00.000Z";
    createCommit.mockResolvedValue({
      state: "unknown",
      detail: `git_reference_result_unknown:${"c".repeat(40)}`,
    });
    vi.mocked(publisher.reconcileCommit).mockResolvedValue({
      state: "not-found",
    });
    const app = createContentPublicationApplication({
      store: createInMemoryContentPublicationStore(),
      revisions: repository,
      publisher,
      now: () => currentTime,
    });
    const approval = await app.commands.approve({
      workspaceId,
      revision: 1,
      approvedBy: membershipId,
      previewConfirmed: true,
    });
    const publication = await app.commands.publish({
      workspaceId,
      approvalId: approval.id,
      requestedBy: membershipId,
      idempotencyKey: "publish-reconcile-miss",
    });

    currentTime = "2026-07-27T10:05:00.000Z";
    await expect(app.commands.refresh(publication.id)).resolves.toEqual(
      expect.objectContaining({ status: "unknown" }),
    );
    expect(publisher.reconcileCommit).toHaveBeenCalledWith(
      expect.objectContaining({
        publishId: publication.id,
        candidateCommitSha: "c".repeat(40),
        expectedHead: publication.expectedHead,
        artifacts: expect.arrayContaining([
          expect.objectContaining({
            path: "foundry/published-site.json",
          }),
          expect.objectContaining({
            path: "content/rich-text/section_contact/body.md",
          }),
        ]),
        artifactHash: approval.fingerprint.artifactHash,
        contentHash: approval.fingerprint.contentHash,
      }),
    );

    currentTime = "2026-07-27T10:16:00.000Z";
    const failed = await app.commands.refresh(publication.id);
    expect(failed).toEqual(
      expect.objectContaining({
        status: "failed",
        detail: `git_reference_not_advanced:${"c".repeat(40)}`,
      }),
    );
    await expect(
      app.commands.publish({
        workspaceId,
        approvalId: approval.id,
        requestedBy: membershipId,
        idempotencyKey: "publish-reconcile-miss-new-key",
      }),
    ).resolves.toEqual(failed);
    expect(createCommit).toHaveBeenCalledTimes(1);

    await expect(
      app.commands.retryDeployment(publication.id, membershipId),
    ).resolves.toEqual(
      expect.objectContaining({
        status: "committed",
        commitSha: "c".repeat(40),
        detail: null,
      }),
    );
    expect(publisher.retryReference).toHaveBeenCalledWith(
      expect.objectContaining({
        publishId: publication.id,
        candidateCommitSha: "c".repeat(40),
        expectedHead: productionCommit,
        artifacts: expect.arrayContaining([
          expect.objectContaining({
            path: "foundry/published-site.json",
          }),
          expect.objectContaining({
            path: "content/rich-text/section_contact/body.md",
          }),
        ]),
        artifactHash: approval.fingerprint.artifactHash,
      }),
    );
  });

  it("preserves a retained candidate when its ref-retry Worker disappears", async () => {
    let currentTime = "2026-07-27T10:01:00.000Z";
    createCommit.mockResolvedValue({
      state: "unknown",
      detail: `git_reference_result_unknown:${"c".repeat(40)}`,
    });
    vi.mocked(publisher.reconcileCommit).mockResolvedValue({
      state: "not-found",
    });
    const app = createContentPublicationApplication({
      store: createInMemoryContentPublicationStore(),
      revisions: repository,
      publisher,
      now: () => currentTime,
    });
    const approval = await app.commands.approve({
      workspaceId,
      revision: 1,
      approvedBy: membershipId,
      previewConfirmed: true,
    });
    const publication = await app.commands.publish({
      workspaceId,
      approvalId: approval.id,
      requestedBy: membershipId,
      idempotencyKey: "publish-ref-retry-worker-loss",
    });
    currentTime = "2026-07-27T10:16:00.000Z";
    await app.commands.refresh(publication.id);

    let resolveReferenceRetry:
      | ((result: Awaited<
          ReturnType<ContentPublisher["retryReference"]>
        >) => void)
      | undefined;
    vi.mocked(publisher.retryReference).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveReferenceRetry = resolve;
        }),
    );
    const retry = app.commands.retryDeployment(publication.id, membershipId);
    await vi.waitFor(() =>
      expect(publisher.retryReference).toHaveBeenCalled(),
    );

    currentTime = "2026-07-27T10:32:00.000Z";
    const recovered = await app.commands.refresh(publication.id);
    expect(recovered).toEqual(
      expect.objectContaining({
        status: "failed",
        commitSha: null,
        detail: `git_reference_not_advanced:${"c".repeat(40)}`,
      }),
    );
    resolveReferenceRetry?.({
      state: "committed",
      commitSha: "c".repeat(40),
    });
    await retry;

    vi.mocked(publisher.retryReference).mockResolvedValue({
      state: "committed",
      commitSha: "c".repeat(40),
    });
    await expect(
      app.commands.retryDeployment(publication.id, membershipId),
    ).resolves.toEqual(
      expect.objectContaining({
        status: "committed",
        commitSha: "c".repeat(40),
      }),
    );
  });

  it("does not advance a retained Git reference after MCP schedule authority is revoked", async () => {
    let currentTime = "2026-07-27T10:01:00.000Z";
    createCommit.mockResolvedValue({
      state: "unknown",
      detail: `git_reference_result_unknown:${"c".repeat(40)}`,
    });
    vi.mocked(publisher.reconcileCommit).mockResolvedValue({
      state: "not-found",
    });
    const app = createContentPublicationApplication({
      store: createInMemoryContentPublicationStore(),
      revisions: repository,
      publisher,
      now: () => currentTime,
    });
    const approval = await app.commands.approve({
      workspaceId,
      revision: 1,
      approvedBy: membershipId,
      previewConfirmed: true,
    });
    const publication = await app.commands.publish({
      workspaceId,
      approvalId: approval.id,
      requestedBy: membershipId,
      idempotencyKey: "publish-ref-retry-mcp-revoked",
    });
    currentTime = "2026-07-27T10:16:00.000Z";
    await app.commands.refresh(publication.id);
    let gitReferenceAdvanced = false;
    vi.mocked(publisher.retryReference).mockImplementation(
      async ({ assertLease }) => {
        if (await assertLease()) {
          gitReferenceAdvanced = true;
          return {
            state: "committed",
            commitSha: "c".repeat(40),
          };
        }
        return {
          state: "blocked",
          detail: "publication_lease_lost",
        };
      },
    );
    const assertCurrentAuthority = vi.fn().mockResolvedValue(false);

    await expect(
      app.commands.retryDeployment(
        publication.id,
        createContentActorId("mcp-scheduled-agent"),
        undefined,
        assertCurrentAuthority,
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        status: "failed",
        detail: `git_reference_not_advanced:${"c".repeat(40)}`,
      }),
    );
    expect(assertCurrentAuthority).toHaveBeenCalled();
    expect(gitReferenceAdvanced).toBe(false);
  });

  it("reconciles a retained candidate that reached production before retrying its deployment", async () => {
    let currentTime = "2026-07-27T10:01:00.000Z";
    const candidateCommitSha = "c".repeat(40);
    createCommit.mockResolvedValue({
      state: "unknown",
      detail: `git_reference_result_unknown:${candidateCommitSha}`,
    });
    vi.mocked(publisher.reconcileCommit).mockResolvedValue({
      state: "not-found",
    });
    const app = createContentPublicationApplication({
      store: createInMemoryContentPublicationStore(),
      revisions: repository,
      publisher,
      now: () => currentTime,
    });
    const approval = await app.commands.approve({
      workspaceId,
      revision: 1,
      approvedBy: membershipId,
      previewConfirmed: true,
    });
    const publication = await app.commands.publish({
      workspaceId,
      approvalId: approval.id,
      requestedBy: membershipId,
      idempotencyKey: "publish-reconcile-before-retry",
    });
    currentTime = "2026-07-27T10:16:00.000Z";
    await app.commands.refresh(publication.id);
    vi.mocked(publisher.reconcileCommit).mockResolvedValue({
      state: "committed",
      commitSha: candidateCommitSha,
    });
    vi.mocked(publisher.getProductionHead).mockResolvedValue(
      candidateCommitSha,
    );
    getDeploymentStatus.mockResolvedValue("building");
    isReleaseLive.mockResolvedValue(false);

    await expect(
      app.commands.retryDeployment(publication.id, membershipId),
    ).resolves.toEqual(
      expect.objectContaining({
        status: "building",
        commitSha: candidateCommitSha,
        detail: "deployment_retry_reconciled",
        deploymentId: null,
      }),
    );
    expect(publisher.reconcileCommit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        publishId: publication.id,
        candidateCommitSha,
        expectedHead: publication.expectedHead,
        artifactHash: approval.fingerprint.artifactHash,
        contentHash: approval.fingerprint.contentHash,
      }),
    );
    expect(publisher.retryReference).not.toHaveBeenCalled();
    expect(getDeploymentStatus).toHaveBeenCalledWith(
      candidateCommitSha,
      undefined,
    );
    expect(publisher.retryDeployment).not.toHaveBeenCalled();
  });

  it("preserves a retained candidate through a channel-configuration timeout", async () => {
    let currentTime = "2026-07-27T10:01:00.000Z";
    const candidateCommitSha = "c".repeat(40);
    createCommit.mockResolvedValue({
      state: "unknown",
      detail: `git_reference_result_unknown:${candidateCommitSha}`,
    });
    const app = createContentPublicationApplication({
      store: createInMemoryContentPublicationStore(),
      revisions: repository,
      publisher,
      now: () => currentTime,
    });
    const approval = await app.commands.approve({
      workspaceId,
      revision: 1,
      approvedBy: membershipId,
      previewConfirmed: true,
    });
    const publication = await app.commands.publish({
      workspaceId,
      approvalId: approval.id,
      requestedBy: membershipId,
      idempotencyKey: "publish-candidate-channel-timeout",
    });
    vi.mocked(publisher.getChannelConfigurationHash).mockRejectedValue(
      new Error("channel_unavailable"),
    );
    currentTime = "2026-07-27T10:16:00.000Z";

    await expect(app.commands.refresh(publication.id)).resolves.toEqual(
      expect.objectContaining({
        status: "failed",
        commitSha: null,
        detail: `git_reference_result_unknown:${candidateCommitSha}`,
      }),
    );

    vi.mocked(publisher.getChannelConfigurationHash).mockResolvedValue(
      "channel-a",
    );
    vi.mocked(publisher.reconcileCommit).mockResolvedValue({
      state: "committed",
      commitSha: candidateCommitSha,
    });
    vi.mocked(publisher.getProductionHead).mockResolvedValue(
      candidateCommitSha,
    );
    isReleaseLive.mockResolvedValue(false);
    await expect(
      app.commands.retryDeployment(publication.id, membershipId),
    ).resolves.toEqual(
      expect.objectContaining({
        status: "building",
        commitSha: candidateCommitSha,
        detail: "deployment_retry_reconciled",
      }),
    );
    expect(publisher.retryDeployment).not.toHaveBeenCalled();
  });

  it("preserves a no-SHA Git outcome through a channel-configuration timeout", async () => {
    let currentTime = "2026-07-27T10:01:00.000Z";
    createCommit.mockRejectedValue(new Error("atomic_response_lost"));
    const app = createContentPublicationApplication({
      store: createInMemoryContentPublicationStore(),
      revisions: repository,
      publisher,
      now: () => currentTime,
    });
    const approval = await app.commands.approve({
      workspaceId,
      revision: 1,
      approvedBy: membershipId,
      previewConfirmed: true,
    });
    const publication = await app.commands.publish({
      workspaceId,
      approvalId: approval.id,
      requestedBy: membershipId,
      idempotencyKey: "publish-no-sha-channel-timeout",
    });
    vi.mocked(publisher.getChannelConfigurationHash).mockRejectedValue(
      new Error("channel_unavailable"),
    );
    currentTime = "2026-07-27T10:16:00.000Z";

    await expect(app.commands.refresh(publication.id)).resolves.toEqual(
      expect.objectContaining({
        status: "failed",
        commitSha: null,
        detail: "git_result_unknown",
      }),
    );

    vi.mocked(publisher.getChannelConfigurationHash).mockResolvedValue(
      "channel-a",
    );
    vi.mocked(publisher.reconcileCommit).mockResolvedValue({
      state: "committed",
      commitSha: "c".repeat(40),
    });
    vi.mocked(publisher.getProductionHead).mockResolvedValue("c".repeat(40));
    isReleaseLive.mockResolvedValue(false);
    await app.commands.retryDeployment(publication.id, membershipId);
    expect(publisher.reconcileCommit).toHaveBeenCalled();
  });

  it("records an exact ambiguous commit before rejecting a changed channel", async () => {
    let currentTime = "2026-07-27T10:01:00.000Z";
    const commitSha = "c".repeat(40);
    createCommit.mockRejectedValue(new Error("atomic_response_lost"));
    const app = createContentPublicationApplication({
      store: createInMemoryContentPublicationStore(),
      revisions: repository,
      publisher,
      now: () => currentTime,
    });
    const approval = await app.commands.approve({
      workspaceId,
      revision: 1,
      approvedBy: membershipId,
      previewConfirmed: true,
    });
    const publication = await app.commands.publish({
      workspaceId,
      approvalId: approval.id,
      requestedBy: membershipId,
      idempotencyKey: "publish-no-sha-channel-changed",
    });
    vi.mocked(publisher.getChannelConfigurationHash).mockResolvedValue(
      "channel-b",
    );
    vi.mocked(publisher.reconcileCommit).mockResolvedValue({
      state: "committed",
      commitSha,
    });
    currentTime = "2026-07-27T10:16:00.000Z";

    await expect(app.commands.refresh(publication.id)).resolves.toEqual(
      expect.objectContaining({
        status: "failed",
        commitSha,
        detail: "publication_channel_changed",
      }),
    );
    expect(publisher.reconcileCommit).toHaveBeenCalledWith(
      expect.objectContaining({
        publishId: publication.id,
        candidateCommitSha: undefined,
      }),
    );
  });

  it("invalidates a retained candidate before ref retry when its live base changes", async () => {
    let currentTime = "2026-07-27T10:01:00.000Z";
    const candidateCommitSha = "c".repeat(40);
    createCommit.mockResolvedValue({
      state: "unknown",
      detail: `git_reference_result_unknown:${candidateCommitSha}`,
    });
    vi.mocked(publisher.reconcileCommit).mockResolvedValue({
      state: "not-found",
    });
    const app = createContentPublicationApplication({
      store: createInMemoryContentPublicationStore(),
      revisions: repository,
      publisher,
      now: () => currentTime,
    });
    const approval = await app.commands.approve({
      workspaceId,
      revision: 1,
      approvedBy: membershipId,
      previewConfirmed: true,
    });
    const publication = await app.commands.publish({
      workspaceId,
      approvalId: approval.id,
      requestedBy: membershipId,
      idempotencyKey: "publish-retained-live-base-race",
    });
    currentTime = "2026-07-27T10:16:00.000Z";
    await app.commands.refresh(publication.id);
    vi.mocked(publisher.getProductionHead).mockResolvedValue(productionCommit);
    let referenceAdvanced = false;
    vi.mocked(publisher.retryReference).mockImplementation(
      async ({ assertLease }) => {
        isReleaseLive.mockResolvedValue(false);
        if (await assertLease()) {
          referenceAdvanced = true;
          return { state: "committed", commitSha: candidateCommitSha };
        }
        return { state: "blocked", detail: "publication_lease_lost" };
      },
    );

    await expect(
      app.commands.retryDeployment(publication.id, membershipId),
    ).resolves.toEqual(
      expect.objectContaining({
        status: "failed",
        commitSha: null,
        detail: `git_reference_not_advanced:${candidateCommitSha}`,
      }),
    );
    expect(referenceAdvanced).toBe(false);
    await expect(
      app.commands.retryDeployment(publication.id, membershipId),
    ).rejects.toEqual(
      new ContentApprovalInvalidError("approval_invalidated"),
    );
  });

  it.each([
    ["requested", "committed"],
    ["building", "building"],
    ["failed", "failed"],
    ["unknown", "committed"],
  ] as const)("reports deployment state %s explicitly", async (external, expected) => {
    const { app, approval } = await approve();
    const publication = await app.commands.publish({
      workspaceId,
      approvalId: approval.id,
      requestedBy: membershipId,
      idempotencyKey: `publish-state-${external}-0001`,
    });
    getDeploymentStatus.mockResolvedValue(external);

    await expect(app.commands.refresh(publication.id)).resolves.toEqual(
      expect.objectContaining({ status: expected }),
    );
  });

  it("reports deployed until the exact marker is repeatedly verified live", async () => {
    const { app, approval } = await approve();
    const publication = await app.commands.publish({
      workspaceId,
      approvalId: approval.id,
      requestedBy: membershipId,
      idempotencyKey: "publish-live-check-0001",
    });
    getDeploymentStatus.mockResolvedValue("deployed");
    isReleaseLive.mockResolvedValue(false);

    await expect(app.commands.refresh(publication.id)).resolves.toEqual(
      expect.objectContaining({
        status: "deployed",
        detail: "release_marker_pending",
      }),
    );

    isReleaseLive.mockResolvedValue(true);
    await expect(app.commands.refresh(publication.id)).resolves.toEqual(
      expect.objectContaining({
        status: "verified-live",
        detail: null,
      }),
    );
    expect(isReleaseLive).toHaveBeenLastCalledWith({
      commitSha: "c".repeat(40),
      contentHash: revisionApplication.saved.inputs.contentHash,
      schemaVersion: referenceSiteDefinition.schemaVersion,
    });
  });

  it.each(["requested", "unknown"] as const)(
    "releases the global publication slot when deployment remains %s",
    async (deployment) => {
      let currentTime = "2026-07-27T10:01:00.000Z";
      const app = createContentPublicationApplication({
        store: createInMemoryContentPublicationStore(),
        revisions: repository,
        publisher,
        now: () => currentTime,
      });
      const approval = await app.commands.approve({
        workspaceId,
        revision: 1,
        approvedBy: membershipId,
        previewConfirmed: true,
      });
      const publication = await app.commands.publish({
        workspaceId,
        approvalId: approval.id,
        requestedBy: membershipId,
        idempotencyKey: "publish-deploy-timeout-1",
      });
      getDeploymentStatus.mockResolvedValue(deployment);
      currentTime = "2026-07-27T10:16:00.000Z";

      await expect(app.commands.refresh(publication.id)).resolves.toEqual(
        expect.objectContaining({
          status: "failed",
          commitSha: "c".repeat(40),
          detail: "deployment_signal_timeout",
        }),
      );
    },
  );

  it("times out a build that remains in progress", async () => {
    let currentTime = "2026-07-27T10:01:00.000Z";
    const app = createContentPublicationApplication({
      store: createInMemoryContentPublicationStore(),
      revisions: repository,
      publisher,
      now: () => currentTime,
    });
    const approval = await app.commands.approve({
      workspaceId,
      revision: 1,
      approvedBy: membershipId,
      previewConfirmed: true,
    });
    const publication = await app.commands.publish({
      workspaceId,
      approvalId: approval.id,
      requestedBy: membershipId,
      idempotencyKey: "publish-build-timeout-01",
    });
    getDeploymentStatus.mockResolvedValue("building");
    currentTime = "2026-07-27T10:02:00.000Z";
    await expect(app.commands.refresh(publication.id)).resolves.toEqual(
      expect.objectContaining({ status: "building" }),
    );

    currentTime = "2026-07-27T10:16:00.000Z";
    await expect(app.commands.refresh(publication.id)).resolves.toEqual(
      expect.objectContaining({
        status: "failed",
        commitSha: "c".repeat(40),
        detail: "deployment_signal_timeout",
      }),
    );
  });

  it("keeps a failed publication terminal until an explicit retry", async () => {
    const { app, approval } = await approve();
    const publication = await app.commands.publish({
      workspaceId,
      approvalId: approval.id,
      requestedBy: membershipId,
      idempotencyKey: "publish-terminal-failure",
    });
    getDeploymentStatus.mockResolvedValue("failed");
    const failed = await app.commands.refresh(publication.id);
    getDeploymentStatus.mockResolvedValue("building");

    await expect(app.commands.refresh(publication.id)).resolves.toEqual(failed);
    expect(getDeploymentStatus).toHaveBeenCalledTimes(1);
  });

  it("retries the exact failed commit without creating another commit", async () => {
    const { app, approval } = await approve();
    const publication = await app.commands.publish({
      workspaceId,
      approvalId: approval.id,
      requestedBy: membershipId,
      idempotencyKey: "publish-retry-exact-commit",
    });
    getDeploymentStatus.mockResolvedValue("failed");
    await app.commands.refresh(publication.id);
    vi.mocked(publisher.getProductionHead).mockResolvedValue("c".repeat(40));
    isReleaseLive.mockResolvedValue(false);

    await expect(
      app.commands.retryDeployment(publication.id, membershipId),
    ).resolves.toEqual(
      expect.objectContaining({
        status: "committed",
        commitSha: "c".repeat(40),
        detail: "deployment_retry_requested",
        deploymentId: "build-123",
      }),
    );
    expect(publisher.retryDeployment).toHaveBeenCalledWith({
      commitSha: "c".repeat(40),
      assertDispatch: expect.any(Function),
    });
    expect(createCommit).toHaveBeenCalledTimes(1);

    getDeploymentStatus.mockResolvedValue("building");
    await expect(app.commands.refresh(publication.id)).resolves.toEqual(
      expect.objectContaining({
        status: "building",
        deploymentId: "build-123",
      }),
    );
    expect(getDeploymentStatus).toHaveBeenLastCalledWith(
      "c".repeat(40),
      "build-123",
    );
  });

  it("carries the exact scheduler reservation through every deployment retry mutation", async () => {
    const underlyingStore = createInMemoryContentPublicationStore();
    const observedProofs: unknown[] = [];
    let captureRetryMutations = false;
    const store = {
      ...underlyingStore,
      async updatePublication(
        ...args: Parameters<typeof underlyingStore.updatePublication>
      ) {
        if (captureRetryMutations) {
          observedProofs.push(args[1]?.reservationProof);
        }
        return underlyingStore.updatePublication(...args);
      },
      async renewPublicationLease(
        ...args: Parameters<typeof underlyingStore.renewPublicationLease>
      ) {
        if (captureRetryMutations) {
          observedProofs.push(args[0].reservationProof);
        }
        return underlyingStore.renewPublicationLease(...args);
      },
    };
    const app = createContentPublicationApplication({
      store,
      revisions: repository,
      publisher,
      now: () => clock.shift() ?? "2026-07-27T10:05:00.000Z",
    });
    const approval = await app.commands.approve({
      workspaceId,
      revision: 1,
      approvedBy: membershipId,
      previewConfirmed: true,
    });
    const publication = await app.commands.publish({
      workspaceId,
      approvalId: approval.id,
      requestedBy: membershipId,
      idempotencyKey: "publish-reservation-fenced-retry",
    });
    getDeploymentStatus.mockResolvedValue("failed");
    await app.commands.refresh(publication.id);
    vi.mocked(publisher.getProductionHead).mockResolvedValue("c".repeat(40));
    isReleaseLive.mockResolvedValue(false);
    const reservationProof = {
      executionId: "execution-reservation-fenced-retry",
      attempt: 2,
      leaseToken: "scheduler-reservation-fenced-retry",
    };

    captureRetryMutations = true;
    await app.commands.retryDeployment(
      publication.id,
      membershipId,
      reservationProof,
    );

    expect(observedProofs.length).toBeGreaterThanOrEqual(3);
    expect(observedProofs).toEqual(
      observedProofs.map(() => reservationProof),
    );
  });

  it("carries the exact scheduler reservation through every initial publish mutation", async () => {
    const underlyingStore = createInMemoryContentPublicationStore();
    const observedProofs: unknown[] = [];
    const store = {
      ...underlyingStore,
      async updatePublication(
        ...args: Parameters<typeof underlyingStore.updatePublication>
      ) {
        observedProofs.push(args[1]?.reservationProof);
        return underlyingStore.updatePublication(...args);
      },
      async renewPublicationLease(
        ...args: Parameters<typeof underlyingStore.renewPublicationLease>
      ) {
        observedProofs.push(args[0].reservationProof);
        return underlyingStore.renewPublicationLease(...args);
      },
    };
    const app = createContentPublicationApplication({
      store,
      revisions: repository,
      publisher,
      now: () => clock.shift() ?? "2026-07-27T10:05:00.000Z",
    });
    const approval = await app.commands.approve({
      workspaceId,
      revision: 1,
      approvedBy: membershipId,
      previewConfirmed: true,
    });
    const reservationProof = {
      executionId: "execution-reservation-fenced-publish",
      attempt: 1,
      leaseToken: "scheduler-reservation-fenced-publish",
    };

    await app.commands.publish({
      workspaceId,
      approvalId: approval.id,
      requestedBy: membershipId,
      idempotencyKey: "publish-reservation-fenced-initial",
      reservationProof,
    });

    expect(observedProofs.length).toBeGreaterThanOrEqual(2);
    expect(observedProofs).toEqual(
      observedProofs.map(() => reservationProof),
    );
  });

  it("does not adopt schedule A's terminal publication for schedule B", async () => {
    const underlyingStore = createInMemoryContentPublicationStore();
    const findLatestPublication = vi.fn(
      underlyingStore.findLatestPublication,
    );
    const findActivePublication = vi.fn(
      underlyingStore.findActivePublication,
    );
    const store = {
      ...underlyingStore,
      findLatestPublication,
      findActivePublication,
    };
    const app = createContentPublicationApplication({
      store,
      revisions: repository,
      publisher,
      now: () => clock.shift() ?? "2026-07-27T10:05:00.000Z",
    });
    const approval = await app.commands.approve({
      workspaceId,
      revision: 1,
      approvedBy: membershipId,
      previewConfirmed: true,
    });
    const scheduleA = await app.commands.publish({
      workspaceId,
      approvalId: approval.id,
      requestedBy: membershipId,
      idempotencyKey: "scheduled-publication:schedule-a",
    });
    const failedA = await underlyingStore.updatePublication({
      ...scheduleA,
      status: "failed",
      detail: "deployment_failed",
      leaseToken: null,
      leaseExpiresAt: null,
      updatedAt: "2026-07-27T10:04:30.000Z",
    }, {
      expectedStatus: scheduleA.status,
      expectedUpdatedAt: scheduleA.updatedAt,
    });
    expect(failedA.status).toBe("failed");
    findLatestPublication.mockClear();
    findActivePublication.mockClear();

    const scheduleB = await app.commands.publish({
      workspaceId,
      approvalId: approval.id,
      requestedBy: membershipId,
      idempotencyKey: "scheduled-publication:schedule-b",
      reservationProof: {
        executionId: "execution-schedule-b",
        attempt: 1,
        leaseToken: "lease-schedule-b",
      },
    });

    expect(scheduleB.id).not.toBe(scheduleA.id);
    expect(scheduleB.idempotencyKey).toBe(
      "scheduled-publication:schedule-b",
    );
    expect(findLatestPublication).not.toHaveBeenCalled();
    expect(findActivePublication).not.toHaveBeenCalled();
  });

  it("carries the exact scheduler reservation through publication refresh mutations", async () => {
    const underlyingStore = createInMemoryContentPublicationStore();
    const observedProofs: unknown[] = [];
    let captureRefreshMutations = false;
    const store = {
      ...underlyingStore,
      async updatePublication(
        ...args: Parameters<typeof underlyingStore.updatePublication>
      ) {
        if (captureRefreshMutations) {
          observedProofs.push(args[1]?.reservationProof);
        }
        return underlyingStore.updatePublication(...args);
      },
    };
    const app = createContentPublicationApplication({
      store,
      revisions: repository,
      publisher,
      now: () => clock.shift() ?? "2026-07-27T10:05:00.000Z",
    });
    const approval = await app.commands.approve({
      workspaceId,
      revision: 1,
      approvedBy: membershipId,
      previewConfirmed: true,
    });
    const publication = await app.commands.publish({
      workspaceId,
      approvalId: approval.id,
      requestedBy: membershipId,
      idempotencyKey: "publish-reservation-fenced-refresh",
    });
    const reservationProof = {
      executionId: "execution-reservation-fenced-refresh",
      attempt: 3,
      leaseToken: "scheduler-reservation-fenced-refresh",
    };
    getDeploymentStatus.mockResolvedValue("building");

    captureRefreshMutations = true;
    await app.commands.refresh(publication.id, reservationProof);

    expect(observedProofs.length).toBeGreaterThanOrEqual(1);
    expect(observedProofs).toEqual(
      observedProofs.map(() => reservationProof),
    );
  });

  it("never resends a known manual build after timeout without exact failure evidence", async () => {
    let currentTime = "2026-07-27T10:01:00.000Z";
    const app = createContentPublicationApplication({
      store: createInMemoryContentPublicationStore(),
      revisions: repository,
      publisher,
      now: () => currentTime,
    });
    const approval = await app.commands.approve({
      workspaceId,
      revision: 1,
      approvedBy: membershipId,
      previewConfirmed: true,
    });
    const publication = await app.commands.publish({
      workspaceId,
      approvalId: approval.id,
      requestedBy: membershipId,
      idempotencyKey: "publish-known-build-timeout",
    });
    getDeploymentStatus.mockResolvedValue("failed");
    await app.commands.refresh(publication.id);
    vi.mocked(publisher.getProductionHead).mockResolvedValue("c".repeat(40));
    isReleaseLive.mockResolvedValue(false);
    await app.commands.retryDeployment(publication.id, membershipId);

    currentTime = "2026-07-27T10:18:00.000Z";
    getDeploymentStatus.mockResolvedValue("building");
    await expect(app.commands.refresh(publication.id)).resolves.toEqual(
      expect.objectContaining({
        status: "failed",
        detail: "deployment_retry_timeout",
        deploymentId: "build-123",
      }),
    );
    getDeploymentStatus.mockResolvedValue("requested");
    await expect(
      app.commands.retryDeployment(publication.id, membershipId),
    ).resolves.toEqual(
      expect.objectContaining({
        status: "failed",
        detail: "deployment_retry_timeout",
      }),
    );
    getDeploymentStatus.mockClear();
    getDeploymentStatus.mockResolvedValue("unknown");
    await expect(
      app.commands.retryDeployment(publication.id, membershipId),
    ).resolves.toEqual(
      expect.objectContaining({
        status: "failed",
        detail: "deployment_retry_timeout",
        deploymentId: "build-123",
      }),
    );
    expect(getDeploymentStatus).toHaveBeenCalledWith(
      "c".repeat(40),
      "build-123",
    );
    expect(publisher.retryDeployment).toHaveBeenCalledTimes(1);
  });

  it("invalidates retry authority when the initial production-head check mismatches", async () => {
    const { app, approval } = await approve();
    const publication = await app.commands.publish({
      workspaceId,
      approvalId: approval.id,
      requestedBy: membershipId,
      idempotencyKey: "publish-retry-initial-head-mismatch",
    });
    getDeploymentStatus.mockResolvedValue("failed");
    await app.commands.refresh(publication.id);
    vi.mocked(publisher.getProductionHead).mockResolvedValue("d".repeat(40));
    isReleaseLive.mockResolvedValue(false);

    await expect(
      app.commands.retryDeployment(publication.id, membershipId),
    ).rejects.toEqual(
      new ContentPublicationValidationError(
        "deployment_retry_head_moved",
      ),
    );
    await expect(
      app.commands.retryDeployment(publication.id, membershipId),
    ).rejects.toEqual(
      new ContentApprovalInvalidError("approval_invalidated"),
    );
    expect(publisher.retryDeployment).not.toHaveBeenCalled();
  });

  it("rechecks the exact production head after claiming a deployment retry", async () => {
    const { app, approval } = await approve();
    const publication = await app.commands.publish({
      workspaceId,
      approvalId: approval.id,
      requestedBy: membershipId,
      idempotencyKey: "publish-retry-post-claim-head-race",
    });
    getDeploymentStatus.mockResolvedValue("failed");
    await app.commands.refresh(publication.id);
    isReleaseLive.mockResolvedValue(false);
    vi.mocked(publisher.getProductionHead)
      .mockResolvedValueOnce("c".repeat(40))
      .mockResolvedValueOnce("d".repeat(40));

    await expect(
      app.commands.retryDeployment(publication.id, membershipId),
    ).resolves.toEqual(
      expect.objectContaining({
        status: "failed",
        detail: "deployment_retry_head_moved",
        deploymentId: null,
        leaseToken: null,
        leaseExpiresAt: null,
      }),
    );
    await expect(
      app.commands.retryDeployment(publication.id, membershipId),
    ).rejects.toEqual(
      new ContentApprovalInvalidError("approval_invalidated"),
    );
    expect(publisher.getProductionHead).toHaveBeenCalledTimes(3);
    expect(publisher.retryDeployment).not.toHaveBeenCalled();
  });

  it("fails closed when the production head changes at the provider boundary", async () => {
    const { app, approval } = await approve();
    const publication = await app.commands.publish({
      workspaceId,
      approvalId: approval.id,
      requestedBy: membershipId,
      idempotencyKey: "publish-retry-provider-head-race",
    });
    getDeploymentStatus.mockResolvedValue("failed");
    await app.commands.refresh(publication.id);
    isReleaseLive.mockResolvedValue(false);
    let atProviderBoundary = false;
    vi.mocked(publisher.getProductionHead).mockImplementation(
      async () => (atProviderBoundary ? "d".repeat(40) : "c".repeat(40)),
    );
    let providerDispatched = false;
    vi.mocked(publisher.retryDeployment).mockImplementation(
      async ({ assertDispatch }) => {
        atProviderBoundary = true;
        if (await assertDispatch()) {
          providerDispatched = true;
          return { state: "requested", deploymentId: "build-raced" };
        }
        return {
          state: "blocked",
          detail: "deployment_retry_claim_lost",
        };
      },
    );

    await expect(
      app.commands.retryDeployment(publication.id, membershipId),
    ).resolves.toEqual(
      expect.objectContaining({
        status: "failed",
        detail: "deployment_retry_head_moved",
        deploymentId: null,
      }),
    );
    expect(providerDispatched).toBe(false);
    await expect(
      app.commands.retryDeployment(publication.id, membershipId),
    ).rejects.toEqual(
      new ContentApprovalInvalidError("approval_invalidated"),
    );
  });

  it("does not dispatch Cloudflare after MCP schedule authority is revoked at the provider boundary", async () => {
    const app = createContentPublicationApplication({
      store: createInMemoryContentPublicationStore(),
      revisions: repository,
      publisher,
      now: () => clock.shift() ?? "2026-07-27T10:05:00.000Z",
    });
    const { approval } = await approve(app);
    const publication = await app.commands.publish({
      workspaceId,
      approvalId: approval.id,
      requestedBy: membershipId,
      idempotencyKey: "publish-retry-mcp-authority-race",
    });
    getDeploymentStatus.mockResolvedValue("failed");
    await app.commands.refresh(publication.id);
    isReleaseLive.mockResolvedValue(false);
    vi.mocked(publisher.getProductionHead).mockResolvedValue("c".repeat(40));
    let providerDispatched = false;
    vi.mocked(publisher.retryDeployment).mockImplementation(
      async ({ assertDispatch }) => {
        if (await assertDispatch()) {
          providerDispatched = true;
          return { state: "requested", deploymentId: "build-raced" };
        }
        return {
          state: "blocked",
          detail: "deployment_retry_claim_lost",
        };
      },
    );
    const assertCurrentAuthority = vi.fn().mockResolvedValue(false);

    await expect(
      app.commands.retryDeployment(
        publication.id,
        createContentActorId("mcp-scheduled-agent"),
        undefined,
        assertCurrentAuthority,
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        status: "failed",
        detail: "deployment_retry_claim_lost",
      }),
    );
    expect(assertCurrentAuthority).toHaveBeenCalled();
    expect(providerDispatched).toBe(false);
  });

  it("fails closed when approval becomes invalid at the provider boundary", async () => {
    const store = createInMemoryContentPublicationStore();
    const app = createContentPublicationApplication({
      store,
      revisions: repository,
      publisher,
      now: () => clock.shift() ?? "2026-07-27T10:05:00.000Z",
    });
    const { approval } = await approve(app);
    const publication = await app.commands.publish({
      workspaceId,
      approvalId: approval.id,
      requestedBy: membershipId,
      idempotencyKey: "publish-retry-provider-approval-race",
    });
    getDeploymentStatus.mockResolvedValue("failed");
    await app.commands.refresh(publication.id);
    isReleaseLive.mockResolvedValue(false);
    vi.mocked(publisher.getProductionHead).mockResolvedValue("c".repeat(40));
    let providerDispatched = false;
    vi.mocked(publisher.retryDeployment).mockImplementation(
      async ({ assertDispatch }) => {
        await store.invalidateApproval({
          approvalId: approval.id,
          invalidatedAt: "2026-07-27T10:04:30.000Z",
          reason: "production_changed",
        });
        if (await assertDispatch()) {
          providerDispatched = true;
          return { state: "requested", deploymentId: "build-raced" };
        }
        return {
          state: "blocked",
          detail: "deployment_retry_claim_lost",
        };
      },
    );

    await expect(
      app.commands.retryDeployment(publication.id, membershipId),
    ).resolves.toEqual(
      expect.objectContaining({
        status: "failed",
        detail: "deployment_retry_claim_lost",
      }),
    );
    expect(providerDispatched).toBe(false);
  });

  it("revalidates the publication channel at the provider boundary", async () => {
    const { app, approval } = await approve();
    const publication = await app.commands.publish({
      workspaceId,
      approvalId: approval.id,
      requestedBy: membershipId,
      idempotencyKey: "publish-retry-provider-channel-race",
    });
    getDeploymentStatus.mockResolvedValue("failed");
    await app.commands.refresh(publication.id);
    isReleaseLive.mockResolvedValue(false);
    vi.mocked(publisher.getProductionHead).mockResolvedValue("c".repeat(40));
    let channelHash = "channel-a";
    vi.mocked(publisher.getChannelConfigurationHash).mockImplementation(
      async () => channelHash,
    );
    let providerDispatched = false;
    vi.mocked(publisher.retryDeployment).mockImplementation(
      async ({ assertDispatch }) => {
        channelHash = "channel-b";
        if (await assertDispatch()) {
          providerDispatched = true;
          return { state: "requested", deploymentId: "build-raced" };
        }
        return {
          state: "blocked",
          detail: "deployment_retry_claim_lost",
        };
      },
    );

    await expect(
      app.commands.retryDeployment(publication.id, membershipId),
    ).resolves.toEqual(
      expect.objectContaining({
        status: "failed",
        detail: "deployment_retry_claim_lost",
      }),
    );
    expect(providerDispatched).toBe(false);
  });

  it("does not dispatch when the exact marker appears but its live CAS races", async () => {
    const underlyingStore = createInMemoryContentPublicationStore();
    let rejectLiveCas = false;
    const store = {
      ...underlyingStore,
      async updatePublication(
        ...args: Parameters<typeof underlyingStore.updatePublication>
      ) {
        if (rejectLiveCas && args[0].status === "verified-live") {
          throw new Error("live_cas_raced");
        }
        return underlyingStore.updatePublication(...args);
      },
    };
    const app = createContentPublicationApplication({
      store,
      revisions: repository,
      publisher,
      now: () => clock.shift() ?? "2026-07-27T10:05:00.000Z",
    });
    const { approval } = await approve(app);
    const publication = await app.commands.publish({
      workspaceId,
      approvalId: approval.id,
      requestedBy: membershipId,
      idempotencyKey: "publish-retry-live-cas-race",
    });
    getDeploymentStatus.mockResolvedValue("failed");
    await app.commands.refresh(publication.id);
    vi.mocked(publisher.getProductionHead).mockResolvedValue("c".repeat(40));
    isReleaseLive.mockResolvedValue(false);
    let providerDispatched = false;
    vi.mocked(publisher.retryDeployment).mockImplementation(
      async ({ assertDispatch }) => {
        rejectLiveCas = true;
        isReleaseLive.mockResolvedValue(true);
        if (await assertDispatch()) {
          providerDispatched = true;
          return { state: "requested", deploymentId: "build-duplicate" };
        }
        return {
          state: "blocked",
          detail: "deployment_retry_claim_lost",
        };
      },
    );

    await expect(
      app.commands.retryDeployment(publication.id, membershipId),
    ).resolves.toEqual(
      expect.objectContaining({
        status: "failed",
        detail: "deployment_retry_claim_lost",
      }),
    );
    expect(providerDispatched).toBe(false);
  });

  it("dispatches only one exact build when deployment retries race", async () => {
    const { app, approval } = await approve();
    const publication = await app.commands.publish({
      workspaceId,
      approvalId: approval.id,
      requestedBy: membershipId,
      idempotencyKey: "publish-concurrent-deployment-retries",
    });
    getDeploymentStatus.mockResolvedValue("failed");
    await app.commands.refresh(publication.id);
    isReleaseLive.mockResolvedValue(false);
    let headReads = 0;
    let releaseHeadReads: (() => void) | undefined;
    const headReadBarrier = new Promise<void>((resolve) => {
      releaseHeadReads = resolve;
    });
    vi.mocked(publisher.getProductionHead).mockImplementation(async () => {
      headReads += 1;
      if (headReads === 2) {
        releaseHeadReads?.();
      }
      await headReadBarrier;
      return "c".repeat(40);
    });

    const results = await Promise.all([
      app.commands.retryDeployment(publication.id, membershipId),
      app.commands.retryDeployment(publication.id, membershipId),
    ]);

    expect(publisher.retryDeployment).toHaveBeenCalledTimes(1);
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "committed",
          commitSha: "c".repeat(40),
          detail: "deployment_retry_requested",
          deploymentId: "build-123",
        }),
        expect.objectContaining({
          status: "committed",
          commitSha: "c".repeat(40),
          detail: "deployment_retry_dispatching",
          deploymentId: expect.stringMatching(/^retry-dispatch:/u),
        }),
      ]),
    );
  });

  it("permits another manual retry after a definitive dispatch rejection", async () => {
    const { app, approval } = await approve();
    const publication = await app.commands.publish({
      workspaceId,
      approvalId: approval.id,
      requestedBy: membershipId,
      idempotencyKey: "publish-definitive-retry-rejection",
    });
    getDeploymentStatus.mockResolvedValue("failed");
    await app.commands.refresh(publication.id);
    isReleaseLive.mockResolvedValue(false);
    vi.mocked(publisher.getProductionHead).mockResolvedValue("c".repeat(40));
    vi.mocked(publisher.retryDeployment)
      .mockImplementationOnce(async ({ assertDispatch }) => {
        expect(await assertDispatch()).toBe(true);
        return { state: "failed" };
      })
      .mockImplementationOnce(async ({ assertDispatch }) =>
        (await assertDispatch())
          ? { state: "requested", deploymentId: "build-after-rejection" }
          : {
              state: "blocked",
              detail: "deployment_retry_claim_lost",
            },
      );

    await expect(
      app.commands.retryDeployment(publication.id, membershipId),
    ).resolves.toEqual(
      expect.objectContaining({
        status: "failed",
        detail: "deployment_retry_failed",
        deploymentId: null,
      }),
    );
    await expect(
      app.commands.retryDeployment(publication.id, membershipId),
    ).resolves.toEqual(
      expect.objectContaining({
        status: "committed",
        detail: "deployment_retry_requested",
        deploymentId: "build-after-rejection",
      }),
    );
    expect(publisher.retryDeployment).toHaveBeenCalledTimes(2);
  });

  it("reports a global deployment retry claim conflict without dispatching", async () => {
    const underlyingStore = createInMemoryContentPublicationStore();
    let conflictPublication:
      | Awaited<ReturnType<typeof underlyingStore.findPublication>>
      | undefined;
    let rejectClaim = false;
    const store = {
      ...underlyingStore,
      async updatePublication(...args: Parameters<typeof underlyingStore.updatePublication>) {
        if (
          rejectClaim &&
          args[0].detail === "deployment_retry_dispatching"
        ) {
          throw new Error("content_publications_one_active");
        }
        return underlyingStore.updatePublication(...args);
      },
      async findActivePublication() {
        if (rejectClaim && conflictPublication !== null) {
          return conflictPublication === undefined
            ? null
            : {
                ...conflictPublication,
                status: "committed" as const,
                detail: "deployment_retry_dispatching",
              };
        }
        return underlyingStore.findActivePublication();
      },
    };
    const app = createContentPublicationApplication({
      store,
      revisions: repository,
      publisher,
      now: () => clock.shift() ?? "2026-07-27T10:05:00.000Z",
    });
    const approval = await app.commands.approve({
      workspaceId,
      revision: 1,
      approvedBy: membershipId,
      previewConfirmed: true,
    });
    const publication = await app.commands.publish({
      workspaceId,
      approvalId: approval.id,
      requestedBy: membershipId,
      idempotencyKey: "publish-global-retry-claim-conflict",
    });
    getDeploymentStatus.mockResolvedValue("failed");
    await app.commands.refresh(publication.id);
    conflictPublication = await underlyingStore.findPublication(publication.id);
    rejectClaim = true;
    vi.mocked(publisher.getProductionHead).mockResolvedValue("c".repeat(40));
    isReleaseLive.mockResolvedValue(false);

    await expect(
      app.commands.retryDeployment(publication.id, membershipId),
    ).rejects.toEqual(
      new ContentPublicationValidationError(
        "deployment_retry_in_progress",
      ),
    );
    expect(publisher.retryDeployment).not.toHaveBeenCalled();
  });

  it("does not poll the failed build while an exact retry is dispatching", async () => {
    let resolveRetry:
      | ((value: { state: "requested"; deploymentId: string }) => void)
      | undefined;
    vi.mocked(publisher.retryDeployment).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRetry = resolve;
        }),
    );
    const { app, approval } = await approve();
    const publication = await app.commands.publish({
      workspaceId,
      approvalId: approval.id,
      requestedBy: membershipId,
      idempotencyKey: "publish-retry-dispatch-fence",
    });
    getDeploymentStatus.mockResolvedValue("failed");
    await app.commands.refresh(publication.id);
    vi.mocked(publisher.getProductionHead).mockResolvedValue("c".repeat(40));
    isReleaseLive.mockResolvedValue(false);
    const retry = app.commands.retryDeployment(publication.id, membershipId);
    await vi.waitFor(() => {
      expect(publisher.retryDeployment).toHaveBeenCalled();
    });
    getDeploymentStatus.mockClear();

    await expect(app.commands.refresh(publication.id)).resolves.toEqual(
      expect.objectContaining({
        status: "committed",
        detail: "deployment_retry_dispatching",
      }),
    );
    expect(getDeploymentStatus).not.toHaveBeenCalled();
    resolveRetry?.({ state: "requested", deploymentId: "build-456" });
    await retry;
  });

  it("bounds recovery when a Worker abandons deployment retry dispatch", async () => {
    let currentTime = "2026-07-27T10:01:00.000Z";
    let resolveRetry:
      | ((value: { state: "requested"; deploymentId: string }) => void)
      | undefined;
    vi.mocked(publisher.retryDeployment).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRetry = resolve;
        }),
    );
    const app = createContentPublicationApplication({
      store: createInMemoryContentPublicationStore(),
      revisions: repository,
      publisher,
      now: () => currentTime,
    });
    const approval = await app.commands.approve({
      workspaceId,
      revision: 1,
      approvedBy: membershipId,
      previewConfirmed: true,
    });
    const publication = await app.commands.publish({
      workspaceId,
      approvalId: approval.id,
      requestedBy: membershipId,
      idempotencyKey: "publish-abandoned-retry-dispatch",
    });
    currentTime = "2026-07-27T10:02:00.000Z";
    getDeploymentStatus.mockResolvedValue("failed");
    await app.commands.refresh(publication.id);
    vi.mocked(publisher.getProductionHead).mockResolvedValue("c".repeat(40));
    isReleaseLive.mockResolvedValue(false);
    currentTime = "2026-07-27T10:03:00.000Z";
    const retry = app.commands.retryDeployment(publication.id, membershipId);
    await vi.waitFor(() => {
      expect(publisher.retryDeployment).toHaveBeenCalled();
    });

    currentTime = "2026-07-27T10:04:01.000Z";
    await expect(app.commands.refresh(publication.id)).resolves.toEqual(
      expect.objectContaining({
        status: "unknown",
        detail: "deployment_retry_result_unknown",
      }),
    );
    currentTime = "2026-07-27T10:18:01.000Z";
    await expect(app.commands.refresh(publication.id)).resolves.toEqual(
      expect.objectContaining({
        status: "failed",
        detail: "deployment_retry_timeout",
      }),
    );
    resolveRetry?.({ state: "requested", deploymentId: "late-build" });
    await expect(retry).resolves.toEqual(
      expect.objectContaining({
        status: "failed",
        detail: "deployment_retry_timeout",
      }),
    );
    getDeploymentStatus.mockResolvedValue("requested");
    await expect(
      app.commands.retryDeployment(publication.id, membershipId),
    ).resolves.toEqual(
      expect.objectContaining({
        status: "failed",
        detail: "deployment_retry_timeout",
      }),
    );
    getDeploymentStatus.mockResolvedValue("building");
    await expect(
      app.commands.retryDeployment(publication.id, membershipId),
    ).resolves.toEqual(
      expect.objectContaining({
        status: "building",
        detail: "deployment_retry_reconciled",
      }),
    );
    await expect(app.commands.refresh(publication.id)).resolves.toEqual(
      expect.objectContaining({
        status: "failed",
        detail: "deployment_retry_timeout",
      }),
    );
    getDeploymentStatus.mockResolvedValue("requested");
    await expect(
      app.commands.retryDeployment(publication.id, membershipId),
    ).resolves.toEqual(
      expect.objectContaining({
        status: "failed",
        detail: "deployment_retry_timeout",
      }),
    );
    expect(publisher.retryDeployment).toHaveBeenCalledTimes(1);
  });

  it("preserves an ambiguous manual-dispatch fence through channel unavailability", async () => {
    let currentTime = "2026-07-27T10:01:00.000Z";
    const app = createContentPublicationApplication({
      store: createInMemoryContentPublicationStore(),
      revisions: repository,
      publisher,
      now: () => currentTime,
    });
    const approval = await app.commands.approve({
      workspaceId,
      revision: 1,
      approvedBy: membershipId,
      previewConfirmed: true,
    });
    const publication = await app.commands.publish({
      workspaceId,
      approvalId: approval.id,
      requestedBy: membershipId,
      idempotencyKey: "publish-channel-ambiguous-build",
    });
    getDeploymentStatus.mockResolvedValue("failed");
    await app.commands.refresh(publication.id);
    vi.mocked(publisher.getProductionHead).mockResolvedValue("c".repeat(40));
    isReleaseLive.mockResolvedValue(false);
    vi.mocked(publisher.retryDeployment).mockResolvedValue({
      state: "unknown",
    });
    await app.commands.retryDeployment(publication.id, membershipId);

    vi.mocked(publisher.getChannelConfigurationHash).mockRejectedValue(
      new Error("channel temporarily unavailable"),
    );
    currentTime = "2026-07-27T10:18:00.000Z";
    await expect(app.commands.refresh(publication.id)).resolves.toEqual(
      expect.objectContaining({
        status: "failed",
        detail: "deployment_retry_timeout",
      }),
    );
    vi.mocked(publisher.getChannelConfigurationHash).mockResolvedValue(
      "channel-a",
    );
    getDeploymentStatus.mockResolvedValue("requested");
    await app.commands.retryDeployment(publication.id, membershipId);

    expect(publisher.retryDeployment).toHaveBeenCalledTimes(1);
  });

  it("rejects deployment retry after the bound channel changes", async () => {
    const { app, approval } = await approve();
    const publication = await app.commands.publish({
      workspaceId,
      approvalId: approval.id,
      requestedBy: membershipId,
      idempotencyKey: "publish-retry-channel-change",
    });
    getDeploymentStatus.mockResolvedValue("failed");
    await app.commands.refresh(publication.id);
    vi.mocked(publisher.getChannelConfigurationHash).mockResolvedValue(
      "channel-b",
    );

    await expect(
      app.commands.retryDeployment(publication.id, membershipId),
    ).rejects.toEqual(new ContentApprovalInvalidError("approval_stale"));
    expect(publisher.retryDeployment).not.toHaveBeenCalled();
  });

  it("rechecks the channel after claiming a deployment retry", async () => {
    const { app, approval } = await approve();
    const publication = await app.commands.publish({
      workspaceId,
      approvalId: approval.id,
      requestedBy: membershipId,
      idempotencyKey: "publish-retry-channel-race",
    });
    getDeploymentStatus.mockResolvedValue("failed");
    await app.commands.refresh(publication.id);
    isReleaseLive.mockResolvedValue(false);
    let channelHash = "channel-a";
    vi.mocked(publisher.getChannelConfigurationHash).mockImplementation(
      async () => channelHash,
    );
    let productionHeadReads = 0;
    vi.mocked(publisher.getProductionHead).mockImplementation(async () => {
      productionHeadReads += 1;
      if (productionHeadReads === 1) {
        channelHash = "channel-b";
      }
      return "c".repeat(40);
    });

    await expect(
      app.commands.retryDeployment(publication.id, membershipId),
    ).resolves.toEqual(
      expect.objectContaining({
        status: "failed",
        detail: "approval_stale",
      }),
    );
    expect(publisher.retryDeployment).not.toHaveBeenCalled();
  });

  it("invalidates deployment retry authority after a newer draft revision", async () => {
    const { app, approval } = await approve();
    const publication = await app.commands.publish({
      workspaceId,
      approvalId: approval.id,
      requestedBy: membershipId,
      idempotencyKey: "publish-retry-superseded-revision",
    });
    getDeploymentStatus.mockResolvedValue("failed");
    await app.commands.refresh(publication.id);
    vi.mocked(publisher.getProductionHead).mockResolvedValue("c".repeat(40));
    await revisionApplication.application.commands.save({
      actorId: editorId,
      workspaceId,
      schemaVersion: referenceSiteDefinition.schemaVersion,
      baseRevision: 1,
      edits: [{ path: "section_hero.title", value: "Newer headline" }],
      idempotencyKey: "save-publish-workspace-0002",
    });
    isReleaseLive.mockResolvedValue(false);

    await expect(
      app.commands.retryDeployment(publication.id, membershipId),
    ).rejects.toEqual(new ContentApprovalInvalidError("revision_not_current"));
    expect(publisher.retryDeployment).not.toHaveBeenCalled();
  });

  it("reconciles an ambiguous deployment retry from the exact live marker", async () => {
    const { app, approval } = await approve();
    const publication = await app.commands.publish({
      workspaceId,
      approvalId: approval.id,
      requestedBy: membershipId,
      idempotencyKey: "publish-retry-ambiguous-live",
    });
    getDeploymentStatus.mockResolvedValue("failed");
    await app.commands.refresh(publication.id);
    vi.mocked(publisher.getProductionHead).mockResolvedValue("c".repeat(40));
    vi.mocked(publisher.retryDeployment).mockResolvedValue({
      state: "unknown",
    });
    isReleaseLive.mockResolvedValue(false);

    await expect(
      app.commands.retryDeployment(publication.id, membershipId),
    ).resolves.toEqual(
      expect.objectContaining({
        status: "unknown",
        detail: "deployment_retry_result_unknown",
      }),
    );
    await expect(
      app.commands.retryDeployment(publication.id, membershipId),
    ).resolves.toEqual(
      expect.objectContaining({
        status: "unknown",
        detail: "deployment_retry_result_unknown",
      }),
    );
    expect(publisher.retryDeployment).toHaveBeenCalledTimes(1);
    isReleaseLive.mockResolvedValue(true);

    await expect(app.commands.refresh(publication.id)).resolves.toEqual(
      expect.objectContaining({
        status: "verified-live",
        detail: null,
      }),
    );
    expect(isReleaseLive).toHaveBeenLastCalledWith({
      commitSha: "c".repeat(40),
      contentHash: approval.fingerprint.contentHash,
      schemaVersion: approval.fingerprint.schemaVersion,
    });
  });

  it("reconciles a late exact release before dispatching another build", async () => {
    const { app, approval } = await approve();
    const publication = await app.commands.publish({
      workspaceId,
      approvalId: approval.id,
      requestedBy: membershipId,
      idempotencyKey: "publish-retry-already-live",
    });
    getDeploymentStatus.mockResolvedValue("failed");
    await app.commands.refresh(publication.id);
    vi.mocked(publisher.getProductionHead).mockResolvedValue("c".repeat(40));
    isReleaseLive.mockResolvedValue(true);

    await expect(
      app.commands.retryDeployment(publication.id, membershipId),
    ).resolves.toEqual(
      expect.objectContaining({
        status: "verified-live",
        detail: null,
        commitSha: "c".repeat(40),
      }),
    );
    expect(publisher.retryDeployment).not.toHaveBeenCalled();
  });

  it("does not poll or verify through a changed publication channel", async () => {
    const { app, approval } = await approve();
    const publication = await app.commands.publish({
      workspaceId,
      approvalId: approval.id,
      requestedBy: membershipId,
      idempotencyKey: "publish-refresh-channel-change",
    });
    vi.mocked(publisher.getChannelConfigurationHash).mockResolvedValue(
      "channel-b",
    );
    getDeploymentStatus.mockResolvedValue("deployed");
    getDeploymentStatus.mockClear();
    isReleaseLive.mockClear();

    await expect(app.commands.refresh(publication.id)).resolves.toEqual(
      publication,
    );
    expect(getDeploymentStatus).not.toHaveBeenCalled();
    expect(isReleaseLive).not.toHaveBeenCalled();
  });

  it("keeps a deployed publication in marker verification after a later failed signal", async () => {
    const { app, approval } = await approve();
    const publication = await app.commands.publish({
      workspaceId,
      approvalId: approval.id,
      requestedBy: membershipId,
      idempotencyKey: "publish-deployed-later-failed-signal",
    });
    getDeploymentStatus.mockResolvedValueOnce("deployed");
    isReleaseLive.mockResolvedValueOnce(false);
    await expect(app.commands.refresh(publication.id)).resolves.toEqual(
      expect.objectContaining({
        status: "deployed",
        detail: "release_marker_pending",
      }),
    );
    getDeploymentStatus.mockResolvedValueOnce("failed");
    isReleaseLive.mockResolvedValueOnce(true);

    await expect(app.commands.refresh(publication.id)).resolves.toEqual(
      expect.objectContaining({
        status: "verified-live",
        detail: null,
      }),
    );
    expect(isReleaseLive).toHaveBeenLastCalledWith({
      commitSha: "c".repeat(40),
      contentHash: approval.fingerprint.contentHash,
      schemaVersion: approval.fingerprint.schemaVersion,
    });
  });

  it("times out a deployment whose exact release marker never appears", async () => {
    let currentTime = "2026-07-27T10:01:00.000Z";
    const app = createContentPublicationApplication({
      store: createInMemoryContentPublicationStore(),
      revisions: repository,
      publisher,
      now: () => currentTime,
    });
    const approval = await app.commands.approve({
      workspaceId,
      revision: 1,
      approvedBy: membershipId,
      previewConfirmed: true,
    });
    const publication = await app.commands.publish({
      workspaceId,
      approvalId: approval.id,
      requestedBy: membershipId,
      idempotencyKey: "publish-marker-timeout-1",
    });
    getDeploymentStatus.mockResolvedValue("deployed");
    isReleaseLive.mockResolvedValue(false);
    currentTime = "2026-07-27T10:02:00.000Z";
    await expect(app.commands.refresh(publication.id)).resolves.toEqual(
      expect.objectContaining({ status: "deployed" }),
    );

    getDeploymentStatus.mockResolvedValue("unknown");
    currentTime = "2026-07-27T10:16:00.000Z";
    await expect(app.commands.refresh(publication.id)).resolves.toEqual(
      expect.objectContaining({
        status: "failed",
        commitSha: "c".repeat(40),
        detail: "release_marker_timeout",
      }),
    );
  });

  it("retries an unavailable release marker before timing it out", async () => {
    let currentTime = "2026-07-27T10:01:00.000Z";
    const app = createContentPublicationApplication({
      store: createInMemoryContentPublicationStore(),
      revisions: repository,
      publisher,
      now: () => currentTime,
    });
    const approval = await app.commands.approve({
      workspaceId,
      revision: 1,
      approvedBy: membershipId,
      previewConfirmed: true,
    });
    const publication = await app.commands.publish({
      workspaceId,
      approvalId: approval.id,
      requestedBy: membershipId,
      idempotencyKey: "publish-marker-unavailable",
    });
    getDeploymentStatus.mockResolvedValue("deployed");
    isReleaseLive.mockRejectedValue(new Error("release_marker_unavailable"));

    currentTime = "2026-07-27T10:02:00.000Z";
    await expect(app.commands.refresh(publication.id)).resolves.toEqual(
      expect.objectContaining({
        status: "deployed",
        detail: "release_marker_unavailable",
      }),
    );

    currentTime = "2026-07-27T10:16:00.000Z";
    await expect(app.commands.refresh(publication.id)).resolves.toEqual(
      expect.objectContaining({
        status: "failed",
        commitSha: "c".repeat(40),
        detail: "release_marker_timeout",
      }),
    );
  });

  it("reconciles an expired global claim before accepting a later publish", async () => {
    let currentTime = "2026-07-27T10:10:00.000Z";
    const store = createInMemoryContentPublicationStore();
    const app = createContentPublicationApplication({
      store,
      revisions: repository,
      publisher,
      now: () => currentTime,
    });
    const approval = await app.commands.approve({
      workspaceId,
      revision: 1,
      approvedBy: membershipId,
      previewConfirmed: true,
    });
    const stranded = {
      id: createContentPublicationId(`publish_${"7".repeat(32)}`),
      workspaceId,
      revision: 1,
      approvalId: approval.id,
      fingerprint: approval.fingerprint.value,
      idempotencyKey: "stranded-before-next-0001",
      requestedBy: membershipId,
      contributors: [editorId],
      expectedHead: productionCommit,
      status: "requested" as const,
      commitSha: null,
      deploymentId: null,
      deploymentRequestedAt: null,
      detail: null,
      leaseToken: "expired-lease",
      leaseExpiresAt: "2026-07-27T10:05:00.000Z",
      requestedAt: "2026-07-27T10:03:00.000Z",
      updatedAt: "2026-07-27T10:03:00.000Z",
    };
    await store.claimPublication(stranded);
    vi.mocked(publisher.reconcileCommit).mockResolvedValue({
      state: "not-found",
    });

    currentTime = "2026-07-27T10:19:00.000Z";
    const recovered = await app.commands.publish({
      workspaceId,
      approvalId: approval.id,
      requestedBy: membershipId,
      idempotencyKey: "publish-after-stranded-1",
    });
    expect(recovered).toEqual(
      expect.objectContaining({
        id: stranded.id,
        status: "failed",
        detail: "publication_lease_expired",
      }),
    );
    await expect(
      app.commands.retryDeployment(stranded.id, membershipId),
    ).resolves.toEqual(expect.objectContaining({ id: stranded.id }));
    await expect(
      app.commands.publish({
        workspaceId,
        approvalId: approval.id,
        requestedBy: membershipId,
        idempotencyKey: "another-key-after-stranded",
      }),
    ).resolves.toEqual(expect.objectContaining({ id: stranded.id }));
    expect(createCommit).toHaveBeenCalledTimes(1);
  });

  it("does not mistake a legacy Git-repair timestamp for manual build dispatch", async () => {
    const store = createInMemoryContentPublicationStore();
    const app = createContentPublicationApplication({
      store,
      revisions: repository,
      publisher,
      now: () => clock.shift() ?? "2026-07-27T10:05:00.000Z",
    });
    const approval = await app.commands.approve({
      workspaceId,
      revision: 1,
      approvedBy: membershipId,
      previewConfirmed: true,
    });
    const publication = await app.commands.publish({
      workspaceId,
      approvalId: approval.id,
      requestedBy: membershipId,
      idempotencyKey: "publish-legacy-repair-row",
    });
    getDeploymentStatus.mockResolvedValue("failed");
    const failed = await app.commands.refresh(publication.id);
    expect(failed).not.toBeNull();
    if (failed === null) {
      throw new Error("publication_missing");
    }
    await store.updatePublication({
      ...failed,
      deploymentRequestedAt: "2026-07-27T10:03:00.000Z",
      detail: "git_commit_reconciled",
      updatedAt: "2026-07-27T10:03:00.000Z",
    });
    vi.mocked(publisher.getProductionHead).mockResolvedValue("c".repeat(40));
    isReleaseLive.mockResolvedValue(false);

    await expect(
      app.commands.retryDeployment(publication.id, membershipId),
    ).resolves.toEqual(
      expect.objectContaining({
        detail: "deployment_retry_requested",
        deploymentId: "build-123",
      }),
    );
    expect(publisher.retryDeployment).toHaveBeenCalledTimes(1);
  });

  it("reconciles a manual build retry by its recorded deployment id", async () => {
    let currentTime = "2026-07-27T10:01:00.000Z";
    const app = createContentPublicationApplication({
      store: createInMemoryContentPublicationStore(),
      revisions: repository,
      publisher,
      now: () => currentTime,
    });
    const approval = await app.commands.approve({
      workspaceId,
      revision: 1,
      approvedBy: membershipId,
      previewConfirmed: true,
    });
    const publication = await app.commands.publish({
      workspaceId,
      approvalId: approval.id,
      requestedBy: membershipId,
      idempotencyKey: "publish-manual-build-id",
    });
    getDeploymentStatus.mockResolvedValue("failed");
    await app.commands.refresh(publication.id);
    vi.mocked(publisher.getProductionHead).mockResolvedValue("c".repeat(40));
    isReleaseLive.mockResolvedValue(false);
    await app.commands.retryDeployment(publication.id, membershipId);

    currentTime = "2026-07-27T10:18:00.000Z";
    getDeploymentStatus.mockResolvedValue("requested");
    await expect(app.commands.refresh(publication.id)).resolves.toEqual(
      expect.objectContaining({
        status: "failed",
        detail: "deployment_retry_timeout",
        deploymentId: "build-123",
      }),
    );

    getDeploymentStatus.mockClear();
    getDeploymentStatus.mockResolvedValue("building");
    await expect(
      app.commands.retryDeployment(publication.id, membershipId),
    ).resolves.toEqual(
      expect.objectContaining({
        status: "building",
        detail: "deployment_retry_reconciled",
      }),
    );
    expect(getDeploymentStatus).toHaveBeenCalledWith(
      "c".repeat(40),
      "build-123",
    );
    expect(publisher.retryDeployment).toHaveBeenCalledTimes(1);
  });

  it("dispatches a new manual build after the recorded build definitively fails", async () => {
    let currentTime = "2026-07-27T10:01:00.000Z";
    const app = createContentPublicationApplication({
      store: createInMemoryContentPublicationStore(),
      revisions: repository,
      publisher,
      now: () => currentTime,
    });
    const approval = await app.commands.approve({
      workspaceId,
      revision: 1,
      approvedBy: membershipId,
      previewConfirmed: true,
    });
    const publication = await app.commands.publish({
      workspaceId,
      approvalId: approval.id,
      requestedBy: membershipId,
      idempotencyKey: "publish-recorded-build-failed",
    });
    getDeploymentStatus.mockResolvedValue("failed");
    await app.commands.refresh(publication.id);
    vi.mocked(publisher.getProductionHead).mockResolvedValue("c".repeat(40));
    isReleaseLive.mockResolvedValue(false);
    await expect(
      app.commands.retryDeployment(publication.id, membershipId),
    ).resolves.toEqual(
      expect.objectContaining({
        detail: "deployment_retry_requested",
        deploymentId: "build-123",
      }),
    );
    currentTime = "2026-07-27T10:06:00.000Z";
    await expect(app.commands.refresh(publication.id)).resolves.toEqual(
      expect.objectContaining({
        status: "failed",
        deploymentId: "build-123",
      }),
    );
    vi.mocked(publisher.retryDeployment).mockImplementationOnce(
      async ({ assertDispatch }) =>
        (await assertDispatch())
          ? {
              state: "requested",
              deploymentId: "build-after-failure",
            }
          : {
              state: "blocked",
              detail: "deployment_retry_claim_lost",
            },
    );
    getDeploymentStatus.mockClear();

    await expect(
      app.commands.retryDeployment(publication.id, membershipId),
    ).resolves.toEqual(
      expect.objectContaining({
        status: "committed",
        detail: "deployment_retry_requested",
        deploymentId: "build-after-failure",
      }),
    );
    expect(getDeploymentStatus).toHaveBeenCalledWith(
      "c".repeat(40),
      "build-123",
    );
    expect(publisher.retryDeployment).toHaveBeenCalledTimes(2);
  });

  it("reconciles a landed commit before rejecting a new stale-base approval", async () => {
    let currentTime = "2026-07-27T10:10:00.000Z";
    const store = createInMemoryContentPublicationStore();
    const app = createContentPublicationApplication({
      store,
      revisions: repository,
      publisher,
      now: () => currentTime,
    });
    const approval = await app.commands.approve({
      workspaceId,
      revision: 1,
      approvedBy: membershipId,
      previewConfirmed: true,
    });
    const stranded = {
      id: createContentPublicationId(`publish_${"6".repeat(32)}`),
      workspaceId,
      revision: 1,
      approvalId: approval.id,
      fingerprint: approval.fingerprint.value,
      idempotencyKey: "stranded-after-ref-update",
      requestedBy: membershipId,
      contributors: [editorId],
      expectedHead: productionCommit,
      status: "requested" as const,
      commitSha: null,
      deploymentId: null,
      deploymentRequestedAt: null,
      detail: null,
      leaseToken: "expired-lease",
      leaseExpiresAt: "2026-07-27T10:05:00.000Z",
      requestedAt: "2026-07-27T10:03:00.000Z",
      updatedAt: "2026-07-27T10:03:00.000Z",
    };
    await store.claimPublication(stranded);
    vi.mocked(publisher.reconcileCommit).mockResolvedValue({
      state: "committed",
      commitSha: "c".repeat(40),
    });
    getDeploymentStatus.mockResolvedValue("deployed");
    vi.mocked(publisher.getProductionHead).mockResolvedValue("c".repeat(40));
    isReleaseLive.mockImplementation(
      async ({ commitSha }) => commitSha === "c".repeat(40),
    );

    currentTime = "2026-07-27T10:11:00.000Z";
    await expect(
      app.commands.publish({
        workspaceId,
        approvalId: approval.id,
        requestedBy: membershipId,
        idempotencyKey: "publish-after-landed-ref-1",
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        id: stranded.id,
        status: "verified-live",
        commitSha: "c".repeat(40),
      }),
    );
    await expect(store.findPublication(stranded.id)).resolves.toEqual(
      expect.objectContaining({
        status: "verified-live",
        commitSha: "c".repeat(40),
      }),
    );
  });

  it("reconciles an expired requested lease so a crashed Worker cannot strand publication", async () => {
    const store = createInMemoryContentPublicationStore();
    const app = createContentPublicationApplication({
      store,
      revisions: repository,
      publisher,
      now: () => "2026-07-27T10:19:00.000Z",
    });
    const approval = await app.commands.approve({
      workspaceId,
      revision: 1,
      approvedBy: membershipId,
      previewConfirmed: true,
    });
    const stranded = {
      id: createContentPublicationId(`publish_${"9".repeat(32)}`),
      workspaceId,
      revision: 1,
      approvalId: approval.id,
      fingerprint: approval.fingerprint.value,
      idempotencyKey: "stranded-publication-0001",
      requestedBy: membershipId,
      contributors: [editorId],
      expectedHead: productionCommit,
      status: "requested" as const,
      commitSha: null,
      deploymentId: null,
      deploymentRequestedAt: null,
      detail: null,
      leaseToken: "expired-lease",
      leaseExpiresAt: "2026-07-27T10:05:00.000Z",
      requestedAt: "2026-07-27T10:03:00.000Z",
      updatedAt: "2026-07-27T10:03:00.000Z",
    };
    await store.claimPublication(stranded);
    vi.mocked(publisher.reconcileCommit).mockResolvedValue({
      state: "not-found",
    });

    await expect(app.commands.refresh(stranded.id)).resolves.toEqual(
      expect.objectContaining({
        status: "failed",
        detail: "publication_lease_expired",
        leaseToken: null,
      }),
    );
  });

  it("clears an expired lease as soon as reconciliation finds the exact commit", async () => {
    const store = createInMemoryContentPublicationStore();
    const app = createContentPublicationApplication({
      store,
      revisions: repository,
      publisher,
      now: () => "2026-07-27T10:10:00.000Z",
    });
    const approval = await app.commands.approve({
      workspaceId,
      revision: 1,
      approvedBy: membershipId,
      previewConfirmed: true,
    });
    const stranded = {
      id: createContentPublicationId(`publish_${"8".repeat(32)}`),
      workspaceId,
      revision: 1,
      approvalId: approval.id,
      fingerprint: approval.fingerprint.value,
      idempotencyKey: "stranded-commit-found-1",
      requestedBy: membershipId,
      contributors: [editorId],
      expectedHead: productionCommit,
      status: "requested" as const,
      commitSha: null,
      deploymentId: null,
      deploymentRequestedAt: null,
      detail: null,
      leaseToken: "expired-lease",
      leaseExpiresAt: "2026-07-27T10:05:00.000Z",
      requestedAt: "2026-07-27T10:03:00.000Z",
      updatedAt: "2026-07-27T10:03:00.000Z",
    };
    await store.claimPublication(stranded);
    vi.mocked(publisher.reconcileCommit).mockResolvedValue({
      state: "committed",
      commitSha: "e".repeat(40),
    });
    getDeploymentStatus.mockResolvedValue("requested");

    await expect(app.commands.refresh(stranded.id)).resolves.toEqual(
      expect.objectContaining({
        status: "committed",
        commitSha: "e".repeat(40),
        leaseToken: null,
        leaseExpiresAt: null,
      }),
    );
  });

  it("parses only an exact Git and published-content production base", () => {
    expect(parseProductionBase(productionBase)).toEqual({
      commitSha: productionCommit,
      contentHash: liveContentHash,
    });
    expect(() => parseProductionBase("git:main")).toThrow(
      ContentPublicationValidationError,
    );
  });
});
