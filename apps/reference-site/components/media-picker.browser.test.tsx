import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import { MediaPicker } from "./media-picker";
import type { ChosenPhoto } from "./media-gallery-item";

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
};

const grant = {
  assets: [harbour],
  occurrences: [
    {
      occurrenceId: "occurrence_home_hero",
      revision: 1,
      assetId: "asset_harbour",
      crop: null,
    },
  ],
  accessToken: "signed-media-access",
  accessTokenExpiresAt: Math.floor(Date.now() / 1_000) + 600,
  libraryToken: "signed-media-library",
  libraryTokenExpiresAt: Math.floor(Date.now() / 1_000) + 600,
};

/** A real PNG, drawn in this browser, big enough that a thumbnail shrinks it. */
async function drawPhotoFile(width: number, height: number): Promise<File> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("canvas_unavailable");
  for (let column = 0; column < width; column += 16) {
    context.fillStyle = column % 32 === 0 ? "#14563d" : "#e7f0ea";
    context.fillRect(column, 0, 16, height);
  }
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, "image/png");
  });
  if (blob === null) throw new Error("canvas_encode_failed");
  return new File([blob], "jetty.png", { type: "image/png" });
}

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

describe("photo picker browser acceptance", () => {
  let root: ReturnType<typeof createRoot> | undefined;

  afterEach(() => {
    vi.unstubAllGlobals();
    if (root !== undefined) flushSync(() => root!.unmount());
    document.body.replaceChildren();
  });

  function openPicker(
    handleRequest: (init: RequestInit) => Promise<Response> | Response,
  ) {
    const chosen: ChosenPhoto[] = [];
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
        createElement(MediaPicker, {
          open: true,
          csrfToken: "csrf",
          workspaceId: "workspace_owner",
          onChoose: (photo: ChosenPhoto) => chosen.push(photo),
          onClose: () => undefined,
        }),
      );
    });
    return { chosen, host };
  }

  it("shows the library as a grid of tiles that load the thumbnail variant", async () => {
    const { host } = openPicker(() => Response.json(grant));

    const tile = await waitFor(
      () => host.querySelector<HTMLImageElement>(".media-gallery-tile img") ?? undefined,
    );

    expect(tile.getAttribute("src")).toBe(
      "/api/foundry-cms/media?assetId=asset_harbour&libraryToken=signed-media-library&variant=thumbnail",
    );
    expect(tile.getAttribute("loading")).toBe("lazy");
    const text = host.querySelector(".media-gallery-tile")?.textContent ?? "";
    expect(text).toContain("harbour.jpg");
    expect(text).toContain("1600×900");
    expect(text).toContain("2.3 MB");
    expect(text).toContain("On the page: Top of the page");
  });

  it("hands the caller the photo it picked", async () => {
    const { chosen, host } = openPicker(() => Response.json(grant));
    await waitFor(
      () => host.querySelector(".media-gallery-tile") ?? undefined,
    );

    await userEvent.click(page.getByRole("button", { name: "harbour.jpg" }));
    await userEvent.click(page.getByRole("button", { name: "Use this photo" }));

    expect(chosen).toEqual([
      {
        assetId: "asset_harbour",
        fileName: "harbour.jpg",
        width: 1600,
        height: 900,
        contentType: "image/jpeg",
        thumbnailUrl:
          "/api/foundry-cms/media?assetId=asset_harbour&libraryToken=signed-media-library&variant=thumbnail",
      },
    ]);
  });

  it("uploads a photo with a resized thumbnail and picks it in the same step", async () => {
    const photo = await drawPhotoFile(1200, 800);
    let uploaded: FormData | undefined;
    const jetty = {
      ...harbour,
      assetId: "asset_jetty",
      fileName: "jetty.png",
      contentType: "image/png",
      byteLength: photo.size,
      width: 1200,
      height: 800,
    };
    const { chosen, host } = openPicker((init) => {
      if (init.body instanceof FormData) {
        uploaded = init.body;
        return Response.json(jetty, { status: 201 });
      }
      // A capability names the photos it covers, so the grant after an
      // upload is the first one that covers the new photo.
      return Response.json(
        uploaded === undefined
          ? grant
          : { ...grant, assets: [harbour, jetty] },
      );
    });
    await waitFor(
      () => host.querySelector(".media-gallery-tile") ?? undefined,
    );

    const input = host.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    await userEvent.upload(input!, photo);

    const sent = await waitFor(() => uploaded);
    const source = sent.get("source");
    const thumbnail = sent.get("thumbnail");
    expect(source).toBeInstanceOf(File);
    expect(thumbnail).toBeInstanceOf(File);
    // The whole point of the variant: the stored copy is far smaller than
    // the original the owner uploaded.
    expect((thumbnail as File).size).toBeLessThan((source as File).size);
    expect((thumbnail as File).type).toMatch(/^image\/(webp|png|jpeg)$/u);
    const decoded = await createImageBitmap(thumbnail as File);
    expect(Math.max(decoded.width, decoded.height)).toBe(480);
    expect(decoded.width).toBe(480);
    expect(decoded.height).toBe(320);
    decoded.close();

    await waitFor(() =>
      host.querySelector('.media-gallery-tile[aria-pressed="true"]') ??
      undefined,
    );
    await userEvent.click(page.getByRole("button", { name: "Use this photo" }));

    expect(chosen).toHaveLength(1);
    expect(chosen[0]).toMatchObject({
      assetId: "asset_jetty",
      fileName: "jetty.png",
      thumbnailUrl:
        "/api/foundry-cms/media?assetId=asset_jetty&libraryToken=signed-media-library&variant=thumbnail",
    });
  });

  it("keeps its photos when the library cannot be loaded and says so", async () => {
    const { host } = openPicker(() =>
      Response.json({ error: "request_check_unavailable" }, { status: 503 }),
    );

    const status = await waitFor(() => {
      const element = host.querySelector('[role="status"]');
      return element !== null && element.textContent !== ""
        ? element
        : undefined;
    });

    expect(status.textContent).toContain("could not be loaded");
    expect(host.querySelector(".media-gallery-tile")).toBeNull();
  });
});
