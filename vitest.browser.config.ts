import { playwright } from "@vitest/browser-playwright";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  optimizeDeps: {
    include: [
      "@puckeditor/core",
      "react",
      "react-dom",
      "react/jsx-dev-runtime",
    ],
  },
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
    include: ["**/*.browser.test.tsx"],
    setupFiles: ["./apps/reference-site/src/test-support/browser-test-setup.ts"],
    // The setup file's after hook must run after each file's own hooks.
    sequence: { hooks: "stack" },
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
    },
  },
});
