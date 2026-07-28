import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { provisionProductionBaseline } from "./provision-production-baseline.mjs";

const commitSha = "c".repeat(40);
const environment = {
  WORKERS_CI_COMMIT_SHA: commitSha,
  FOUNDRY_BASELINE_PROVISION_COMMIT_SHA: commitSha,
  FOUNDRY_CLOUDFLARE_ACCOUNT_ID: "account",
  FOUNDRY_CLOUDFLARE_SCRIPT_TAG: "site",
};

function successfulProcess() {
  const process = new EventEmitter();
  queueMicrotask(() => process.emit("exit", 0, null));
  return process;
}

describe("production deployment baseline provisioning", () => {
  it("requires an exact operator-authorized commit and verifies it live", async () => {
    const assertHead = vi.fn();
    const verifyRelease = vi.fn().mockResolvedValue(undefined);
    const startProvision = vi.fn(() => successfulProcess());

    await provisionProductionBaseline({
      environment,
      assertHead,
      verifyRelease,
      startProvision,
    });

    expect(assertHead).toHaveBeenCalledTimes(2);
    expect(startProvision).toHaveBeenCalledWith({
      accountId: "account",
      expectedCommit: commitSha,
      scriptTag: "site",
    });
    expect(verifyRelease).toHaveBeenCalledOnce();
  });

  it("does not provision without an exact one-time authorization", async () => {
    const startProvision = vi.fn();

    await expect(
      provisionProductionBaseline({
        environment: {
          ...environment,
          FOUNDRY_BASELINE_PROVISION_COMMIT_SHA: "d".repeat(40),
        },
        startProvision,
      }),
    ).rejects.toThrow("production_baseline_provision_not_authorized");
    expect(startProvision).not.toHaveBeenCalled();
  });
});
