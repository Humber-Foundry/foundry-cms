import { describe, expect, it } from "vitest";

import {
  publicScriptPaths,
  publicStylePaths,
} from "./public-script-paths.mjs";

describe("publicScriptPaths", () => {
  it("finds scripts and preload-only JavaScript without duplicates", () => {
    const html = [
      '<script src="/_next/direct.js" async></script>',
      '<link rel="preload" as="script" href="/_next/preloaded.js">',
      '<link href="/_next/module.js" rel="modulepreload">',
      '<link rel="preload" as="style" href="/_next/ignored.js">',
      '<script src="/_next/direct.js"></script>',
    ].join("");

    expect(publicScriptPaths(html)).toEqual([
      "/_next/direct.js",
      "/_next/preloaded.js",
      "/_next/module.js",
    ]);
  });

  it("finds public stylesheets without duplicates", () => {
    const html = [
      '<link rel="stylesheet" href="/_next/public.css">',
      '<link href="/_next/route.css" rel="stylesheet">',
      '<link rel="preload" as="style" href="/_next/ignored.css">',
      '<link rel="stylesheet" href="/_next/public.css">',
    ].join("");

    expect(publicStylePaths(html)).toEqual([
      "/_next/public.css",
      "/_next/route.css",
    ]);
  });
});
