import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { build } from "esbuild";

const temporaryDirectory = await mkdtemp(
  join(tmpdir(), "foundry-form-recovery-command-"),
);

try {
  const output = join(temporaryDirectory, "operator.mjs");
  await build({
    entryPoints: [
      new URL("./restore-public-form-backup.ts", import.meta.url).pathname,
    ],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: output,
    sourcemap: false,
  });
  await import(output);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
