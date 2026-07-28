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
    | Readonly<{
        httpMetadata?: Readonly<{ contentType?: string }>;
        customMetadata?: Readonly<Record<string, string>>;
      }>
    | null
  >;
  get(key: string): Promise<
    | Readonly<{
        body: ReadableStream<Uint8Array>;
        httpMetadata?: Readonly<{ contentType?: string }>;
        customMetadata?: Readonly<Record<string, string>>;
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
        if (
          existing?.customMetadata?.sourceHash !== metadata.sourceHash ||
          existing.httpMetadata?.contentType !== metadata.contentType
        ) {
          throw new Error("media_source_identity_conflict");
        }
      }
    },
    async delete(objectKey) {
      await bucket.delete(objectKey);
    },
    async get(objectKey, expected) {
      const object = await bucket.get(objectKey);
      if (object === null) return null;
      if (
        object.customMetadata?.sourceHash !== expected.sourceHash ||
        object.httpMetadata?.contentType !== expected.contentType
      ) {
        throw new Error("media_source_identity_conflict");
      }
      return {
        body: object.body,
        contentType: expected.contentType,
      };
    },
  });
}
