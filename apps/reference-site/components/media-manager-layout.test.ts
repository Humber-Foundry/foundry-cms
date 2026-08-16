import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("media manager layout", () => {
  it("locks selection controls while a mutation owns retry state", async () => {
    const component = await readFile(
      new URL("./media-manager.tsx", import.meta.url),
      "utf8",
    );

    // Placing a photo is blocked while a mutation owns retry state.
    expect(component).toMatch(
      /disabled=\{\s*busy\s*\|\|[\s\S]*?\}\s*onClick=\{\(\) => void usePhotoInPlace/su,
    );
    // The per-place crop inputs lock the same way.
    expect(component).toMatch(
      /disabled=\{busy \|\| occurrenceId !== id\}/su,
    );
  });

  it("constrains uncropped occurrence images to the dashboard width", async () => {
    const [stylesheet, component] = await Promise.all([
      readFile(new URL("../app/dash/dashboard.css", import.meta.url), "utf8"),
      readFile(new URL("./media-manager.tsx", import.meta.url), "utf8"),
    ]);

    expect(component).toContain('className="media-manager-preview"');
    expect(stylesheet).toMatch(
      /\.media-manager-preview img\s*\{[^}]*max-width:\s*100%;[^}]*\}/su,
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

  it("lays the gallery out so its last row is as full as the rows above", async () => {
    const stylesheet = await readFile(
      new URL("../app/dash/dashboard.css", import.meta.url),
      "utf8",
    );

    expect(stylesheet).toMatch(
      /\.media-gallery\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*wrap;[^}]*\}/su,
    );
    expect(stylesheet).toMatch(
      /\.media-gallery > li\s*\{[^}]*flex:\s*1 1 [^;]+;[^}]*\}/su,
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
