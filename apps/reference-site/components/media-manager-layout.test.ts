import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("media manager layout", () => {
  it("locks the delete action while a mutation is in flight", async () => {
    const component = await readFile(
      new URL("./media-manager.tsx", import.meta.url),
      "utf8",
    );

    expect(component).toMatch(
      /disabled=\{busy\}\s*onClick=\{\(\) => void deleteSelected\(\)\}/su,
    );
  });

  it("holds no photo placement and no crop editor", async () => {
    // Photos is a library only. A photo is put on a page in the page editor,
    // at the photo itself, and through MCP `foundry.media.place`. See
    // ADR-0043 and issue #232.
    const [component, stylesheet] = await Promise.all([
      readFile(new URL("./media-manager.tsx", import.meta.url), "utf8"),
      readFile(new URL("../app/dash/dashboard.css", import.meta.url), "utf8"),
    ]);

    for (const gone of [
      "Where photos appear",
      "Use the selected photo here",
      "media-place",
      "media-crop",
      "MediaPicker",
      "usePhotoInPlace",
    ]) {
      expect(component).not.toContain(gone);
    }
    expect(stylesheet).not.toContain(".media-place");
    expect(stylesheet).not.toContain(".media-crop");
  });

  it("puts the selected photo's file facts and uses beside a larger copy", async () => {
    const [component, stylesheet] = await Promise.all([
      readFile(new URL("./media-manager.tsx", import.meta.url), "utf8"),
      readFile(new URL("../app/dash/dashboard.css", import.meta.url), "utf8"),
    ]);

    expect(component).toContain('className="media-photo-detail"');
    // Square corners are for photos, so the larger copy carries no radius.
    expect(stylesheet).toMatch(
      /\.media-photo-detail-frame\s*\{(?:(?!\})[\s\S])*object-fit:\s*cover;[\s\S]*?\}/su,
    );
    expect(stylesheet).not.toMatch(
      /\.media-photo-detail-frame\s*\{(?:(?!\})[\s\S])*border-radius/su,
    );
  });
});

describe("photo gallery layout", () => {
  it("loads a gallery tile from the thumbnail variant, not the original", async () => {
    const gallery = await readFile(
      new URL("./media-gallery.tsx", import.meta.url),
      "utf8",
    );

    expect(gallery).toContain("mediaThumbnailUrl(asset.assetId, libraryToken)");
    expect(gallery).toContain('loading="lazy"');
    // No page may address the media route by hand and skip the variant.
    expect(gallery).not.toMatch(/\/api\/foundry-cms\/media\?/u);
  });

  it("lays the gallery out as a wrapping list of fixed-size tiles", async () => {
    const stylesheet = await readFile(
      new URL("../app/dash/dashboard.css", import.meta.url),
      "utf8",
    );

    // A CSS grid with a fixed column count leaves the last row ragged
    // whenever the photo count does not divide evenly by that count
    // (issue #173). A wrapping list of tiles at one fixed size has no
    // column tracks to break: a short last row just holds fewer tiles,
    // and no tile grows to fill the gap.
    expect(stylesheet).toMatch(
      /\.media-gallery\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*wrap;[^}]*\}/su,
    );
    expect(stylesheet).toMatch(
      /\.media-gallery > li\s*\{[^}]*flex:\s*0 0 [^;]+;[^}]*width:\s*[^;]+;[^}]*\}/su,
    );
  });

  it("reserves a tile box that matches the frame's shape in the stylesheet", async () => {
    const [gallery, stylesheet] = await Promise.all([
      readFile(new URL("./media-gallery.tsx", import.meta.url), "utf8"),
      readFile(new URL("../app/dash/dashboard.css", import.meta.url), "utf8"),
    ]);

    const width = Number(/galleryTileWidth = (\d+)/u.exec(gallery)?.[1]);
    const height = Number(/galleryTileHeight = (\d+)/u.exec(gallery)?.[1]);
    const ratio = /\.media-gallery-frame\s*\{[^}]*aspect-ratio:\s*(\d+)\s*\/\s*(\d+);/su.exec(
      stylesheet,
    );

    expect(Number.isInteger(width)).toBe(true);
    expect(Number.isInteger(height)).toBe(true);
    expect(ratio).not.toBeNull();
    // A mismatch would make every row shift as its photos arrive.
    expect(width / height).toBeCloseTo(Number(ratio![1]) / Number(ratio![2]), 5);
  });

  it("shows an empty frame when a photo has no stored thumbnail", async () => {
    const gallery = await readFile(
      new URL("./media-gallery.tsx", import.meta.url),
      "utf8",
    );

    // The media route answers 404 rather than serving the original, so the
    // tile must not be left showing a broken image.
    expect(gallery).toContain("onError");
    expect(gallery).toContain("withoutThumbnail");
  });

  it("keeps the picker dialog inside the window on a phone", async () => {
    const stylesheet = await readFile(
      new URL("../app/dash/dashboard.css", import.meta.url),
      "utf8",
    );

    expect(stylesheet).toMatch(
      /\.media-picker\s*\{[^}]*width:\s*min\([^;]*100vw[^;]*;[^}]*\}/su,
    );
    expect(stylesheet).toMatch(
      /\.media-picker\s*\{[^}]*max-height:[^;]+;[^}]*overflow-y:\s*auto;[^}]*\}/su,
    );
  });
});
