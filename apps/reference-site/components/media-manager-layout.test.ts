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

  it("clears asset-scoped retry attempts for every asset selection change", async () => {
    const component = await readFile(
      new URL("./media-manager.tsx", import.meta.url),
      "utf8",
    );

    expect(component).toMatch(
      /function selectAsset\(assetId: string\) \{\s*replaceAttempt\.current = null;\s*deleteAttempt\.current = null;\s*setSelectedAsset\(assetId\);\s*\}/su,
    );
    expect(component).toContain("selectAsset(asset.assetId);");
    expect(component).toContain('selectAsset(remaining[0]?.assetId ?? "");');
    expect(component).toContain("selectAsset(event.target.value);");
  });
});
