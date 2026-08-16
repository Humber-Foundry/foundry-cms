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

describe("R2 media variant objects", () => {
  const thumbnailKey = "media/site_reference/asset_hero/thumbnail";
  const variant = new Uint8Array([4, 5, 6]);
  const variantHash = "b".repeat(64);
  const sourceHash = "a".repeat(64);

  it("writes a thumbnail to the site-scoped private key bound to its source", async () => {
    const writes: unknown[] = [];
    const store = createR2MediaSourceStore({
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
    });

    await store.putVariant(thumbnailKey, variant, {
      contentType: "image/webp",
      variantHash,
      variantOf: sourceHash,
    });

    expect(writes).toEqual([
      [
        thumbnailKey,
        variant,
        {
          httpMetadata: { contentType: "image/webp" },
          customMetadata: {
            access: "private",
            sourceHash: variantHash,
            variantOf: sourceHash,
          },
          onlyIf: { etagDoesNotMatch: "*" },
        },
      ],
    ]);
  });

  it("refuses a variant key that is not a thumbnail under the site prefix", async () => {
    const store = createR2MediaSourceStore({
      async put() {
        return {};
      },
      async head() {
        return null;
      },
      async get() {
        return null;
      },
      async delete() {},
    });

    await expect(
      store.putVariant("media/site_reference/asset_hero/source", variant, {
        contentType: "image/webp",
        variantHash,
        variantOf: sourceHash,
      }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("reads a thumbnail that was made from the expected source", async () => {
    const body = new ReadableStream<Uint8Array>();
    const store = createR2MediaSourceStore({
      async put() {
        return {};
      },
      async head() {
        return null;
      },
      async get() {
        return {
          body,
          httpMetadata: { contentType: "image/webp" },
          customMetadata: {
            access: "private",
            sourceHash: variantHash,
            variantOf: sourceHash,
          },
        };
      },
      async delete() {},
    });

    await expect(
      store.getVariant(thumbnailKey, { variantOf: sourceHash }),
    ).resolves.toEqual({ body, contentType: "image/webp" });
  });

  it("reports no thumbnail when the stored object was made from another source", async () => {
    const store = createR2MediaSourceStore({
      async put() {
        return {};
      },
      async head() {
        return null;
      },
      async get() {
        return {
          body: new ReadableStream<Uint8Array>(),
          httpMetadata: { contentType: "image/webp" },
          customMetadata: {
            access: "private",
            sourceHash: variantHash,
            variantOf: "c".repeat(64),
          },
        };
      },
      async delete() {},
    });

    await expect(
      store.getVariant(thumbnailKey, { variantOf: sourceHash }),
    ).resolves.toBeNull();
  });

  it("reports no thumbnail when the stored object claims a type the library does not serve", async () => {
    const store = createR2MediaSourceStore({
      async put() {
        return {};
      },
      async head() {
        return null;
      },
      async get() {
        return {
          body: new ReadableStream<Uint8Array>(),
          httpMetadata: { contentType: "text/html" },
          customMetadata: {
            access: "private",
            sourceHash: variantHash,
            variantOf: sourceHash,
          },
        };
      },
      async delete() {},
    });

    await expect(
      store.getVariant(thumbnailKey, { variantOf: sourceHash }),
    ).resolves.toBeNull();
  });

  it("reports no thumbnail when nothing is stored under the key", async () => {
    const store = createR2MediaSourceStore({
      async put() {
        return {};
      },
      async head() {
        return null;
      },
      async get() {
        return null;
      },
      async delete() {},
    });

    await expect(
      store.getVariant(thumbnailKey, { variantOf: sourceHash }),
    ).resolves.toBeNull();
  });

  it("accepts a repeated write of the same thumbnail bytes", async () => {
    const store = createR2MediaSourceStore({
      async put() {
        return null;
      },
      async head() {
        return {
          httpMetadata: { contentType: "image/webp" },
          customMetadata: {
            access: "private",
            sourceHash: variantHash,
            variantOf: sourceHash,
          },
        };
      },
      async get() {
        return null;
      },
      async delete() {},
    });

    await expect(
      store.putVariant(thumbnailKey, variant, {
        contentType: "image/webp",
        variantHash,
        variantOf: sourceHash,
      }),
    ).resolves.toBeUndefined();
  });

  it("refuses a repeated write that would replace a different thumbnail", async () => {
    const store = createR2MediaSourceStore({
      async put() {
        return null;
      },
      async head() {
        return {
          httpMetadata: { contentType: "image/webp" },
          customMetadata: {
            access: "private",
            sourceHash: "d".repeat(64),
            variantOf: sourceHash,
          },
        };
      },
      async get() {
        return null;
      },
      async delete() {},
    });

    await expect(
      store.putVariant(thumbnailKey, variant, {
        contentType: "image/webp",
        variantHash,
        variantOf: sourceHash,
      }),
    ).rejects.toThrow("media_variant_identity_conflict");
  });
});
