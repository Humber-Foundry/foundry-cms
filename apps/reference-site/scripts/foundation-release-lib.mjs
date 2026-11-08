// Shared machinery for the foundation scaffold and sync commands.
//
// One classification, one tar reader, one lockfile check and one installation
// `package.json` builder serve both the create-only scaffold and the three-way
// sync. `release:prepare` imports `isTemplatePath`, so the framework manifest it
// records lists exactly the paths the scaffold and sync manage, and it imports
// `installationTsconfigText` to pack the installation's `tsconfig.json`.

import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

/**
 * The framework classification. A path is framework source the foundation owns
 * — copied on scaffold and reconciled on sync — when it is under one of the
 * scaffolded directories or is one of the named root config files.
 */
export function isTemplatePath(path) {
  return (
    /^(?:app|components|foundry|migrations|public|src)\//u.test(path) ||
    [
      "custom-worker.ts",
      "cloudflare-email.d.ts",
      "next-env.d.ts",
      "next.config.ts",
      "open-next.config.ts",
      "tsconfig.json",
      "wrangler.jsonc",
      "wrangler.recovery.jsonc",
    ].includes(path)
  );
}

/**
 * Parses `--key value` arguments and `--flag` booleans. Required keys must be
 * present, non-empty strings.
 */
export function parseReleaseArguments(argv, { required = [], booleans = [] } = {}) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (typeof key !== "string" || !key.startsWith("--")) {
      throw new Error("foundation_release_arguments_invalid");
    }
    const name = key.slice(2);
    if (booleans.includes(name)) {
      result[name] = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error("foundation_release_arguments_invalid");
    }
    result[name] = value;
    index += 1;
  }
  for (const name of required) {
    if (typeof result[name] !== "string" || result[name] === "") {
      throw new Error(`foundation_release_argument_missing:${name}`);
    }
  }
  return result;
}

function tarString(block, start, length) {
  const end = block.indexOf(0, start);
  return block
    .subarray(start, end === -1 || end > start + length ? start + length : end)
    .toString("utf8");
}

/**
 * Reads a gzipped npm package tarball into a map of installation-relative path
 * to bytes. Every header checksum is verified and traversal names are rejected,
 * because the tarball is verified but still parsed as hostile input.
 */
export function tarEntries(archive) {
  const source = gunzipSync(archive);
  const entries = new Map();
  for (let offset = 0; offset + 512 <= source.length; ) {
    const header = source.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const declaredChecksum = Number.parseInt(tarString(header, 148, 8).trim(), 8);
    let actualChecksum = 0;
    for (let index = 0; index < header.length; index += 1) {
      actualChecksum += index >= 148 && index < 156 ? 32 : header[index];
    }
    if (!Number.isSafeInteger(declaredChecksum) || declaredChecksum !== actualChecksum) {
      throw new Error("foundation_scaffold_tar_checksum_invalid");
    }
    const name = [tarString(header, 345, 155), tarString(header, 0, 100)]
      .filter(Boolean)
      .join("/");
    const size = Number.parseInt(tarString(header, 124, 12).trim() || "0", 8);
    const type = String.fromCharCode(header[156] ?? 0);
    if (
      !name.startsWith("package/") ||
      name.includes("../") ||
      name.includes("\\") ||
      !Number.isSafeInteger(size) ||
      size < 0
    ) {
      throw new Error("foundation_scaffold_tar_entry_invalid");
    }
    const contentStart = offset + 512;
    const contentEnd = contentStart + size;
    if (contentEnd > source.length) throw new Error("foundation_scaffold_tar_truncated");
    if (type === "\0" || type === "0") {
      entries.set(name.slice("package/".length), source.subarray(contentStart, contentEnd));
    } else if (type !== "5") {
      throw new Error("foundation_scaffold_tar_entry_type_invalid");
    }
    offset = contentStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

/**
 * Proves the installation's lockfile pins the exact release executable — same
 * version, integrity and resolved filename the descriptor names. Scaffold and
 * sync both refuse to write a foundation file until this holds. The sync runs
 * it for all four packages through `assertSyncReleaseLocked`.
 */
export function assertLockedReleaseExecutable({ descriptor, lock, name }) {
  const entry = lock.packages?.[`node_modules/${name}`];
  const artifact = descriptor.artifacts?.[name];
  if (
    entry?.version !== descriptor.version ||
    entry?.integrity !== artifact?.integrity ||
    typeof entry?.resolved !== "string" ||
    !entry.resolved.endsWith(artifact.filename)
  ) {
    throw new Error(`foundation_scaffold_executable_not_locked:${name}`);
  }
}

// The four packages of one foundation release. The operator exports the same
// list as `foundationPackageNames`. The sync checks the lock before it imports
// the operator, so that it never loads operator code that is not locked.
const foundationPackageNames = [
  "@humber-foundry/application",
  "@humber-foundry/operator",
  "@humber-foundry/reference-site",
  "@humber-foundry/site-definition",
];

/**
 * Proves the installation's lockfile pins all four release executables. The
 * sync runs this before it writes anything.
 *
 * An installation can vendor the tarballs at a fixed path and version. When a
 * newer release replaces their bytes, a plain `npm install` keeps the old
 * `integrity` in the lockfile and the old code in `node_modules`. Only an
 * `npm install` that names the tarballs reads their new bytes. When the
 * vendored tarballs at the locked paths already hold the target's bytes, the
 * lock is stale, and the error names that exact command. Any other mismatch
 * throws `foundation_scaffold_executable_not_locked`.
 */
export async function assertSyncReleaseLocked({ descriptor, lock, target }) {
  const stale = [];
  for (const name of foundationPackageNames) {
    try {
      assertLockedReleaseExecutable({ descriptor, lock, name });
    } catch (error) {
      const tarball = await staleTarballInstallArgument({ descriptor, lock, name, target });
      if (tarball === null) throw error;
      stale.push({ name, tarball });
    }
  }
  if (stale.length === 0) return;
  throw new Error(
    [
      `foundation_sync_lock_stale:${stale.map(({ name }) => name).join(",")}`,
      "package-lock.json still holds the integrity of the tarballs that the vendored files replaced.",
      "Run this command in the installation directory, then run the sync again:",
      `  npm install ${stale.map(({ tarball }) => shellWord(tarball)).join(" ")}`,
    ].join("\n"),
  );
}

/**
 * Returns the vendored tarball path, as the `npm install` argument, when the
 * lock entry names the target version and file but not its integrity, and the
 * file at that path holds exactly the target's bytes. Returns `null` otherwise.
 */
async function staleTarballInstallArgument({ descriptor, lock, name, target }) {
  const entry = lock.packages?.[`node_modules/${name}`];
  const artifact = descriptor.artifacts?.[name];
  const resolved = entry?.resolved;
  if (
    typeof artifact?.filename !== "string" ||
    entry?.version !== descriptor.version ||
    typeof resolved !== "string" ||
    !resolved.startsWith("file:") ||
    !resolved.endsWith(artifact.filename)
  ) {
    return null;
  }
  const path = resolved.slice("file:".length);
  let bytes;
  try {
    bytes = await readFile(resolve(target, path));
  } catch {
    return null;
  }
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  if (integrity !== artifact.integrity) return null;
  return isAbsolute(path) || path.startsWith(".") ? path : `./${path}`;
}

/** Quotes a word for `sh` when it holds a character outside the safe set. */
function shellWord(word) {
  return /^[\w@%+=:,./-]+$/u.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
}

/**
 * Returns every `@tiptap/*` entry of a release `dependencies` map. Tiptap
 * packages declare exact peer versions of each other, but Puck and the
 * starter kit depend on them with open ranges. So the release pins the whole
 * set at one exact version. Throws when an entry differs from the
 * `@tiptap/core` version.
 */
export function alignedTiptapPins(dependencies) {
  const pins = Object.fromEntries(
    Object.entries(dependencies).filter(([name]) => name.startsWith("@tiptap/")),
  );
  assertOneTiptapVersion(
    Object.entries(pins).map(([name, version]) => ({ name, version })),
  );
  return pins;
}

/**
 * Checks that an npm lockfile resolves every `@tiptap/*` package, at any
 * depth, to the version of its `@tiptap/core`. A tiptap package at another
 * version fails here, by name, instead of as a missing export in the build.
 * The scaffold runs this check on a new installation's first install, before
 * any overrides exist.
 */
export function assertTiptapSetAligned(lock) {
  assertOneTiptapVersion(lockedTiptapPackages(lock));
}

/**
 * Throws unless every `{ name, version }` entry has the version of the
 * `@tiptap/core` entry. The error detail is
 * `<name>@<version>:expected:<core version>`.
 */
function assertOneTiptapVersion(packages) {
  if (packages.length === 0) return;
  const expected = packages.find(({ name }) => name === "@tiptap/core")?.version;
  if (expected === undefined) throw new Error("foundation_release_tiptap_core_missing");
  for (const { name, version } of packages) {
    if (version !== expected) {
      throw new Error(
        `foundation_release_tiptap_version_drift:${name}@${version}:expected:${expected}`,
      );
    }
  }
}

/**
 * Returns the name and version of every `@tiptap/*` package in an npm
 * lockfile, at any depth.
 */
export function lockedTiptapPackages(lock) {
  return Object.entries(lock.packages ?? {}).flatMap(([path, entry]) => {
    const match = /(?:^|\/)node_modules\/(@tiptap\/[^/]+)$/u.exec(path);
    return match === null ? [] : [{ name: match[1], version: entry.version }];
  });
}

/**
 * Returns the `tsconfig.json` an installation receives. `release:prepare`
 * packs it into the reference-site tarball, so it is framework source: the
 * scaffold copies it once and the sync reconciles it three ways like any other
 * framework file.
 *
 * It already holds every setting Next.js requires or suggests, so `next build`
 * and `next dev` leave it unchanged. In particular `jsx` is `react-jsx`, which
 * also lets Vitest parse an installation's own `.tsx` tests.
 *
 * Earlier releases wrote a different `tsconfig.json`, and the first
 * `next build` rewrote it. This file is exactly that rewrite, key order
 * included. So an installation that has only that rewrite matches this file
 * byte for byte.
 */
export function installationTsconfigText() {
  return `${JSON.stringify(
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
        jsx: "react-jsx",
        paths: { "@/*": ["./*"] },
        plugins: [{ name: "next" }],
        allowJs: true,
        incremental: true,
      },
      include: [
        "next-env.d.ts",
        "**/*.ts",
        "**/*.tsx",
        ".next/types/**/*.ts",
        ".next/dev/types/**/*.ts",
      ],
      exclude: ["node_modules"],
    },
    null,
    2,
  )}\n`;
}

/**
 * Returns the installation `package.json` for the target release. Installation
 * scripts and dependencies are preserved; the foundation's build scripts,
 * engines and tiptap overrides are set to the target's. This is the one place
 * both scaffold and sync derive that file. The scaffold writes it; the sync
 * passes it to the operator, which writes and reports it only when it changes.
 */
export async function installationPackageText({
  target,
  descriptor,
  packageRoot,
}) {
  const packagePath = join(target, "package.json");
  const targetPackage = JSON.parse(await readFile(packagePath, "utf8"));
  targetPackage.private = true;
  targetPackage.type = "module";
  targetPackage.engines = { node: descriptor.compatibility.node };
  const releasePackage = JSON.parse(
    await readFile(join(packageRoot, "package.json"), "utf8"),
  );
  targetPackage.overrides = alignedTiptapPins(releasePackage.dependencies);
  targetPackage.scripts = {
    ...(targetPackage.scripts ?? {}),
    build: "next build",
    "build:operator":
      "node -e \"import('@humber-foundry/operator').then(m=>{if(typeof m.parseFoundationReleaseDescriptor!=='function')process.exit(1)})\"",
    "build:worker": "opennextjs-cloudflare build",
    "smoke:deployment":
      "npm run build:worker && wrangler deploy --dry-run --outdir .foundry/deployment-smoke",
    typecheck: "tsc --noEmit",
  };
  return `${JSON.stringify(targetPackage, null, 2)}\n`;
}
