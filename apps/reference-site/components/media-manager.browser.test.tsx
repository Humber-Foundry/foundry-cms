import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import { MediaManager } from "./media-manager";

const inUsePhoto = {
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
};

const sparePhoto = {
  ...inUsePhoto,
  assetId: "asset_spare",
  objectKey: "media/site_reference/asset_spare/source",
  fileName: "spare.png",
  contentType: "image/png",
  byteLength: 4_096,
  width: 800,
  height: 800,
};

/** The harbour photo is on two pages; the spare photo is on none. */
const usage = new Map([
  [
    "asset_harbour",
    ["About — Top of the page", "Foundry Reference — Full-width image"],
  ],
]);

async function waitFor<Value>(read: () => Value | undefined): Promise<Value> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("condition_not_reached");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Resolves with the `src` of each gallery tile image, in order, the instant
 * `count` of them are present. A MutationObserver reads the elements before
 * the media route (which nothing serves in this harness) fails their addresses
 * and the component swaps the frames for placeholders, so a read cannot race
 * those failures. Install it before the render that creates the tiles.
 */
function galleryTileImages(count: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      observer.disconnect();
      reject(new Error("condition_not_reached"));
    }, 5_000);
    const observer = new MutationObserver(() => {
      const images = document.querySelectorAll<HTMLImageElement>(
        ".media-gallery .media-gallery-tile img",
      );
      if (images.length < count) return;
      clearTimeout(deadline);
      observer.disconnect();
      resolve([...images].map((image) => image.getAttribute("src") ?? ""));
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
}

describe("photo library browser acceptance", () => {
  let root: ReturnType<typeof createRoot> | undefined;

  afterEach(() => {
    vi.unstubAllGlobals();
    if (root !== undefined) flushSync(() => root!.unmount());
    document.body.replaceChildren();
  });

  function renderLibrary(
    handleRequest: (init: RequestInit) => Promise<Response> | Response,
  ) {
    vi.stubGlobal(
      "fetch",
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        handleRequest(init ?? {}),
    );
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    flushSync(() => {
      root!.render(
        createElement(MediaManager, {
          csrfToken: "csrf",
          workspaceId: "workspace_owner",
          initialAssets: [],
          usage,
          usedAssetIds: new Set(["asset_harbour"]),
        }),
      );
    });
    return host;
  }

  function grantWith(assets: ReadonlyArray<unknown>) {
    return {
      assets,
      occurrences: [],
      accessToken: "signed-media-access",
      accessTokenExpiresAt: Math.floor(Date.now() / 1_000) + 600,
      libraryToken: "signed-media-library",
      libraryTokenExpiresAt: Math.floor(Date.now() / 1_000) + 600,
    };
  }

  it("shows the uploaded photos as a gallery grid of thumbnail tiles", async () => {
    // Nothing serves the media route here, so each tile's <img> address soon
    // fails to load and the component blanks the frame. Read both images the
    // instant the grid renders, before that happens, so the assertion does not
    // race the failed loads.
    const rendered = galleryTileImages(2);
    const host = renderLibrary(() =>
      Response.json(grantWith([inUsePhoto, sparePhoto])),
    );

    expect(await rendered).toEqual([
      "/api/foundry-cms/media?assetId=asset_harbour&libraryToken=signed-media-library&variant=thumbnail",
      "/api/foundry-cms/media?assetId=asset_spare&libraryToken=signed-media-library&variant=thumbnail",
    ]);
    const tiles = host.querySelectorAll(".media-gallery .media-gallery-tile");
    expect(tiles[1].textContent).toContain("4 KB");
  });

  it("names every page and place a photo is used on, across pages", async () => {
    const host = renderLibrary(() =>
      Response.json(grantWith([inUsePhoto, sparePhoto])),
    );
    const tiles = await waitFor(() => {
      const found = host.querySelectorAll<HTMLElement>(".media-gallery-tile");
      return found.length === 2 ? found : undefined;
    });

    expect(tiles[0].textContent).toContain("Used on: About — Top of the page");
    expect(tiles[0].textContent).toContain(
      "Used on: Foundry Reference — Full-width image",
    );
    expect(tiles[1].textContent).toContain("Not used yet");
  });

  it("holds no way to place a photo — that belongs to the page editor", async () => {
    const host = renderLibrary(() =>
      Response.json(grantWith([inUsePhoto, sparePhoto])),
    );
    await waitFor(() => {
      const found = host.querySelectorAll(".media-gallery-tile");
      return found.length === 2 ? found : undefined;
    });

    expect(host.textContent).not.toContain("Where photos appear");
    expect(host.textContent).not.toContain("Use the selected photo here");
    expect(host.textContent).not.toContain("Choose or upload a photo");
    expect(host.querySelector("dialog.media-picker")).toBeNull();
  });

  it("refuses to delete a photo that is in use and names every use", async () => {
    let deleted: unknown;
    const host = renderLibrary((init) => {
      if (typeof init.body === "string") {
        const command = JSON.parse(init.body) as { operation: string };
        if (command.operation === "delete") {
          deleted = command;
          return new Response(null, { status: 204 });
        }
      }
      return Response.json(grantWith([inUsePhoto, sparePhoto]));
    });
    await waitFor(() => {
      const found = host.querySelectorAll(".media-gallery-tile");
      return found.length === 2 ? found : undefined;
    });

    await userEvent.click(page.getByRole("button", { name: "harbour.jpg" }));
    await userEvent.click(
      page.getByRole("button", { name: "Delete selected photo" }),
    );

    expect(deleted).toBeUndefined();
    expect(host.textContent).toContain("This photo cannot be deleted.");
    expect(host.textContent).toContain("Change the photo in each place first.");
    expect(host.textContent).toContain("About — Top of the page");
    expect(host.textContent).toContain("Foundry Reference — Full-width image");
  });

  it("deletes a photo that is used nowhere", async () => {
    let deleted: unknown;
    let remaining = [inUsePhoto, sparePhoto];
    const host = renderLibrary((init) => {
      if (typeof init.body === "string") {
        const command = JSON.parse(init.body) as { operation: string };
        if (command.operation === "delete") {
          deleted = command;
          remaining = [inUsePhoto];
          return new Response(null, { status: 204 });
        }
      }
      return Response.json(grantWith(remaining));
    });
    await waitFor(() => {
      const found = host.querySelectorAll(".media-gallery-tile");
      return found.length === 2 ? found : undefined;
    });

    await userEvent.click(page.getByRole("button", { name: "spare.png" }));
    await userEvent.click(
      page.getByRole("button", { name: "Delete selected photo" }),
    );

    expect(deleted).toMatchObject({
      operation: "delete",
      assetId: "asset_spare",
    });
    await waitFor(() => {
      const found = host.querySelectorAll(".media-gallery-tile");
      return found.length === 1 ? found : undefined;
    });
    expect(host.textContent).toContain("Photo deleted.");
  });
});
