// Shared machinery for the foundation scaffold and sync commands.
//
// One classification, one tar reader, one lockfile check and one installation
// manifest writer serve both the create-only scaffold and the three-way sync,
// and `isTemplatePath` is also imported by `release:prepare` so the framework
// manifest it records lists exactly the paths the scaffold and sync manage.

import { gunzipSync } from "node:zlib";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

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
 * sync both refuse to write a foundation file until this holds.
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

/**
 * Writes the installation `package.json` and `tsconfig.json` from the target
 * release. Installation scripts are preserved; the foundation's build, engines,
 * tiptap overrides and TypeScript project are set to the target's. This is the
 * one place both scaffold and sync derive those files.
 */
export async function writeInstallationBuildConfiguration({
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
  targetPackage.overrides = Object.fromEntries(
    Object.entries(releasePackage.dependencies).filter(([name]) =>
      /^@tiptap\/(?:core|pm|extension-(?:bubble|floating)-menu)$/u.test(name),
    ),
  );
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
  await writeFile(packagePath, `${JSON.stringify(targetPackage, null, 2)}\n`);
  await writeFile(
    join(target, "tsconfig.json"),
    `${JSON.stringify(
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
    )}\n`,
  );
}
