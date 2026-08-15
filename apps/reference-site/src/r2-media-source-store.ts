import type { MediaSourceStore } from "@humber-foundry/application";

export interface PrivateMediaBucket {
  put(
    key: string,
    value: Uint8Array,
    options: Readonly<{
      httpMetadata: Readonly<{ contentType: string }>;
      customMetadata: Readonly<{
        access: "private";
        sourceHash: string;
        variantOf?: string;
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

/** The image types the library writes as a thumbnail and will serve back. */
const servedVariantContentTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

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
    async putVariant(objectKey, variant, metadata) {
      if (
        !/^media\/site_[a-z0-9_]+\/asset_[a-z0-9_]+\/thumbnail$/u.test(objectKey)
      ) {
        throw new TypeError("media_variant_key_invalid");
      }
      const stored = await bucket.put(objectKey, variant, {
        httpMetadata: { contentType: metadata.contentType },
        customMetadata: {
          access: "private",
          sourceHash: metadata.variantHash,
          variantOf: metadata.variantOf,
        },
        onlyIf: { etagDoesNotMatch: "*" },
      });
      if (stored === null) {
        const existing = await bucket.head(objectKey);
        if (
          existing?.customMetadata?.sourceHash !== metadata.variantHash ||
          existing.customMetadata.variantOf !== metadata.variantOf ||
          existing.httpMetadata?.contentType !== metadata.contentType
        ) {
          throw new Error("media_variant_identity_conflict");
        }
      }
    },
    async getVariant(objectKey, expected) {
      const object = await bucket.get(objectKey);
      if (object === null) return null;
      const contentType = object.httpMetadata?.contentType;
      // A variant that was not made from this exact source, or that claims a
      // type the library never writes, is treated as missing so the caller
      // falls back to the source instead of serving the wrong bytes.
      if (
        object.customMetadata?.variantOf !== expected.variantOf ||
        contentType === undefined ||
        !servedVariantContentTypes.has(contentType)
      ) {
        return null;
      }
      return { body: object.body, contentType };
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
