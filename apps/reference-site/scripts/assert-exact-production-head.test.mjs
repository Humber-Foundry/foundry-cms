import { describe, expect, it, vi } from "vitest";

import { assertExactProductionHead } from "./assert-exact-production-head.mjs";

describe("exact production head deployment fence", () => {
  it("allows promotion only while the protected ref equals the build commit", () => {
    const commit = "c".repeat(40);
    const readRemoteHead = vi
      .fn()
      .mockReturnValue(`${commit}\trefs/heads/main\n`);

    expect(() =>
      assertExactProductionHead({
        environment: {
          WORKERS_CI_COMMIT_SHA: commit,
          FOUNDRY_PRODUCTION_BRANCH: "main",
        },
        readRemoteHead,
      }),
    ).not.toThrow();
    expect(readRemoteHead).toHaveBeenCalledWith("refs/heads/main");
  });

  it("aborts promotion when the protected ref advances during the build", () => {
    expect(() =>
      assertExactProductionHead({
        environment: {
          WORKERS_CI_COMMIT_SHA: "c".repeat(40),
          FOUNDRY_PRODUCTION_BRANCH: "main",
        },
        readRemoteHead: () => `${"d".repeat(40)}\trefs/heads/main\n`,
      }),
    ).toThrow("exact_production_head_moved");
  });

  it("fails closed when the exact build metadata is absent", () => {
    expect(() =>
      assertExactProductionHead({
        environment: { FOUNDRY_PRODUCTION_BRANCH: "main" },
        readRemoteHead: () => "",
      }),
    ).toThrow("exact_production_head_configuration_invalid");
  });
});
