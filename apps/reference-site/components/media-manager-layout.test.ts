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
