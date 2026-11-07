import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  alignedTiptapPins,
  assertTiptapSetPinned,
  lockedTiptapPackages,
} from "./foundation-release-lib.mjs";

const root = resolve(import.meta.dirname, "../../..");

function readJson(path) {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

describe("tiptap pins", () => {
  it("selects every @tiptap/* dependency and nothing else", () => {
    expect(
      alignedTiptapPins({
        "@puckeditor/core": "0.22.2",
        "@tiptap/core": "3.29.1",
        "@tiptap/extension-text-align": "3.29.1",
        next: "16.2.12",
      }),
    ).toEqual({
      "@tiptap/core": "3.29.1",
      "@tiptap/extension-text-align": "3.29.1",
    });
  });

  it("rejects a tiptap set that does not share one exact version", () => {
    expect(() =>
      alignedTiptapPins({
        "@tiptap/core": "3.29.1",
        "@tiptap/extension-text-align": "^3.29.1",
      }),
    ).toThrow(
      "foundation_release_tiptap_version_drift:@tiptap/extension-text-align@^3.29.1:expected:3.29.1",
    );
  });
});

describe("installed tiptap set", () => {
  const dependencies = {
    "@tiptap/core": "3.29.1",
    "@tiptap/extension-text-align": "3.29.1",
    next: "16.2.12",
  };

  it("accepts a lockfile that resolves every tiptap package to its pin", () => {
    expect(() =>
      assertTiptapSetPinned({
        dependencies,
        lock: {
          packages: {
            "": {},
            "node_modules/@tiptap/core": { version: "3.29.1" },
            "node_modules/@puckeditor/core/node_modules/@tiptap/extension-text-align":
              { version: "3.29.1" },
            "node_modules/next": { version: "16.2.12" },
          },
        },
      }),
    ).not.toThrow();
  });

  it("names a tiptap package that a range resolved past its pin", () => {
    expect(() =>
      assertTiptapSetPinned({
        dependencies,
        lock: {
          packages: {
            "node_modules/@tiptap/core": { version: "3.29.1" },
            "node_modules/@tiptap/extension-text-align": { version: "3.33.0" },
          },
        },
      }),
    ).toThrow(
      "foundation_release_tiptap_version_drift:@tiptap/extension-text-align@3.33.0:expected:3.29.1",
    );
  });

  it("accepts an installation's own tiptap package at the shared version", () => {
    expect(() =>
      assertTiptapSetPinned({
        dependencies,
        lock: {
          packages: {
            "node_modules/@tiptap/core": { version: "3.29.1" },
            "node_modules/@tiptap/extension-color": { version: "3.29.1" },
          },
        },
      }),
    ).not.toThrow();
  });

  it("names a tiptap package that the release does not pin at another version", () => {
    expect(() =>
      assertTiptapSetPinned({
        dependencies,
        lock: {
          packages: {
            "node_modules/@tiptap/core": { version: "3.29.1" },
            "node_modules/@tiptap/extension-color": { version: "3.33.0" },
          },
        },
      }),
    ).toThrow(
      "foundation_release_tiptap_unpinned:@tiptap/extension-color@3.33.0:expected:3.29.1",
    );
  });

  it("is pinned in full by the reference site for the repository lockfile", () => {
    // The reference site's dependencies become the release artifact's
    // dependencies. A new tiptap package from a Puck or starter-kit upgrade
    // must be added there at the shared version, or a fresh installation
    // resolves it from an open range.
    const referenceManifest = readJson("apps/reference-site/package.json");
    const lock = readJson("package-lock.json");
    expect(() =>
      assertTiptapSetPinned({
        dependencies: referenceManifest.dependencies,
        lock,
      }),
    ).not.toThrow();
    const pins = alignedTiptapPins(referenceManifest.dependencies);
    expect(
      lockedTiptapPackages(lock)
        .map(({ name }) => name)
        .filter((name) => pins[name] === undefined),
    ).toEqual([]);
  });
});
