import { describe, expect, it } from "vitest";

import { createMediaCatalogFence } from "./media-catalog-fence";

describe("media catalog fence", () => {
  it("rejects an access snapshot that overlaps a media mutation", () => {
    const fence = createMediaCatalogFence();
    const beforeMutation = fence.snapshot();

    fence.beginMutation();
    expect(fence.isCurrent(beforeMutation)).toBe(false);

    const duringMutation = fence.snapshot();
    fence.endMutation();
    expect(fence.isCurrent(duringMutation)).toBe(false);
  });

  it("accepts an access snapshot after the mutation has settled", () => {
    const fence = createMediaCatalogFence();
    fence.beginMutation();
    fence.endMutation();

    expect(fence.isCurrent(fence.snapshot())).toBe(true);
  });
});
