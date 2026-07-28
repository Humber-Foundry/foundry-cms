import { describe, expect, it } from "vitest";

import {
  mediaUploadAttemptAfterResult,
  type MediaUploadAttempt,
} from "./media-upload-attempt";

describe("media upload attempt", () => {
  it("retains the same asset and idempotency identity after an ambiguous result", () => {
    const attempt = {
      assetId: "asset_stable",
      idempotencyKey: "upload-stable-key",
      body: new FormData(),
    } satisfies MediaUploadAttempt;

    expect(mediaUploadAttemptAfterResult(attempt, false)).toBe(attempt);
    expect(mediaUploadAttemptAfterResult(attempt, true)).toBeNull();
  });
});
