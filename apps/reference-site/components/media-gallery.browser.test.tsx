import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import type { MediaAsset } from "@humber-foundry/application";

import { MediaGallery } from "./media-gallery";

const harbour = {
  siteId: "site_reference",
  assetId: "asset_harbour",
  objectKey: "media/site_reference/asset_harbour/source",
  sourceHash: "a".repeat(64),
  fileName: "harbour.jpg",
  contentType: "image/jpeg",
  byteLength: 2_411_724,
  width: 1600,
  height: 900,
  createdAt: "2026-08-01T00:00:00.000Z",
  createdBy: "membership-owner",
} as unknown as MediaAsset;

/** Waits for `read` to return a value, so no test depends on a fixed delay. */
async function waitFor<Value>(read: () => Value | undefined): Promise<Value> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("condition_not_reached");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("photo gallery tiles", () => {
  let root: ReturnType<typeof createRoot> | undefined;

  afterEach(() => {
    if (root !== undefined) flushSync(() => root!.unmount());
    document.body.replaceChildren();
  });

  function renderGallery(libraryToken: string) {
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    show(libraryToken);
    return host;
  }

  function show(libraryToken: string) {
    flushSync(() => {
      root!.render(
        createElement(MediaGallery, {
          assets: [harbour],
          occurrences: [],
          libraryToken,
          selectedAssetId: "",
          onSelect: () => undefined,
        }),
      );
    });
  }

  /** How many times the browser asked for a tile carrying this capability. */
  function requestsCarrying(libraryToken: string) {
    return performance
      .getEntriesByType("resource")
      .filter((entry) =>
        entry.name.includes(`libraryToken=${libraryToken}`),
      ).length;
  }

  it("tries the tile again once a fresh capability has arrived", async () => {
    // Nothing serves the media route here, so the tile's address fails and
    // the frame is left empty rather than showing a broken image.
    const host = renderGallery("expired-library-token");
    await waitFor(
      () => host.querySelector(".media-gallery-placeholder") ?? undefined,
    );
    expect(host.querySelector(".media-gallery-tile img")).toBeNull();
    expect(requestsCarrying("fresh-library-token")).toBe(0);

    show("fresh-library-token");

    // A failure that only meant "that capability had expired" must not blank
    // the tile for the rest of the session. Once a fresh capability arrives
    // the tile is asked for again, under its new address.
    await waitFor(() =>
      requestsCarrying("fresh-library-token") > 0 ? true : undefined,
    );
  });
});
