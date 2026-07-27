import { describe, expect, it } from "vitest";

import { createSiteId } from "@foundry/site-definition";

import {
  MediaAssetReferencedError,
  MediaSiteAccessError,
  createContentActorId,
  createInMemoryMediaAssetStore,
  createInMemoryMediaSourceStore,
  createMediaAssetApplication,
  createMediaAssetId,
  createMediaOccurrenceId,
} from "./index";

const siteA = createSiteId("site_alpha");
const siteB = createSiteId("site_beta");
const editor = createContentActorId("membership-editor");
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

  it("audits authenticated catalog and private-source reads", async () => {
    const { application } = setup();
    await upload(application);

    await application.queries.listAssets();
    await application.queries.listOccurrences();
    await application.queries.getSource(assetA);

    await expect(application.queries.audit()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "media.assets.listed" }),
        expect.objectContaining({ action: "media.occurrences.listed" }),
        expect.objectContaining({
          action: "media.source.read",
          subjectId: assetA,
        }),
      ]),
    );
  });

  it("replaces only the selected occurrence", async () => {
    const { application } = setup();
    await upload(application, assetA);
    await upload(application, assetB);
    await application.commands.replaceOccurrence({
      actorId: editor,
      occurrenceId: occurrenceA,
      assetId: assetA,
      baseRevision: 0,
      idempotencyKey: "place-hero",
    });
    await application.commands.replaceOccurrence({
      actorId: editor,
      occurrenceId: occurrenceB,
      assetId: assetA,
      baseRevision: 0,
      idempotencyKey: "place-detail",
    });

    const replaced = await application.commands.replaceOccurrence({
      actorId: editor,
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
      application.queries.getOccurrence(occurrenceB),
    ).resolves.toMatchObject({
      occurrenceId: occurrenceB,
      revision: 1,
      assetId: assetA,
    });
  });

  it("replays completed mutation keys without duplicating revisions or audit facts", async () => {
    const { application } = setup();
    const uploaded = await upload(application);
    const command = {
      actorId: editor,
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
      occurrenceId: occurrenceA,
      assetId: assetA,
      baseRevision: 0,
      idempotencyKey: "one-bound-mutation-key",
    });

    await expect(
      application.commands.replaceOccurrence({
        actorId: editor,
        occurrenceId: occurrenceB,
        assetId: assetB,
        baseRevision: 0,
        idempotencyKey: "one-bound-mutation-key",
      }),
    ).rejects.toEqual(
      expect.objectContaining({ field: "idempotencyKey" }),
    );
    await expect(application.queries.getOccurrence(occurrenceB)).resolves.toBeNull();
  });

  it("records crops as immutable occurrence revision data without changing the source", async () => {
    const { application, sources } = setup();
    const asset = await upload(application);
    await application.commands.replaceOccurrence({
      actorId: editor,
      occurrenceId: occurrenceA,
      assetId: assetA,
      baseRevision: 0,
      idempotencyKey: "place-before-crop",
    });

    const cropped = await application.commands.cropOccurrence({
      actorId: editor,
      occurrenceId: occurrenceA,
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
      application.queries.getOccurrenceRevision(occurrenceA, 1),
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
        occurrenceId: occurrenceA,
        assetId: assetA,
        baseRevision: 0,
        idempotencyKey: "cross-site-reference",
      }),
    ).rejects.toBeInstanceOf(MediaSiteAccessError);
  });
});
