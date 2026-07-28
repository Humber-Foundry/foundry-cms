import { describe, expect, it } from "vitest";

import {
  createR2MediaSourceStore,
  type PrivateMediaBucket,
} from "./r2-media-source-store";

describe("R2 media source store", () => {
  it("writes a source to the site-scoped private key without creating public access", async () => {
    const writes: unknown[] = [];
    const bucket: PrivateMediaBucket = {
      async put(...input) {
        writes.push(input);
        return {};
      },
      async head() {
        return null;
      },
      async get() {
        return null;
      },
      async delete() {},
    };
    const store = createR2MediaSourceStore(bucket);
    const source = new Uint8Array([1, 2, 3]);

    await store.put(
      "media/site_reference/asset_hero/source",
      source,
      { contentType: "image/png", sourceHash: "a".repeat(64) },
    );

    expect(writes).toEqual([
      [
        "media/site_reference/asset_hero/source",
        source,
        {
          httpMetadata: { contentType: "image/png" },
          customMetadata: {
            access: "private",
            sourceHash: "a".repeat(64),
          },
          onlyIf: { etagDoesNotMatch: "*" },
        },
      ],
    ]);
  });

  it("reconciles an existing identical source and rejects an identity collision", async () => {
    const bucket: PrivateMediaBucket = {
      async put() {
        return null;
      },
      async head() {
        return {
          httpMetadata: { contentType: "image/png" },
          customMetadata: { sourceHash: "a".repeat(64) },
        };
      },
      async get() {
        return null;
      },
      async delete() {},
    };
    const store = createR2MediaSourceStore(bucket);
    await expect(
      store.put(
        "media/site_reference/asset_hero/source",
        new Uint8Array([1]),
        { contentType: "image/png", sourceHash: "a".repeat(64) },
      ),
    ).resolves.toBeUndefined();
    await expect(
      store.put(
        "media/site_reference/asset_hero/source",
        new Uint8Array([2]),
        { contentType: "image/png", sourceHash: "b".repeat(64) },
      ),
    ).rejects.toThrow("media_source_identity_conflict");
  });

  it("rejects an existing source with matching bytes but conflicting content metadata", async () => {
    const bucket: PrivateMediaBucket = {
      async put() {
        return null;
      },
      async head() {
        return {
          httpMetadata: { contentType: "image/jpeg" },
          customMetadata: { sourceHash: "a".repeat(64) },
        };
      },
      async get() {
        return null;
      },
      async delete() {},
    };
    const store = createR2MediaSourceStore(bucket);

    await expect(
      store.put(
        "media/site_reference/asset_hero/source",
        new Uint8Array([1]),
        { contentType: "image/png", sourceHash: "a".repeat(64) },
      ),
    ).rejects.toThrow("media_source_identity_conflict");
  });

  it("streams a source only when its immutable metadata matches", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });
    const bucket: PrivateMediaBucket = {
      async put() {
        return {};
      },
      async head() {
        return null;
      },
      async get() {
        return {
          body,
          httpMetadata: { contentType: "image/png" },
          customMetadata: { sourceHash: "a".repeat(64) },
        };
      },
      async delete() {},
    };
    const store = createR2MediaSourceStore(bucket);

    await expect(
      store.get("media/site_reference/asset_hero/source", {
        contentType: "image/png",
        sourceHash: "a".repeat(64),
      }),
    ).resolves.toEqual({ body, contentType: "image/png" });
    await expect(
      store.get("media/site_reference/asset_hero/source", {
        contentType: "image/png",
        sourceHash: "b".repeat(64),
      }),
    ).rejects.toThrow("media_source_identity_conflict");
  });
});
