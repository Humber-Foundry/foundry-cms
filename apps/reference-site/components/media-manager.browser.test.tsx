import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import type { ContentRevision } from "@humber-foundry/application";

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

const heroOccurrence = {
  occurrenceId: "occurrence_home_hero",
  revision: 1,
  assetId: "asset_harbour",
  crop: null,
};

const contentRevision = {
  workspaceId: "workspace_owner",
  revision: 4,
  definition: { home: { media: [] } },
  inputs: {},
  createdAt: "2026-08-01T00:00:00.000Z",
  createdBy: "membership-owner",
} as unknown as ContentRevision;

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
          initialOccurrences: [],
          contentRevision,
        }),
      );
    });
    return host;
  }

  function grantWith(assets: ReadonlyArray<unknown>) {
    return {
      assets,
      occurrences: [heroOccurrence],
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
    const tiles = host.querySelectorAll(
      ".media-gallery .media-gallery-tile",
    );
    expect(tiles[0].textContent).toContain("On the page: Top of the page");
    expect(tiles[1].textContent).not.toContain("On the page");
    expect(tiles[1].textContent).toContain("4 KB");
  });

  it("guards deletion of a photo that is on the page", async () => {
    const host = renderLibrary(() =>
      Response.json(grantWith([inUsePhoto, sparePhoto])),
    );
    await waitFor(() => {
      const found = host.querySelectorAll(".media-gallery-tile");
      return found.length === 2 ? found : undefined;
    });

    await userEvent.click(page.getByRole("button", { name: "harbour.jpg" }));

    const deleteButton = page.getByRole("button", {
      name: "Delete selected photo",
    });
    await expect.element(deleteButton).toBeDisabled();
    expect(host.textContent).toContain(
      "The selected photo is on the page, so it cannot be deleted.",
    );
  });

  it("deletes a photo that is not on the page", async () => {
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

  it("opens the shared picker to put a photo in one place", async () => {
    const placed: unknown[] = [];
    const host = renderLibrary((init) => {
      if (typeof init.body === "string") {
        const command = JSON.parse(init.body) as { operation: string };
        if (command.operation === "replace") {
          placed.push(command);
          return Response.json(
            {
              occurrence: { ...heroOccurrence, revision: 2, assetId: "asset_spare" },
              contentRevision: { ...contentRevision, revision: 5 },
              previewUrl: "/__foundry/preview/workspace_owner/5?token=x",
            },
            { status: 201 },
          );
        }
      }
      return Response.json(grantWith([inUsePhoto, sparePhoto]));
    });
    await waitFor(() => {
      const found = host.querySelectorAll(".media-gallery-tile");
      return found.length === 2 ? found : undefined;
    });

    await userEvent.click(
      page.getByRole("button", { name: "Choose or upload a photo…" }).first(),
    );
    const dialog = await waitFor(() => {
      const element = host.querySelector<HTMLDialogElement>("dialog.media-picker");
      return element?.open === true ? element : undefined;
    });
    expect(dialog.textContent).toContain(
      "Choose or upload a photo for “Top of the page”",
    );

    await waitFor(() => {
      const found = dialog.querySelectorAll(".media-gallery-tile");
      return found.length === 2 ? found : undefined;
    });
    const spareTile = [...dialog.querySelectorAll<HTMLButtonElement>(
      ".media-gallery-tile",
    )].find((tile) => tile.textContent?.includes("spare.png"));
    expect(spareTile).toBeDefined();
    await userEvent.click(spareTile!);
    await userEvent.click(
      page.getByRole("button", { name: "Use this photo here" }),
    );

    await waitFor(() => (placed.length === 1 ? placed : undefined));
    expect(placed[0]).toMatchObject({
      operation: "replace",
      occurrenceId: "occurrence_home_hero",
      assetId: "asset_spare",
    });
  });
});
