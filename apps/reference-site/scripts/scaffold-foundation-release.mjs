#!/usr/bin/env node

import { createHash, timingSafeEqual } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function argumentsFrom(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error("foundation_scaffold_arguments_invalid");
    }
    result[key.slice(2)] = value;
  }
  for (const required of ["target", "descriptor", "descriptor-digest", "artifacts"]) {
    if (typeof result[required] !== "string" || result[required] === "") {
      throw new Error(`foundation_scaffold_argument_missing:${required}`);
    }
  }
  return result;
}

function tarString(block, start, length) {
  const end = block.indexOf(0, start);
  return block.subarray(start, end === -1 || end > start + length ? start + length : end).toString("utf8");
}

function tarEntries(archive) {
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

function assertLockedReleaseExecutable({ descriptor, lock, name }) {
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

function isTemplatePath(path) {
  return (
    /^(?:app|components|migrations|public|src)\//u.test(path) ||
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

async function main() {
  const options = argumentsFrom(process.argv.slice(2));
  const target = resolve(options.target);
  const artifactDirectory = resolve(options.artifacts);
  const descriptorPath = resolve(options.descriptor);
  const descriptorSource = await readFile(descriptorPath, "utf8");
  const actualDescriptorDigest = Buffer.from(
    `sha256:${createHash("sha256").update(descriptorSource).digest("hex")}`,
  );
  const expectedDescriptorDigest = Buffer.from(options["descriptor-digest"]);
  if (
    actualDescriptorDigest.length !== expectedDescriptorDigest.length ||
    !timingSafeEqual(actualDescriptorDigest, expectedDescriptorDigest)
  ) {
    throw new Error("foundation_release_descriptor_digest_mismatch");
  }
  const untrustedDescriptor = JSON.parse(descriptorSource);
  const lock = JSON.parse(await readFile(join(target, "package-lock.json"), "utf8"));
  for (const name of ["@foundry/operator", "@foundry/reference-site"]) {
    assertLockedReleaseExecutable({ descriptor: untrustedDescriptor, lock, name });
  }
  const {
    loadFoundationReleaseDescriptor,
    verifyFoundationReleaseArtifacts,
  } = await import("@foundry/operator");
  const descriptor = await loadFoundationReleaseDescriptor({
    descriptorPath,
    expectedDigest: options["descriptor-digest"],
  });
  const artifactBytes = new Map();
  await verifyFoundationReleaseArtifacts({
    descriptor,
    readArtifact: async (filename) => {
      const bytes = await readFile(join(artifactDirectory, filename));
      artifactBytes.set(filename, bytes);
      return bytes;
    },
  });

  const referenceArtifact = descriptor.artifacts["@foundry/reference-site"];
  const entries = tarEntries(artifactBytes.get(referenceArtifact.filename));
  for (const [path, bytes] of entries) {
    if (!isTemplatePath(path)) continue;
    const destination = join(target, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes, { flag: "wx" });
  }

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
      "node -e \"import('@foundry/operator').then(m=>{if(typeof m.parseFoundationReleaseDescriptor!=='function')process.exit(1)})\"",
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
  await writeFile(
    join(target, ".foundry-foundation-release.json"),
    `${JSON.stringify(descriptor, null, 2)}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
