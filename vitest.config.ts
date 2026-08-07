import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./apps/reference-site", import.meta.url)),
    },
  },
  oxc: {
    jsx: {
      runtime: "automatic",
    },
  },
  test: {
    // Integration suites launch workerd and Git subprocesses. Run one test
    // file at a time so a larger host cannot turn resource contention into a
    // different test result.
    maxWorkers: 1,
    include: [
      "packages/**/*.test.ts",
      "apps/**/*.test.ts",
      "apps/**/*.test.tsx",
      "apps/**/*.test.mjs",
      "scripts/**/*.test.mjs",
    ],
    exclude: ["**/*.browser.test.tsx"],
  },
});
