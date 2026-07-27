import type { MediaSourceStore } from "@foundry/application";

export interface PrivateMediaBucket {
  put(
    key: string,
    value: Uint8Array,
    options: Readonly<{
      httpMetadata: Readonly<{ contentType: string }>;
      customMetadata: Readonly<{ access: "private" }>;
    }>,
  ): Promise<unknown>;
  delete(key: string): Promise<unknown>;
}

export function createR2MediaSourceStore(
  bucket: PrivateMediaBucket,
): MediaSourceStore {
  return Object.freeze({
    async put(objectKey, source, metadata) {
      if (!/^media\/site_[a-z0-9_]+\/asset_[a-z0-9_]+\/source$/u.test(objectKey)) {
        throw new TypeError("media_object_key_invalid");
      }
      await bucket.put(objectKey, source, {
        httpMetadata: { contentType: metadata.contentType },
        customMetadata: { access: "private" },
      });
    },
    async delete(objectKey) {
      await bucket.delete(objectKey);
    },
  });
}
