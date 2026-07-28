import { describe, expect, it } from "vitest";

import { createSiteId } from "@foundry/site-definition";

import {
  MediaAssetReferencedError,
  MediaMutationInProgressError,
  MediaSiteAccessError,
  MediaValidationError,
  createContentActorId,
  createContentWorkspaceId,
  createInMemoryMediaAssetStore,
  createInMemoryMediaContentCoordinator,
  createInMemoryMediaSourceStore,
  createMediaAssetApplication,
  createMediaAssetId,
  createMediaOccurrenceId,
} from "./index";

const siteA = createSiteId("site_alpha");
const siteB = createSiteId("site_beta");
const editor = createContentActorId("membership-editor");
const workspaceA = createContentWorkspaceId("workspace_alpha");
const workspaceB = createContentWorkspaceId("workspace_beta");
const assetA = createMediaAssetId("asset_hero");
const assetB = createMediaAssetId("asset_detail");
const assetC = createMediaAssetId("asset_unused");
const occurrenceA = createMediaOccurrenceId("occurrence_home_hero");
const occurrenceB = createMediaOccurrenceId("occurrence_home_detail");

function source(label: string) {
  return new TextEncoder().encode(label);
}

function setup(siteId = siteA) {
  const assets = createInMemoryMediaAssetStore();
  const sources = createInMemoryMediaSourceStore();
  return {
    assets,
    sources,
    application: createMediaAssetApplication({
      siteId,
      actorId: editor,
      assets,
      sources,
      now: () => "2026-07-27T12:00:00.000Z",
    }),
  };
}

async function upload(
  application: ReturnType<typeof createMediaAssetApplication>,
  assetId = assetA,
) {
  return application.commands.upload({
    actorId: editor,
    assetId,
    fileName: `${assetId}.png`,
    contentType: "image/png",
    byteLength: source(assetId).byteLength,
    width: 1600,
    height: 900,
    source: source(assetId),
    idempotencyKey: `upload-${assetId}`,
  });
}

describe("media asset application", () => {
  it("stores an uploaded source under a private site-owned identity and records metadata", async () => {
    const { application, sources } = setup();

    const uploaded = await upload(application);

    expect(uploaded).toEqual({
      siteId: siteA,
      assetId: assetA,
      objectKey: `media/${siteA}/${assetA}/source`,
      sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      fileName: `${assetA}.png`,
      contentType: "image/png",
      byteLength: source(assetA).byteLength,
      width: 1600,
      height: 900,
      createdAt: "2026-07-27T12:00:00.000Z",
      createdBy: editor,
    });
    await expect(sources.readForTest(uploaded.objectKey)).resolves.toEqual(
      source(assetA),
    );
    expect("publicUrl" in uploaded).toBe(false);
    await expect(application.queries.audit()).resolves.toEqual([
      expect.objectContaining({
        action: "media.asset.uploaded",
        actorId: editor,
        subjectId: assetA,
      }),
    ]);
  });

  it("models the production identity predicate for raced asset creates", async () => {
    const { assets } = setup();
    const firstClaim = {
      siteId: siteA,
      idempotencyKey: "raced-asset-create-first",
      requestHash: "first-request",
      claimToken: "first-claim",
    };
    const secondClaim = {
      siteId: siteA,
      idempotencyKey: "raced-asset-create-second",
      requestHash: "second-request",
      claimToken: "second-claim",
    };
    const asset = {
      siteId: siteA,
      assetId: assetA,
      objectKey: `media/${siteA}/${assetA}/source`,
      sourceHash: "a".repeat(64),
      fileName: "hero.png",
      contentType: "image/png" as const,
      byteLength: 128,
      width: 1600,
      height: 900,
      createdAt: "2026-07-27T12:00:00.000Z",
      createdBy: editor,
    };
    await expect(assets.claim(firstClaim)).resolves.toBe(true);
    await assets.createAsset(asset, firstClaim);
    await expect(assets.claim(secondClaim)).resolves.toBe(true);

    await expect(
      assets.createAsset(
        { ...asset, fileName: "other.png", width: 800, height: 450 },
        secondClaim,
      ),
    ).rejects.toBeInstanceOf(MediaValidationError);
  });

  it("keeps authenticated GET-style reads side-effect free", async () => {
    const { application } = setup();
    await upload(application);

    await application.queries.listAssets();
    await application.queries.listOccurrences(workspaceA);
    await application.queries.getSource(assetA);

    await expect(application.queries.audit()).resolves.toEqual([
      expect.objectContaining({ action: "media.asset.uploaded" }),
    ]);
  });

  it("audits private media capabilities on an explicit access grant", async () => {
    const { application } = setup();
    await upload(application);

    await expect(
      application.commands.grantAccess({
        actorId: editor,
        workspaceId: workspaceA,
        idempotencyKey: "grant-media-access-0001",
      }),
    ).resolves.toMatchObject({
      assets: [expect.objectContaining({ assetId: assetA })],
      occurrences: [],
    });
    await expect(application.queries.audit()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "media.access.granted",
          subjectId: siteA,
        }),
      ]),
    );
  });

  it("replays one access grant with its original audited asset scope", async () => {
    const { application } = setup();
    await upload(application, assetA);
    const command = {
      actorId: editor,
      workspaceId: workspaceA,
      idempotencyKey: "grant-media-access-replay-0001",
    } as const;

    const first = await application.commands.grantAccess(command);
    await application.commands.delete({
      actorId: editor,
      assetId: assetA,
      idempotencyKey: "delete-after-access-grant",
    });
    const replay = await application.commands.grantAccess(command);

    expect(first.assets.map((asset) => asset.assetId)).toEqual([assetA]);
    expect(replay.assets.map((asset) => asset.assetId)).toEqual([assetA]);
    const audits = await application.queries.audit();
    expect(
      audits.filter((event) => event.action === "media.access.granted"),
    ).toHaveLength(1);
  });

  it("audits and replays an exact immutable-revision media grant", async () => {
    const { application } = setup();
    await upload(application, assetA);
    await upload(application, assetB);
    const command = {
      actorId: editor,
      workspaceId: workspaceA,
      assetIds: [assetA],
      idempotencyKey: "grant-revision-media-0001",
    } as const;

    const first = await application.commands.grantRevisionAccess(command);
    const replay = await application.commands.grantRevisionAccess(command);

    expect(first).toEqual({
      assetIds: [assetA],
      accessGrantedAt: "2026-07-27T12:00:00.000Z",
    });
    expect(replay).toEqual(first);
    const audits = await application.queries.audit();
    expect(
      audits.filter((event) => event.action === "media.access.granted"),
    ).toHaveLength(1);
  });

  it("reads a published source without creating an audit row per visitor", async () => {
    const { application } = setup();
    await upload(application);

    await expect(application.queries.getPublishedSource(assetA)).resolves.toEqual(
      expect.objectContaining({ contentType: "image/png" }),
    );

    await expect(application.queries.audit()).resolves.toEqual([
      expect.objectContaining({ action: "media.asset.uploaded" }),
    ]);
  });

  it("rejects AVIF uploads until a bounded frame decoder is available", async () => {
    const { application } = setup();

    await expect(
      application.commands.upload({
        actorId: editor,
        assetId: assetA,
        fileName: "source.avif",
        contentType: "image/avif",
        byteLength: 8,
        width: 120,
        height: 80,
        source: new Uint8Array(8),
        idempotencyKey: "reject-avif-upload",
      }),
    ).rejects.toEqual(expect.objectContaining({ field: "contentType" }));
  });

  it("replaces only the selected occurrence", async () => {
    const { application } = setup();
    await upload(application, assetA);
    await upload(application, assetB);
    await application.commands.replaceOccurrence({
      actorId: editor,
      workspaceId: workspaceA,
      occurrenceId: occurrenceA,
      assetId: assetA,
      baseRevision: 0,
      idempotencyKey: "place-hero",
    });
    await application.commands.replaceOccurrence({
      actorId: editor,
      workspaceId: workspaceA,
      occurrenceId: occurrenceB,
      assetId: assetA,
      baseRevision: 0,
      idempotencyKey: "place-detail",
    });

    const replaced = await application.commands.replaceOccurrence({
      actorId: editor,
      workspaceId: workspaceA,
      occurrenceId: occurrenceA,
      assetId: assetB,
      baseRevision: 1,
      idempotencyKey: "replace-hero-only",
    });

    expect(replaced).toMatchObject({
      occurrenceId: occurrenceA,
      revision: 2,
      assetId: assetB,
    });
    await expect(
      application.queries.getOccurrence(workspaceA, occurrenceB),
    ).resolves.toMatchObject({
      occurrenceId: occurrenceB,
      revision: 1,
      assetId: assetA,
    });
  });

  it("keeps the same occurrence identity isolated across workspaces", async () => {
    const { application } = setup();
    await upload(application, assetA);
    await upload(application, assetB);
    await application.commands.replaceOccurrence({
      actorId: editor,
      workspaceId: workspaceA,
      occurrenceId: occurrenceA,
      assetId: assetA,
      baseRevision: 0,
      idempotencyKey: "place-workspace-alpha",
    });
    await application.commands.replaceOccurrence({
      actorId: editor,
      workspaceId: workspaceB,
      occurrenceId: occurrenceA,
      assetId: assetB,
      baseRevision: 0,
      idempotencyKey: "place-workspace-beta",
    });

    await expect(
      application.queries.getOccurrence(workspaceA, occurrenceA),
    ).resolves.toMatchObject({ revision: 1, assetId: assetA });
    await expect(
      application.queries.getOccurrence(workspaceB, occurrenceA),
    ).resolves.toMatchObject({ revision: 1, assetId: assetB });
  });

  it("creates a workspace-local crop revision from an inherited asset", async () => {
    const { application } = setup();
    await upload(application, assetA);

    const cropped = await application.commands.cropOccurrence({
      actorId: editor,
      workspaceId: workspaceB,
      occurrenceId: occurrenceA,
      assetId: assetA,
      baseRevision: 0,
      crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
      idempotencyKey: "crop-inherited-hero",
    });

    expect(cropped).toMatchObject({
      workspaceId: workspaceB,
      occurrenceId: occurrenceA,
      revision: 1,
      assetId: assetA,
      crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
    });
  });

  it("rejects a save against an asset whose deletion already completed", async () => {
    const { application, assets } = setup();
    await upload(application, assetC);
    const deletion = {
      siteId: siteA,
      idempotencyKey: "complete-before-raced-save",
      requestHash: "delete-request",
      claimToken: "delete-claim",
    };
    await expect(assets.claim(deletion)).resolves.toBe(true);
    await assets.beginAssetDeletion(siteA, assetC, deletion);
    await assets.tombstoneAssetDeletion(
      siteA,
      assetC,
      editor,
      "2026-07-27T12:00:00.000Z",
      deletion,
    );
    await assets.completeAssetDeletion(
      siteA,
      assetC,
      "2026-07-27T12:00:00.000Z",
      deletion,
    );
    const save = {
      siteId: siteA,
      idempotencyKey: "save-after-completed-delete",
      requestHash: "save-request",
      claimToken: "save-claim",
    };
    await expect(assets.claim(save)).resolves.toBe(true);

    await expect(
      assets.saveOccurrence(
        {
          siteId: siteA,
          workspaceId: workspaceA,
          occurrenceId: occurrenceA,
          revision: 1,
          assetId: assetC,
          crop: null,
          createdAt: "2026-07-27T12:00:00.000Z",
          createdBy: editor,
        },
        0,
        "media.occurrence.replaced",
        save,
      ),
    ).rejects.toEqual(new MediaSiteAccessError());
  });

  it("serializes local occurrence head mutations through the media-content coordinator", async () => {
    const coordinator = createInMemoryMediaContentCoordinator();
    const assets = createInMemoryMediaAssetStore({
      mediaContentCoordinator: coordinator,
    });
    const application = createMediaAssetApplication({
      siteId: siteA,
      actorId: editor,
      assets,
      sources: createInMemoryMediaSourceStore(),
      now: () => "2026-07-27T12:00:00.000Z",
    });
    await upload(application);
    const mutation = {
      siteId: siteA,
      idempotencyKey: "coordinated-occurrence-save",
      requestHash: "coordinated-request",
      claimToken: "coordinated-claim",
    };
    await expect(assets.claim(mutation)).resolves.toBe(true);

    let releaseCoordinator = () => {};
    let signalCoordinator = () => {};
    const coordinatorHeld = new Promise<void>((resolve) => {
      signalCoordinator = resolve;
    });
    const coordinatorMayRelease = new Promise<void>((resolve) => {
      releaseCoordinator = resolve;
    });
    const held = coordinator.runExclusive(async () => {
      signalCoordinator();
      await coordinatorMayRelease;
    });
    await coordinatorHeld;

    const save = assets.saveOccurrence(
      {
        siteId: siteA,
        workspaceId: workspaceA,
        occurrenceId: occurrenceA,
        revision: 1,
        assetId: assetA,
        crop: null,
        createdAt: "2026-07-27T12:00:00.000Z",
        createdBy: editor,
      },
      0,
      "media.occurrence.replaced",
      mutation,
    );
    await Promise.resolve();
    await expect(
      assets.getOccurrence(siteA, workspaceA, occurrenceA),
    ).resolves.toBeNull();

    releaseCoordinator();
    await held;
    await save;
    await expect(
      assets.getOccurrence(siteA, workspaceA, occurrenceA),
    ).resolves.toMatchObject({ revision: 1, assetId: assetA });
  });

  it("rejects occurrence identities that do not map to rendered Site Definition slots", async () => {
    const { application } = setup();
    await upload(application);

    await expect(
      application.commands.replaceOccurrence({
        actorId: editor,
        workspaceId: workspaceB,
        occurrenceId: createMediaOccurrenceId("occurrence_unmapped"),
        assetId: assetA,
        baseRevision: 0,
        idempotencyKey: "place-unmapped-occurrence",
      }),
    ).rejects.toEqual(expect.objectContaining({ field: "occurrenceId" }));
  });

  it("replays completed mutation keys without duplicating revisions or audit facts", async () => {
    const { application } = setup();
    const uploaded = await upload(application);
    const command = {
      actorId: editor,
      workspaceId: workspaceA,
      occurrenceId: occurrenceA,
      assetId: assetA,
      baseRevision: 0,
      idempotencyKey: "place-idempotent-hero",
    } as const;

    const first = await application.commands.replaceOccurrence(command);
    const replay = await application.commands.replaceOccurrence(command);
    const uploadReplay = await upload(application);

    expect(replay).toEqual(first);
    expect(uploadReplay).toEqual(uploaded);
    await expect(application.queries.audit()).resolves.toHaveLength(2);
  });

  it("rejects a different source that collides with an existing asset identity", async () => {
    const { application, sources } = setup();
    const original = await upload(application);
    const different = source("different-source");

    await expect(
      application.commands.upload({
        actorId: editor,
        assetId: assetA,
        fileName: "different.png",
        contentType: "image/png",
        byteLength: different.byteLength,
        width: 800,
        height: 600,
        source: different,
        idempotencyKey: "different-upload-source",
      }),
    ).rejects.toEqual(expect.objectContaining({ field: "assetId" }));
    await expect(sources.readForTest(original.objectKey)).resolves.toEqual(
      source(assetA),
    );
  });

  it("binds an idempotency key before any differently shaped mutation can run", async () => {
    const { application } = setup();
    await upload(application, assetA);
    await upload(application, assetB);
    await application.commands.replaceOccurrence({
      actorId: editor,
      workspaceId: workspaceA,
      occurrenceId: occurrenceA,
      assetId: assetA,
      baseRevision: 0,
      idempotencyKey: "one-bound-mutation-key",
    });

    await expect(
      application.commands.replaceOccurrence({
        actorId: editor,
        workspaceId: workspaceB,
        occurrenceId: occurrenceB,
        assetId: assetB,
        baseRevision: 0,
        idempotencyKey: "one-bound-mutation-key",
      }),
    ).rejects.toEqual(
      expect.objectContaining({ field: "idempotencyKey" }),
    );
    await expect(
      application.queries.getOccurrence(workspaceB, occurrenceB),
    ).resolves.toBeNull();
  });

  it("records crops as immutable occurrence revision data without changing the source", async () => {
    const { application, sources } = setup();
    const asset = await upload(application);
    await application.commands.replaceOccurrence({
      actorId: editor,
      workspaceId: workspaceA,
      occurrenceId: occurrenceA,
      assetId: assetA,
      baseRevision: 0,
      idempotencyKey: "place-before-crop",
    });

    const cropped = await application.commands.cropOccurrence({
      actorId: editor,
      workspaceId: workspaceA,
      occurrenceId: occurrenceA,
      assetId: assetA,
      baseRevision: 1,
      crop: { x: 0.1, y: 0.2, width: 0.6, height: 0.5 },
      idempotencyKey: "crop-hero",
    });

    expect(cropped).toMatchObject({
      revision: 2,
      assetId: assetA,
      crop: { x: 0.1, y: 0.2, width: 0.6, height: 0.5 },
    });
    await expect(
      application.queries.getOccurrenceRevision(workspaceA, occurrenceA, 1),
    ).resolves.toMatchObject({ crop: null, assetId: assetA });
    await expect(sources.readForTest(asset.objectKey)).resolves.toEqual(
      source(assetA),
    );
  });

  it("rejects deletion while any revision references an asset and removes an unused source", async () => {
    const { application, sources } = setup();
    await upload(application, assetA);
    await upload(application, assetB);
    const unused = await upload(application, assetC);
    await application.commands.replaceOccurrence({
      actorId: editor,
      workspaceId: workspaceA,
      occurrenceId: occurrenceA,
      assetId: assetA,
      baseRevision: 0,
      idempotencyKey: "place-delete-check",
    });

    await expect(
      application.commands.delete({
        actorId: editor,
        assetId: assetA,
        idempotencyKey: "delete-referenced",
      }),
    ).rejects.toEqual(new MediaAssetReferencedError(assetA, 1));

    await application.commands.replaceOccurrence({
      actorId: editor,
      workspaceId: workspaceA,
      occurrenceId: occurrenceA,
      assetId: assetB,
      baseRevision: 1,
      idempotencyKey: "move-reference",
    });
    await expect(
      application.commands.delete({
        actorId: editor,
        assetId: assetA,
        idempotencyKey: "delete-historical-reference",
      }),
    ).rejects.toEqual(new MediaAssetReferencedError(assetA, 1));
    await application.commands.delete({
      actorId: editor,
      assetId: assetC,
      idempotencyKey: "delete-unused",
    });

    await expect(sources.readForTest(unused.objectKey)).resolves.toBeNull();
    await expect(application.queries.getAsset(assetC)).resolves.toBeNull();
    await expect(application.queries.audit()).resolves.toContainEqual(
      expect.objectContaining({
        action: "media.asset.deleted",
        subjectId: assetC,
      }),
    );
  });

  it("does not replay a successful upload after that stable identity is deleted", async () => {
    const { application } = setup();
    await upload(application, assetC);
    await application.commands.delete({
      actorId: editor,
      assetId: assetC,
      idempotencyKey: "delete-before-upload-replay",
    });

    await expect(upload(application, assetC)).rejects.toEqual(
      expect.objectContaining({ field: "assetId" }),
    );
  });

  it("keeps an interrupted source deletion hidden and recoverable after reload", async () => {
    const baseAssets = createInMemoryMediaAssetStore();
    let failCompletion = true;
    const assets = {
      ...baseAssets,
      async completeAssetDeletion(
        ...args: Parameters<typeof baseAssets.completeAssetDeletion>
      ) {
        if (failCompletion) {
          failCompletion = false;
          throw new Error("simulated_d1_completion_failure");
        }
        return baseAssets.completeAssetDeletion(...args);
      },
    };
    const sources = createInMemoryMediaSourceStore();
    const application = createMediaAssetApplication({
      siteId: siteA,
      actorId: editor,
      assets,
      sources,
      now: () => "2026-07-27T12:00:00.000Z",
    });
    const uploaded = await upload(application, assetC);
    const command = {
      actorId: editor,
      assetId: assetC,
      idempotencyKey: "recover-interrupted-delete",
    } as const;

    await expect(application.commands.delete(command)).rejects.toThrow(
      "simulated_d1_completion_failure",
    );
    await expect(application.queries.getAsset(assetC)).resolves.toBeNull();
    await expect(sources.readForTest(uploaded.objectKey)).resolves.toBeNull();
    await expect(
      application.commands.delete({
        ...command,
        idempotencyKey: "recover-interrupted-delete-after-reload",
      }),
    ).resolves.toBeUndefined();
    await expect(application.queries.audit()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "media.asset.deleted",
          subjectId: assetC,
        }),
      ]),
    );
  });

  it("does not let a different mutation key adopt an in-memory deletion reservation", async () => {
    const { application, assets } = setup();
    await upload(application, assetC);
    const owner = {
      siteId: siteA,
      idempotencyKey: "in-memory-deletion-owner",
      requestHash: "owner-request",
      claimToken: "owner-claim",
    };
    const competitor = {
      siteId: siteA,
      idempotencyKey: "in-memory-deletion-competitor",
      requestHash: "competitor-request",
      claimToken: "competitor-claim",
    };
    await expect(assets.claim(owner)).resolves.toBe(true);
    await expect(assets.claim(competitor)).resolves.toBe(true);
    await expect(
      assets.beginAssetDeletion(siteA, assetC, owner),
    ).resolves.toMatchObject({ assetId: assetC });

    await expect(
      assets.beginAssetDeletion(siteA, assetC, competitor),
    ).rejects.toEqual(new MediaSiteAccessError());
  });

  it("hands a released mutation lease to an already-waiting duplicate", async () => {
    const assets = createInMemoryMediaAssetStore();
    const baseSources = createInMemoryMediaSourceStore();
    let rejectFirstDelete: ((error: Error) => void) | undefined;
    let signalDeleteStarted: (() => void) | undefined;
    const deleteStarted = new Promise<void>((resolve) => {
      signalDeleteStarted = resolve;
    });
    let deleteCalls = 0;
    const sources = {
      ...baseSources,
      async delete(objectKey: string) {
        deleteCalls += 1;
        if (deleteCalls === 1) {
          signalDeleteStarted?.();
          await new Promise<void>((_resolve, reject) => {
            rejectFirstDelete = reject;
          });
          return;
        }
        await baseSources.delete(objectKey);
      },
    };
    const application = createMediaAssetApplication({
      siteId: siteA,
      actorId: editor,
      assets,
      sources,
    });
    await upload(application, assetC);
    const command = {
      actorId: editor,
      assetId: assetC,
      idempotencyKey: "handoff-overlapping-delete",
    } as const;

    const winner = application.commands.delete(command);
    await deleteStarted;
    const duplicate = application.commands.delete(command);
    rejectFirstDelete?.(new Error("simulated_worker_failure"));

    await expect(winner).rejects.toThrow("simulated_worker_failure");
    await expect(duplicate).resolves.toBeUndefined();
    expect(deleteCalls).toBe(2);
  });

  it("bounds active-lease reconciliation and returns a retryable conflict", async () => {
    const baseAssets = createInMemoryMediaAssetStore();
    let claimCalls = 0;
    const assets = {
      ...baseAssets,
      async replay() {
        return null;
      },
      async claim() {
        claimCalls += 1;
        return false;
      },
    };
    const application = createMediaAssetApplication({
      siteId: siteA,
      actorId: editor,
      assets,
      sources: createInMemoryMediaSourceStore(),
    });

    await expect(
      application.commands.delete({
        actorId: editor,
        assetId: assetC,
        idempotencyKey: "bounded-active-delete-lease",
      }),
    ).rejects.toEqual(new MediaMutationInProgressError());
    expect(claimCalls).toBe(3);
  });

  it("fails closed across sites even when identifiers overlap", async () => {
    const assets = createInMemoryMediaAssetStore();
    const sources = createInMemoryMediaSourceStore();
    const alpha = createMediaAssetApplication({
      siteId: siteA,
      actorId: editor,
      assets,
      sources,
    });
    const beta = createMediaAssetApplication({
      siteId: siteB,
      actorId: editor,
      assets,
      sources,
    });
    await upload(alpha);

    await expect(beta.queries.getAsset(assetA)).resolves.toBeNull();
    await expect(
      beta.commands.replaceOccurrence({
        actorId: editor,
        workspaceId: workspaceA,
        occurrenceId: occurrenceA,
        assetId: assetA,
        baseRevision: 0,
        idempotencyKey: "cross-site-reference",
      }),
    ).rejects.toBeInstanceOf(MediaSiteAccessError);
  });
});
