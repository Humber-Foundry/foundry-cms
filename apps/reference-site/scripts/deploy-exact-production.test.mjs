import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { deployExactProduction } from "./deploy-exact-production.mjs";

function deploymentProcess() {
  const process = new EventEmitter();
  process.kill = vi.fn();
  return process;
}

describe("guarded exact production deployment", () => {
  it("keeps the production-head fence active through promotion", async () => {
    vi.useFakeTimers();
    const process = deploymentProcess();
    const assertHead = vi.fn();
    const deployment = deployExactProduction({
      assertHead,
      startDeployment: () => process,
      pollIntervalMs: 25,
    });

    await vi.advanceTimersByTimeAsync(75);
    process.emit("exit", 0, null);

    await expect(deployment).resolves.toBeUndefined();
    expect(assertHead.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(process.kill).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("terminates promotion when the protected ref advances", async () => {
    vi.useFakeTimers();
    const process = deploymentProcess();
    const assertHead = vi
      .fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => undefined)
      .mockImplementation(() => {
        throw new Error("exact_production_head_moved");
      });
    const deployment = deployExactProduction({
      assertHead,
      startDeployment: () => process,
      pollIntervalMs: 25,
    });

    await vi.advanceTimersByTimeAsync(25);
    expect(process.kill).toHaveBeenCalledWith("SIGTERM");
    process.emit("exit", null, "SIGTERM");

    await expect(deployment).rejects.toThrow("exact_production_head_moved");
    vi.useRealTimers();
  });
});
