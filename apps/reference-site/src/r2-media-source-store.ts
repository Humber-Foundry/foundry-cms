import type { MediaSourceStore } from "@foundry/application";

export interface PrivateMediaBucket {
  put(
    key: string,
    value: Uint8Array,
    options: Readonly<{
      httpMetadata: Readonly<{ contentType: string }>;
      customMetadata: Readonly<{
        access: "private";
        sourceHash: string;
      }>;
      onlyIf: Readonly<{ etagDoesNotMatch: "*" }>;
    }>,
  ): Promise<unknown | null>;
  head(key: string): Promise<
    | Readonly<{ customMetadata?: Readonly<Record<string, string>> }>
    | null
  >;
  get(key: string): Promise<
    | Readonly<{
        httpMetadata?: Readonly<{ contentType?: string }>;
        arrayBuffer(): Promise<ArrayBuffer>;
      }>
    | null
  >;
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
      const stored = await bucket.put(objectKey, source, {
        httpMetadata: { contentType: metadata.contentType },
        customMetadata: {
          access: "private",
          sourceHash: metadata.sourceHash,
        },
        onlyIf: { etagDoesNotMatch: "*" },
      });
      if (stored === null) {
        const existing = await bucket.head(objectKey);
        if (existing?.customMetadata?.sourceHash !== metadata.sourceHash) {
          throw new Error("media_source_identity_conflict");
        }
      }
    },
    async delete(objectKey) {
      await bucket.delete(objectKey);
    },
    async get(objectKey) {
      const object = await bucket.get(objectKey);
      if (object === null) return null;
      return {
        body: new Uint8Array(await object.arrayBuffer()),
        contentType:
          object.httpMetadata?.contentType ?? "application/octet-stream",
      };
    },
  });
}
