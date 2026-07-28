import { readFile } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";

import {
  MediaAssetReferencedError,
  MediaSiteAccessError,
  createContentActorId,
  createContentWorkspaceId,
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
  const workspaceId = createContentWorkspaceId("workspace_editor");
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
      workspaceId,
      occurrenceId,
      assetId,
      baseRevision: 0,
      idempotencyKey: "place-d1-hero",
    });
    await app.commands.cropOccurrence({
      actorId,
      workspaceId,
      occurrenceId,
      baseRevision: 1,
      crop: { x: 0, y: 0, width: 0.5, height: 0.5 },
      idempotencyKey: "crop-d1-hero",
    });
    await app.commands.replaceOccurrence({
      actorId,
      workspaceId,
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
      workspaceId,
      occurrenceId,
      assetId,
      baseRevision: 0,
      idempotencyKey: "d1-bound-mutation-key",
    });
    const otherOccurrence = createMediaOccurrenceId("occurrence_home_detail");

    await expect(
      app.commands.replaceOccurrence({
        actorId,
        workspaceId,
        occurrenceId: otherOccurrence,
        assetId: replacementId,
        baseRevision: 0,
        idempotencyKey: "d1-bound-mutation-key",
      }),
    ).rejects.toThrow("media_site_access_denied");
    await expect(app.queries.getOccurrence(otherOccurrence)).resolves.toBeNull();
  });

  it("replays overlapping identical occurrence mutations", async () => {
    const app = application();
    await upload(app);
    const command = {
      actorId,
      workspaceId,
      occurrenceId,
      assetId,
      baseRevision: 0,
      idempotencyKey: "d1-overlapping-mutation-key",
    } as const;

    const [first, duplicate] = await Promise.all([
      app.commands.replaceOccurrence(command),
      app.commands.replaceOccurrence(command),
    ]);

    expect(duplicate).toEqual(first);
    await expect(app.queries.getOccurrence(occurrenceId)).resolves.toEqual(
      first,
    );
  });

  it("takes over an expired orphan mutation lease", async () => {
    const store = createD1MediaAssetStore(database);
    const orphan = {
      siteId,
      idempotencyKey: "d1-orphan-mutation-key",
      requestHash: "same-request",
      claimToken: "dead-worker",
    };
    await expect(store.claim(orphan)).resolves.toBe(true);
    await database
      .prepare(
        `UPDATE media_mutation_claims
         SET claimed_at = datetime('now', '-31 seconds')
         WHERE site_id = ?1 AND idempotency_key = ?2`,
      )
      .bind(siteId, orphan.idempotencyKey)
      .run();

    await expect(
      store.claim({ ...orphan, claimToken: "recovery-worker" }),
    ).resolves.toBe(true);
  });

  it("fences an expired lease owner after a takeover", async () => {
    const store = createD1MediaAssetStore(database);
    const staleOwner = {
      siteId,
      idempotencyKey: "d1-stale-owner-mutation-key",
      requestHash: "same-stale-owner-request",
      claimToken: "paused-worker",
    };
    await expect(store.claim(staleOwner)).resolves.toBe(true);
    await database
      .prepare(
        `UPDATE media_mutation_claims
         SET claimed_at = datetime('now', '-31 seconds')
         WHERE site_id = ?1 AND idempotency_key = ?2`,
      )
      .bind(siteId, staleOwner.idempotencyKey)
      .run();
    const successor = { ...staleOwner, claimToken: "successor-worker" };
    await expect(store.claim(successor)).resolves.toBe(true);
    const asset = {
      siteId,
      assetId,
      objectKey: `media/${siteId}/${assetId}/source`,
      sourceHash: "a".repeat(64),
      fileName: "hero.png",
      contentType: "image/png" as const,
      byteLength: 3,
      width: 1200,
      height: 800,
      createdAt: "2026-07-27T12:00:00.000Z",
      createdBy: actorId,
    };

    await expect(store.createAsset(asset, staleOwner)).rejects.toEqual(
      new MediaSiteAccessError(),
    );
    await expect(store.createAsset(asset, successor)).resolves.toEqual(asset);
    await expect(store.getAsset(siteId, assetId)).resolves.toEqual(asset);
  });

  it("replays a receipt instead of taking over its expired claim", async () => {
    const store = createD1MediaAssetStore(database);
    const completed = {
      siteId,
      idempotencyKey: "d1-completed-expired-claim",
      requestHash: "same-completed-request",
      claimToken: "completed-worker",
    };
    await expect(store.claim(completed)).resolves.toBe(true);
    await database
      .prepare(
        `UPDATE media_mutation_claims
         SET claimed_at = datetime('now', '-31 seconds')
         WHERE site_id = ?1 AND idempotency_key = ?2`,
      )
      .bind(siteId, completed.idempotencyKey)
      .run();
    await store.record(completed, { kind: "deleted", assetId });

    const duplicate = { ...completed, claimToken: "duplicate-worker" };
    await expect(store.claim(duplicate)).resolves.toBe(false);
    await expect(store.replay(duplicate)).resolves.toEqual({
      kind: "deleted",
      assetId,
    });
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

  it("does not let a different mutation key adopt a deletion reservation", async () => {
    const app = application();
    await upload(app);
    const store = createD1MediaAssetStore(database);
    const owner = {
      siteId,
      idempotencyKey: "deletion-reservation-owner",
      requestHash: "owner-request",
      claimToken: "owner-claim",
    };
    const competitor = {
      siteId,
      idempotencyKey: "deletion-reservation-competitor",
      requestHash: "competitor-request",
      claimToken: "competitor-claim",
    };
    await expect(store.claim(owner)).resolves.toBe(true);
    await expect(store.claim(competitor)).resolves.toBe(true);
    await expect(
      store.beginAssetDeletion(siteId, assetId, owner),
    ).resolves.toMatchObject({ assetId });

    await expect(
      store.beginAssetDeletion(siteId, assetId, competitor),
    ).rejects.toEqual(new MediaSiteAccessError());
    await expect(
      store.tombstoneAssetDeletion(
        siteId,
        assetId,
        actorId,
        "2026-07-27T12:00:00.000Z",
        competitor,
      ),
    ).rejects.toEqual(new MediaSiteAccessError());
  });
});
