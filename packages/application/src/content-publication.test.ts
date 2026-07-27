import { beforeEach, describe, expect, it, vi } from "vitest";

import { referenceSiteDefinition } from "@foundry/site-definition";

import {
  createContentActorId,
  createContentRevisionApplication,
  createContentWorkspaceId,
  createInMemoryContentRevisionStore,
} from "./content-revisions";
import { createHumanMembershipId } from "./human-access";
import {
  ContentApprovalInvalidError,
  ContentPublicationValidationError,
  createContentPublicationApplication,
  createContentPublicationId,
  createInMemoryContentPublicationStore,
  parseProductionBase,
  serializePublishedSiteDefinition,
  type ContentPublicationRevisionRepository,
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
    schemaVersion: "1.0.0",
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
      getProductionHead: vi.fn().mockResolvedValue(productionCommit),
      isReleaseLive,
      createCommit,
      reconcileCommit: vi.fn().mockResolvedValue({ state: "not-found" }),
      getDeploymentStatus,
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

  function application() {
    return createContentPublicationApplication({
      store: createInMemoryContentPublicationStore(),
      revisions: repository,
      publisher,
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
          contentHash: revisionApplication.saved.inputs.contentHash,
          designHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
          schemaVersion: "1.0.0",
          rendererVersion: "renderer-v1",
          productionBase,
          artifactHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
          serializationVersion:
            "foundry.site-definition.canonical-json.v1",
        },
      }),
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

  it("invalidates approval when a later render-affecting revision exists", async () => {
    const { app, approval } = await approve();
    await revisionApplication.application.commands.save({
      actorId: editorId,
      workspaceId,
      schemaVersion: "1.0.0",
      baseRevision: 1,
      edits: [{ path: "section_hero.summary", value: "Changed after approval" }],
      idempotencyKey: "save-after-approval-0001",
    });

    await expect(
      app.commands.publish({
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
        approvalId: approval.id,
        requestedBy: membershipId,
        idempotencyKey: "publish-stale-head-0001",
      }),
    ).rejects.toEqual(
      new ContentApprovalInvalidError("production_head_moved"),
    );
    expect(createCommit).not.toHaveBeenCalled();

    vi.mocked(publisher.getProductionHead).mockResolvedValue(productionCommit);
    isReleaseLive.mockResolvedValue(false);
    await expect(
      app.commands.publish({
        approvalId: approval.id,
        requestedBy: membershipId,
        idempotencyKey: "publish-stale-marker-001",
      }),
    ).rejects.toEqual(
      new ContentApprovalInvalidError("release_marker_mismatch"),
    );
    expect(createCommit).not.toHaveBeenCalled();
  });

  it("serializes one deterministic file and creates one attributed compare-and-swap commit", async () => {
    const { app, approval } = await approve();
    const publication = await app.commands.publish({
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
        path: "packages/site-definition/src/published-site.json",
        bytes: serializePublishedSiteDefinition(
          revisionApplication.saved.definition,
        ),
        message: expect.stringContaining(
          `Foundry-Approved-By: ${membershipId}`,
        ),
      }),
    );
    expect(createCommit.mock.calls[0]![0].message).toContain(
      `Foundry-Content-Hash: ${revisionApplication.saved.inputs.contentHash}`,
    );

    const replay = await app.commands.publish({
      approvalId: approval.id,
      requestedBy: membershipId,
      idempotencyKey: "publish-exact-revision-1",
    });
    expect(replay).toEqual(publication);
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

  it("replays the recorded operation even after its own commit advanced production", async () => {
    const { app, approval } = await approve();
    const publication = await app.commands.publish({
      approvalId: approval.id,
      requestedBy: membershipId,
      idempotencyKey: "publish-after-own-commit-1",
    });
    vi.mocked(publisher.getProductionHead).mockResolvedValue("c".repeat(40));
    isReleaseLive.mockResolvedValue(false);

    await expect(
      app.commands.publish({
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

  it.each([
    ["requested", "committed"],
    ["building", "building"],
    ["failed", "failed"],
    ["unknown", "committed"],
  ] as const)("reports deployment state %s explicitly", async (external, expected) => {
    const { app, approval } = await approve();
    const publication = await app.commands.publish({
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
      schemaVersion: "1.0.0",
    });
  });

  it("reconciles an expired requested lease so a crashed Worker cannot strand publication", async () => {
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
