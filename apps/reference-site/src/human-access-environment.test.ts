import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { loadHumanAccessEnvironment } from "./human-access-environment";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("development human access environment", () => {
  it("defaults mutations to localhost port 3000", async () => {
    vi.stubEnv("NODE_ENV", "development");
    delete process.env.FOUNDRY_PRIVATE_PREVIEW_ORIGIN;

    await expect(loadHumanAccessEnvironment()).resolves.toMatchObject({
      FOUNDRY_CANONICAL_ORIGIN: "http://localhost:3000",
    });
  });

  it("accepts one explicit private-preview origin", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv(
      "FOUNDRY_PRIVATE_PREVIEW_ORIGIN",
      "https://private-preview.example.test:8484",
    );

    await expect(loadHumanAccessEnvironment()).resolves.toMatchObject({
      FOUNDRY_CANONICAL_ORIGIN: "https://private-preview.example.test:8484",
    });
  });

  it.each([
    "private-preview.example.test",
    "https://private-preview.example.test/path",
    "https://user:pass@private-preview.example.test",
    "javascript:alert(1)",
  ])("fails closed for malformed private-preview origin %s", async (origin) => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("FOUNDRY_PRIVATE_PREVIEW_ORIGIN", origin);

    await expect(loadHumanAccessEnvironment()).rejects.toThrow(
      "private_preview_origin_invalid",
    );
  });
});
