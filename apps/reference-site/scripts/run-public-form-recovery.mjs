import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const temporaryDirectory = await mkdtemp(
  join(tmpdir(), "foundry-form-recovery-command-"),
);

try {
  const output = join(temporaryDirectory, "operator.mjs");
  const wranglerExecutable = fileURLToPath(
    new URL("../../../node_modules/.bin/wrangler", import.meta.url),
  );
  await access(wranglerExecutable);
  process.env.FOUNDRY_FORM_RECOVERY_WRANGLER_EXECUTABLE =
    wranglerExecutable;
  await build({
    entryPoints: [
      fileURLToPath(
        new URL("./restore-public-form-backup.ts", import.meta.url),
      ),
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
