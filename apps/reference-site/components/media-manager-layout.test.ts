import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("media manager layout", () => {
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
