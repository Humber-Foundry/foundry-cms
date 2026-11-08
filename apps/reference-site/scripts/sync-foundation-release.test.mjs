// End-to-end tests of the `foundry-reference-site-sync` command.
//
// Each test builds a small synthetic foundation release (a real reference-site
// tarball, a descriptor and its digest) and an installation pinned to an older
// release. Then it runs the shipped sync script in a child process, the same
// way an operator runs the bin. The operator package is bundled the same way
// `release:prepare` bundles it, so the script resolves `@humber-foundry/operator`
// as it does in an installation.

import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isTemplatePath } from "./foundation-release-lib.mjs";
import {
  changedPaths,
  installationFileHashes as snapshot,
  reportedChanges,
} from "./installation-file-changes.mjs";

const root = resolve(import.meta.dirname, "../../..");
const packageNames = [
  "@humber-foundry/application",
  "@humber-foundry/operator",
  "@humber-foundry/reference-site",
  "@humber-foundry/site-definition",
];

let work;
let syncScript;
let caseNumber = 0;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function tarHeader(name, size) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
  header.write("00000000000\0", 136);
  header.fill(32, 148, 156);
  header.write("0", 156);
  header.write("ustar\0", 257);
  header.write("00", 263);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148);
  return header;
}

/** Packs `files` (path to text) as an npm tarball under `package/`. */
function packTarball(files) {
  const blocks = [];
  for (const [path, text] of files) {
    const bytes = Buffer.from(text);
    blocks.push(tarHeader(`package/${path}`, bytes.byteLength), bytes);
    const padding = (512 - (bytes.byteLength % 512)) % 512;
    blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

/**
 * Writes one release to `directory`. `files` is the reference-site tarball
 * content; its framework manifest is derived through the shared
 * `isTemplatePath`, exactly as `release:prepare` derives it.
 */
async function writeRelease(directory, { version, files }) {
  const artifactDirectory = join(directory, "artifacts");
  await mkdir(artifactDirectory, { recursive: true });
  const artifacts = {};
  for (const name of packageNames) {
    const bytes =
      name === "@humber-foundry/reference-site"
        ? packTarball(files)
        : Buffer.from(`artifact:${name}:${version}`);
    const filename = `${name.slice(1).replace("/", "-")}-${version}.tgz`;
    await writeFile(join(artifactDirectory, filename), bytes);
    artifacts[name] = {
      name,
      version,
      filename,
      size: bytes.byteLength,
      integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
      sha256: sha256(bytes),
    };
  }
  const frameworkFiles = [...files]
    .filter(([path]) => isTemplatePath(path))
    .map(([path, text]) => ({ path, sha256: sha256(text) }))
    .sort((left, right) => (left.path < right.path ? -1 : 1));
  const revision = sha256(version).slice(0, 40);
  const descriptor = {
    schemaVersion: "foundry.foundation-release/v1",
    version,
    source: { repository: "https://github.com/Humber-Foundry/foundry-cms", revision },
    compatibility: { node: ">=22.19.0", npm: ">=11.12.1", packageManager: "npm@11.12.1" },
    migrations: {
      latest: "0001",
      files: [
        {
          path: "apps/reference-site/migrations/0001_init.sql",
          sha256: sha256(files.get("migrations/0001_init.sql")),
        },
      ],
    },
    framework: { files: frameworkFiles },
    artifacts,
    provenance: {
      builderWorkflow:
        "https://github.com/Humber-Foundry/foundry-cms/actions/workflows/foundation-release.yml",
      sourceRevision: revision,
      subjects: packageNames.map((name) => ({ name, sha256: artifacts[name].sha256 })),
    },
  };
  const source = `${JSON.stringify(descriptor, null, 2)}\n`;
  const descriptorPath = join(directory, "foundation-release.json");
  await writeFile(descriptorPath, source);
  return {
    descriptor,
    source,
    descriptorPath,
    artifactDirectory,
    digest: `sha256:${sha256(source)}`,
  };
}

/**
 * Lays out an installation pinned to `oldRelease` whose lockfile already names
 * `targetRelease`, as it is after the operator vendors the target packages.
 * `files` overrides or adds installation files after the old release's
 * framework files are copied in.
 */
async function writeInstallation(directory, { oldFiles, oldRelease, targetRelease, files }) {
  for (const [path, text] of oldFiles) {
    if (!isTemplatePath(path)) continue;
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(join(directory, path), text);
  }
  await writeFile(
    join(directory, "package.json"),
    `${JSON.stringify(
      {
        name: "installation",
        version: "0.0.0",
        private: true,
        type: "module",
        scripts: { test: "vitest run" },
        dependencies: {},
      },
      null,
      2,
    )}\n`,
  );
  const lockPackages = {};
  for (const name of ["@humber-foundry/operator", "@humber-foundry/reference-site"]) {
    const artifact = targetRelease.descriptor.artifacts[name];
    lockPackages[`node_modules/${name}`] = {
      version: targetRelease.descriptor.version,
      resolved: `file:vendor/${artifact.filename}`,
      integrity: artifact.integrity,
    };
  }
  await writeFile(
    join(directory, "package-lock.json"),
    `${JSON.stringify({ lockfileVersion: 3, packages: lockPackages }, null, 2)}\n`,
  );
  await writeFile(join(directory, ".foundry-foundation-release.json"), oldRelease.source);
  for (const [path, text] of files ?? []) {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(join(directory, path), text);
  }
}

function runSync(installation, release, { acceptConflicts = false } = {}) {
  const result = spawnSync(
    process.execPath,
    [
      syncScript,
      "--target",
      installation,
      "--descriptor",
      release.descriptorPath,
      "--descriptor-digest",
      release.digest,
      "--artifacts",
      release.artifactDirectory,
      ...(acceptConflicts ? ["--accept-conflicts"] : []),
    ],
    { encoding: "utf8" },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * Builds a fresh case: an old release, a target release and an installation
 * pinned to the old one. `oldFiles` and `targetFiles` add to a shared base of
 * framework files.
 */
async function syncCase({ oldFiles = [], targetFiles = [], installationFiles = [] }) {
  caseNumber += 1;
  const directory = join(work, `case-${caseNumber}`);
  const base = [
    ["app/page.tsx", "export default function Page() { return null; }\n"],
    ["migrations/0001_init.sql", "CREATE TABLE example (id TEXT);\n"],
    ["next.config.ts", "export default {};\n"],
  ];
  const oldContent = new Map([...base, ...oldFiles]);
  const targetContent = new Map([...base, ...targetFiles]);
  const oldRelease = await writeRelease(join(directory, "old"), {
    version: "0.1.0",
    files: oldContent,
  });
  const targetRelease = await writeRelease(join(directory, "target"), {
    version: "0.2.0",
    files: targetContent,
  });
  const installation = join(directory, "installation");
  await mkdir(installation, { recursive: true });
  await writeInstallation(installation, {
    oldFiles: oldContent,
    oldRelease,
    targetRelease,
    files: installationFiles,
  });
  return { installation, targetRelease };
}

const shippedTsconfig = `${JSON.stringify(
  { compilerOptions: { jsx: "react-jsx", strict: true }, include: ["**/*.ts"] },
  null,
  2,
)}\n`;
const changedShippedTsconfig = `${JSON.stringify(
  { compilerOptions: { jsx: "react-jsx", strict: true }, include: ["**/*.ts", "**/*.tsx"] },
  null,
  2,
)}\n`;
// The installation's own TypeScript settings, as in issue #139.
const installationTsconfig = `${JSON.stringify(
  {
    compilerOptions: { jsx: "react-jsx", allowJs: true, incremental: true },
    include: ["**/*.ts", "**/*.tsx", ".next/dev/types/**/*.ts"],
  },
  null,
  2,
)}\n`;

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "foundry-sync-command-"));
  const installed = join(work, "packages/node_modules/@humber-foundry");
  const operator = join(installed, "operator");
  await build({
    entryPoints: [join(root, "packages/operator/src/index.ts")],
    outfile: join(operator, "dist/index.js"),
    bundle: true,
    format: "esm",
    platform: "node",
    target: "es2022",
    logLevel: "silent",
  });
  await writeFile(
    join(operator, "package.json"),
    JSON.stringify({
      name: "@humber-foundry/operator",
      type: "module",
      exports: { ".": "./dist/index.js" },
    }),
  );
  const referenceSite = join(installed, "reference-site");
  await mkdir(join(referenceSite, "scripts"), { recursive: true });
  await cp(join(root, "apps/reference-site/package.json"), join(referenceSite, "package.json"));
  for (const name of ["foundation-release-lib.mjs", "sync-foundation-release.mjs"]) {
    await cp(join(root, "apps/reference-site/scripts", name), join(referenceSite, "scripts", name));
  }
  syncScript = join(referenceSite, "scripts/sync-foundation-release.mjs");
}, 60_000);

afterAll(async () => {
  if (work !== undefined) await rm(work, { recursive: true, force: true });
});

describe("foundry-reference-site-sync and tsconfig.json", () => {
  it("keeps an installation's own tsconfig.json and reports it as a conflict", async () => {
    // The old release predates tsconfig.json as a framework file, so the
    // installation's tsconfig.json cannot be told apart from a local change.
    const { installation, targetRelease } = await syncCase({
      targetFiles: [["tsconfig.json", shippedTsconfig]],
      installationFiles: [["tsconfig.json", installationTsconfig]],
    });

    const result = runSync(installation, targetRelease, { acceptConflicts: true });

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(await readFile(join(installation, "tsconfig.json"), "utf8")).toBe(
      installationTsconfig,
    );
    expect(result.stdout).toMatch(/^conflict tsconfig\.json/mu);
  });

  it("fails closed on a tsconfig.json conflict the operator has not accepted", async () => {
    const { installation, targetRelease } = await syncCase({
      targetFiles: [["tsconfig.json", shippedTsconfig]],
      installationFiles: [["tsconfig.json", installationTsconfig]],
    });
    const before = await snapshot(installation);

    const result = runSync(installation, targetRelease);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("foundation_sync_conflicts_unresolved");
    expect(changedPaths(before, await snapshot(installation))).toEqual([]);
  });

  it("keeps a local tsconfig.json override the target release did not change", async () => {
    const { installation, targetRelease } = await syncCase({
      oldFiles: [["tsconfig.json", shippedTsconfig]],
      targetFiles: [["tsconfig.json", shippedTsconfig]],
      installationFiles: [["tsconfig.json", installationTsconfig]],
    });

    const result = runSync(installation, targetRelease);

    expect(result.status).toBe(0);
    expect(await readFile(join(installation, "tsconfig.json"), "utf8")).toBe(
      installationTsconfig,
    );
    expect(result.stdout).toMatch(/^keep\s+tsconfig\.json \(local override/mu);
  });

  it("updates an unchanged tsconfig.json to the target release's and reports it", async () => {
    const { installation, targetRelease } = await syncCase({
      oldFiles: [["tsconfig.json", shippedTsconfig]],
      targetFiles: [["tsconfig.json", changedShippedTsconfig]],
    });

    const result = runSync(installation, targetRelease);

    expect(result.status).toBe(0);
    expect(await readFile(join(installation, "tsconfig.json"), "utf8")).toBe(
      changedShippedTsconfig,
    );
    expect(result.stdout).toMatch(/^write\s+tsconfig\.json/mu);
  });

  it("leaves a tsconfig.json that already matches the target release alone", async () => {
    const { installation, targetRelease } = await syncCase({
      targetFiles: [["tsconfig.json", shippedTsconfig]],
      installationFiles: [["tsconfig.json", shippedTsconfig]],
    });

    const result = runSync(installation, targetRelease);

    expect(result.status).toBe(0);
    expect(await readFile(join(installation, "tsconfig.json"), "utf8")).toBe(shippedTsconfig);
    expect(result.stdout).not.toContain("tsconfig.json");
  });
});

describe("foundry-reference-site-sync report", () => {
  it("names every file the sync changes and counts each one as written or removed", async () => {
    const { installation, targetRelease } = await syncCase({
      oldFiles: [
        ["src/removed.ts", "export const removed = true;\n"],
        ["tsconfig.json", shippedTsconfig],
      ],
      targetFiles: [
        ["app/page.tsx", "export default function Page() { return 1; }\n"],
        ["src/added.ts", "export const added = true;\n"],
        ["tsconfig.json", changedShippedTsconfig],
      ],
    });
    const before = await snapshot(installation);

    const result = runSync(installation, targetRelease);

    expect(result.status).toBe(0);
    const changed = changedPaths(before, await snapshot(installation));
    expect(changed.length).toBeGreaterThan(0);
    expect(reportedChanges(result.stdout)).toEqual(changed);
    const summary = /^(\d+) written, (\d+) removed,/mu.exec(result.stdout);
    expect(summary).not.toBeNull();
    expect(Number(summary[1]) + Number(summary[2])).toBe(changed.length);
  });

  it("reports a sync that changes nothing as nothing written", async () => {
    const { installation, targetRelease } = await syncCase({
      oldFiles: [["tsconfig.json", shippedTsconfig]],
      targetFiles: [["tsconfig.json", shippedTsconfig]],
    });
    // A first sync advances the pin and writes the build configuration.
    expect(runSync(installation, targetRelease).status).toBe(0);
    const before = await snapshot(installation);

    const result = runSync(installation, targetRelease);

    expect(result.status).toBe(0);
    expect(changedPaths(before, await snapshot(installation))).toEqual([]);
    expect(result.stdout).toMatch(/^0 written, 0 removed,/mu);
  });
});
