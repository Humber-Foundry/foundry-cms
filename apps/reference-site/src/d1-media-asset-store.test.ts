import { readFile } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";

import {
  MediaAssetReferencedError,
  createContentActorId,
  createInMemoryMediaSourceStore,
  createMediaAssetApplication,
  createMediaAssetId,
  createMediaOccurrenceId,
} from "@foundry/application";
import { createSiteId } from "@foundry/site-definition";

import { createD1MediaAssetStore } from "./d1-media-asset-store";

describe("D1 media asset store", () => {
  const siteId = createSiteId("site_reference");
  const actorId = createContentActorId("membership-editor");
  const assetId = createMediaAssetId("asset_hero");
  const replacementId = createMediaAssetId("asset_replacement");
  const occurrenceId = createMediaOccurrenceId("occurrence_home_hero");
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
    const migration = await readFile(
      new URL("../migrations/0007_media_assets.sql", import.meta.url),
      "utf8",
    );
    for (const statement of migration.trim().split(/\n\n+/u)) {
      await database.prepare(statement).run();
    }
  });

  afterEach(async () => {
    await miniflare.dispose();
  });

  function application() {
    return createMediaAssetApplication({
      siteId,
      actorId,
      assets: createD1MediaAssetStore(database),
      sources: createInMemoryMediaSourceStore(),
      now: () => "2026-07-27T12:00:00.000Z",
    });
  }

  async function upload(
    app: ReturnType<typeof application>,
    targetAssetId = assetId,
  ) {
    const source = new Uint8Array([1, 2, 3]);
    return app.commands.upload({
      actorId,
      assetId: targetAssetId,
      fileName: `${targetAssetId}.png`,
      contentType: "image/png",
      byteLength: source.byteLength,
      width: 1200,
      height: 800,
      source,
      idempotencyKey: `upload-${targetAssetId}`,
    });
  }

  it("persists site-scoped metadata, immutable occurrence revisions, and audit events", async () => {
    const app = application();
    await upload(app);
    await upload(app, replacementId);
    await app.commands.replaceOccurrence({
      actorId,
      occurrenceId,
      assetId,
      baseRevision: 0,
      idempotencyKey: "place-d1-hero",
    });
    await app.commands.cropOccurrence({
      actorId,
      occurrenceId,
      baseRevision: 1,
      crop: { x: 0, y: 0, width: 0.5, height: 0.5 },
      idempotencyKey: "crop-d1-hero",
    });
    await app.commands.replaceOccurrence({
      actorId,
      occurrenceId,
      assetId: replacementId,
      baseRevision: 2,
      idempotencyKey: "replace-d1-hero",
    });

    await expect(app.queries.getOccurrence(occurrenceId)).resolves.toMatchObject({
      revision: 3,
      assetId: replacementId,
      crop: null,
    });
    await expect(
      app.queries.getOccurrenceRevision(occurrenceId, 2),
    ).resolves.toMatchObject({
      assetId,
      crop: { x: 0, y: 0, width: 0.5, height: 0.5 },
    });
    await expect(app.queries.audit()).resolves.toHaveLength(5);
    await expect(
      app.commands.delete({
        actorId,
        assetId,
        idempotencyKey: "delete-d1-referenced",
      }),
    ).rejects.toEqual(new MediaAssetReferencedError(assetId, 1));
  });

  it("keeps overlapping identifiers isolated by site", async () => {
    const alpha = application();
    await upload(alpha);
    const other = createMediaAssetApplication({
      siteId: createSiteId("site_other"),
      actorId,
      assets: createD1MediaAssetStore(database),
      sources: createInMemoryMediaSourceStore(),
    });

    await expect(other.queries.getAsset(assetId)).resolves.toBeNull();
  });

  it("binds one D1 idempotency key to one request before mutation", async () => {
    const app = application();
    await upload(app, assetId);
    await upload(app, replacementId);
    await app.commands.replaceOccurrence({
      actorId,
      occurrenceId,
      assetId,
      baseRevision: 0,
      idempotencyKey: "d1-bound-mutation-key",
    });
    const otherOccurrence = createMediaOccurrenceId("occurrence_home_detail");

    await expect(
      app.commands.replaceOccurrence({
        actorId,
        occurrenceId: otherOccurrence,
        assetId: replacementId,
        baseRevision: 0,
        idempotencyKey: "d1-bound-mutation-key",
      }),
    ).rejects.toThrow("media_site_access_denied");
    await expect(app.queries.getOccurrence(otherOccurrence)).resolves.toBeNull();
  });

  it("retains a tombstone so a deleted stable asset identity cannot be reused", async () => {
    const app = application();
    await upload(app);
    await app.commands.delete({
      actorId,
      assetId,
      idempotencyKey: "delete-unused-stable-asset",
    });

    await expect(app.queries.getAsset(assetId)).resolves.toBeNull();
    const source = new Uint8Array([1, 2, 3]);
    await expect(
      app.commands.upload({
        actorId,
        assetId,
        fileName: "reused.png",
        contentType: "image/png",
        byteLength: source.byteLength,
        width: 1200,
        height: 800,
        source,
        idempotencyKey: "reuse-deleted-stable-asset",
      }),
    ).rejects.toThrow();
    const row = await database
      .prepare(
        `SELECT deleted_at FROM media_assets
         WHERE site_id = ?1 AND asset_id = ?2`,
      )
      .bind(siteId, assetId)
      .first<{ deleted_at: string | null }>();
    expect(row?.deleted_at).toBe("2026-07-27T12:00:00.000Z");
    await expect(upload(app)).rejects.toThrow();
  });
});
