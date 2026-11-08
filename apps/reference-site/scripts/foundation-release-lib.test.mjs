import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  alignedTiptapPins,
  assertTiptapSetAligned,
  installationTsconfigText,
  lockedTiptapPackages,
} from "./foundation-release-lib.mjs";

const root = resolve(import.meta.dirname, "../../..");
const require = createRequire(import.meta.url);

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
  it("accepts a lockfile where every tiptap package shares the core version", () => {
    expect(() =>
      assertTiptapSetAligned({
        packages: {
          "": {},
          "node_modules/@tiptap/core": { version: "3.29.1" },
          "node_modules/@puckeditor/core/node_modules/@tiptap/extension-text-align":
            { version: "3.29.1" },
          "node_modules/next": { version: "16.2.12" },
        },
      }),
    ).not.toThrow();
  });

  it("names a tiptap package that a range resolved past the core version", () => {
    expect(() =>
      assertTiptapSetAligned({
        packages: {
          "node_modules/@tiptap/core": { version: "3.29.1" },
          "node_modules/@tiptap/extension-text-align": { version: "3.33.0" },
        },
      }),
    ).toThrow(
      "foundation_release_tiptap_version_drift:@tiptap/extension-text-align@3.33.0:expected:3.29.1",
    );
  });

  it("accepts an installation's own tiptap package at the core version", () => {
    expect(() =>
      assertTiptapSetAligned({
        packages: {
          "node_modules/@tiptap/core": { version: "3.29.1" },
          "node_modules/@tiptap/extension-color": { version: "3.29.1" },
        },
      }),
    ).not.toThrow();
  });

  it("rejects a lockfile whose tiptap packages have no core", () => {
    expect(() =>
      assertTiptapSetAligned({
        packages: {
          "node_modules/@tiptap/extension-text-align": { version: "3.33.0" },
        },
      }),
    ).toThrow("foundation_release_tiptap_core_missing");
  });

  it("is pinned in full by the reference site for the repository lockfile", () => {
    // The reference site's dependencies become the release artifact's
    // dependencies. A new tiptap package from a Puck or starter-kit upgrade
    // must be added there at the shared version, or a fresh installation
    // resolves it from an open range.
    const referenceManifest = readJson("apps/reference-site/package.json");
    const lock = readJson("package-lock.json");
    const pins = alignedTiptapPins(referenceManifest.dependencies);
    expect(
      lockedTiptapPackages(lock).filter(
        ({ name, version }) => pins[name] !== version,
      ),
    ).toEqual([]);
  });
});

// Runs the pinned Next.js tsconfig check, the one `next build` and `next dev`
// run, on `source`, and returns the file it leaves behind.
async function afterNextTypeScriptSetup(source) {
  const { writeConfigurationDefaults } = require(
    "next/dist/lib/typescript/writeConfigurationDefaults.js",
  );
  const directory = await mkdtemp(join(tmpdir(), "foundry-installation-tsconfig-"));
  try {
    const path = join(directory, "tsconfig.json");
    await writeFile(path, source);
    await writeConfigurationDefaults(
      require("typescript").version,
      path,
      false,
      true,
      ".next",
      false,
      false,
    );
    return await readFile(path, "utf8");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("installation tsconfig.json", () => {
  it("is left unchanged by the Next.js build", async () => {
    // If Next.js rewrote it, every build would turn the shipped file into a
    // local change, and the next sync would report a conflict.
    expect(await afterNextTypeScriptSetup(installationTsconfigText())).toBe(
      installationTsconfigText(),
    );
  });

  it("equals the Next.js rewrite of the tsconfig.json from earlier releases", async () => {
    // Every release before #139 wrote this file, and the first `next build`
    // rewrote it. An installation that has only that rewrite must match the
    // shipped file, so its first sync reports nothing for tsconfig.json.
    const earlierReleaseTsconfig = `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          lib: ["DOM", "DOM.Iterable", "ES2023"],
          strict: true,
          skipLibCheck: true,
          noEmit: true,
          esModuleInterop: true,
          module: "ESNext",
          moduleResolution: "Bundler",
          resolveJsonModule: true,
          isolatedModules: true,
          jsx: "preserve",
          paths: { "@/*": ["./*"] },
          plugins: [{ name: "next" }],
        },
        include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
        exclude: ["node_modules"],
      },
      null,
      2,
    )}\n`;
    expect(await afterNextTypeScriptSetup(earlierReleaseTsconfig)).toBe(
      installationTsconfigText(),
    );
  });

  it("lets Vitest run an installation's own .tsx test", async () => {
    const directory = await mkdtemp(join(tmpdir(), "foundry-installation-vitest-"));
    try {
      await symlink(join(root, "node_modules"), join(directory, "node_modules"), "dir");
      await writeFile(join(directory, "package.json"), '{ "type": "module" }\n');
      await writeFile(join(directory, "tsconfig.json"), installationTsconfigText());
      await writeFile(
        join(directory, "page.test.tsx"),
        [
          'import { renderToStaticMarkup } from "react-dom/server";',
          'import { expect, it } from "vitest";',
          "",
          'it("renders JSX", () => {',
          '  expect(renderToStaticMarkup(<p>Hello</p>)).toBe("<p>Hello</p>");',
          "});",
          "",
        ].join("\n"),
      );
      // The child must not inherit this run's Vitest worker state.
      const env = Object.fromEntries(
        Object.entries(process.env).filter(([name]) => !name.startsWith("VITEST")),
      );
      const result = spawnSync(
        process.execPath,
        [join(root, "node_modules/vitest/vitest.mjs"), "run", "--root", directory],
        { cwd: directory, encoding: "utf8", env: { ...env, NODE_ENV: "test" } },
      );
      expect(`${result.stdout}${result.stderr}`).toMatch(/Tests\s+1 passed/u);
      expect(result.status).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
