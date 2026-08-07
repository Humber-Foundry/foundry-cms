#!/usr/bin/env node

import { cp, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadFoundationReleaseDescriptor,
  verifyFoundationReleaseArtifacts,
} from "@foundry/operator";

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

async function copyTemplate(source, target) {
  await cp(source, target, {
    recursive: true,
    errorOnExist: true,
    force: false,
    filter: (path) => {
      const relative = path.slice(source.length);
      return (
        !/(?:^|\/)(?:\.next|\.open-next|\.wrangler)(?:\/|$)/u.test(relative) &&
        !/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(relative) &&
        !relative.includes("/__snapshots__/")
      );
    },
  });
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2));
  const target = resolve(options.target);
  const artifactDirectory = resolve(options.artifacts);
  const descriptor = await loadFoundationReleaseDescriptor({
    descriptorPath: resolve(options.descriptor),
    expectedDigest: options["descriptor-digest"],
  });
  await verifyFoundationReleaseArtifacts({
    descriptor,
    readArtifact: (filename) => readFile(join(artifactDirectory, filename)),
  });

  for (const entry of ["app", "components", "migrations", "public", "src"]) {
    await copyTemplate(join(packageRoot, entry), join(target, entry));
  }
  for (const entry of [
    "custom-worker.ts",
    "cloudflare-email.d.ts",
    "next-env.d.ts",
    "next.config.ts",
    "open-next.config.ts",
    "wrangler.jsonc",
    "wrangler.recovery.jsonc",
  ]) {
    await cp(join(packageRoot, entry), join(target, entry), {
      errorOnExist: true,
      force: false,
    });
  }

  const packagePath = join(target, "package.json");
  const targetPackage = JSON.parse(await readFile(packagePath, "utf8"));
  targetPackage.private = true;
  targetPackage.type = "module";
  targetPackage.engines = { node: descriptor.compatibility.node };
  targetPackage.overrides = {
    "@tiptap/core": "3.29.1",
    "@tiptap/extension-bubble-menu": "3.29.1",
    "@tiptap/extension-floating-menu": "3.29.1",
    "@tiptap/pm": "3.29.1",
  };
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
