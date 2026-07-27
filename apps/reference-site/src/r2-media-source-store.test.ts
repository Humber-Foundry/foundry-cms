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
      },
      async delete() {},
    };
    const store = createR2MediaSourceStore(bucket);
    const source = new Uint8Array([1, 2, 3]);

    await store.put(
      "media/site_reference/asset_hero/source",
      source,
      { contentType: "image/png" },
    );

    expect(writes).toEqual([
      [
        "media/site_reference/asset_hero/source",
        source,
        {
          httpMetadata: { contentType: "image/png" },
          customMetadata: { access: "private" },
        },
      ],
    ]);
  });
});
