import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  acquireProductionBranchLock,
  provisionProductionBaseline,
} from "./provision-production-baseline.mjs";

const commitSha = "c".repeat(40);
const environment = {
  WORKERS_CI_COMMIT_SHA: commitSha,
  FOUNDRY_BASELINE_PROVISION_COMMIT_SHA: commitSha,
  FOUNDRY_CLOUDFLARE_ACCOUNT_ID: "account",
  FOUNDRY_CLOUDFLARE_SCRIPT_NAME: "site",
};

function successfulProcess() {
  const process = new EventEmitter();
  queueMicrotask(() => process.emit("exit", 0, null));
  return process;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("production deployment baseline provisioning", () => {
  it("holds a branch lock across first-only provisioning and exact verification", async () => {
    const calls = [];
    const assertHead = vi.fn();
    const assertDeploymentAbsent = vi.fn().mockResolvedValue(undefined);
    const authorizeContent = vi.fn().mockResolvedValue(undefined);
    const verifyRelease = vi.fn().mockResolvedValue(undefined);
    const releaseBranchLock = vi.fn().mockResolvedValue(undefined);
    const acquireBranchLock = vi.fn().mockImplementation(async () => {
      calls.push("lock");
      return async () => {
        calls.push("unlock");
        await releaseBranchLock();
      };
    });
    const startProvision = vi.fn(() => {
      calls.push("deploy");
      return successfulProcess();
    });

    await provisionProductionBaseline({
      environment,
      assertHead,
      assertDeploymentAbsent,
      authorizeContent,
      verifyRelease,
      acquireBranchLock,
      startProvision,
    });

    expect(assertHead).toHaveBeenCalledTimes(3);
    expect(assertDeploymentAbsent).toHaveBeenCalledTimes(2);
    expect(startProvision).toHaveBeenCalledWith({
      accountId: "account",
      expectedCommit: commitSha,
      scriptName: "site",
    });
    expect(authorizeContent).toHaveBeenCalledOnce();
    expect(verifyRelease).toHaveBeenCalledOnce();
    expect(calls).toEqual(["lock", "deploy", "unlock"]);
    expect(releaseBranchLock).toHaveBeenCalledOnce();
  });

  it("keeps the branch locked when the head changes during provisioning", async () => {
    const releaseBranchLock = vi.fn();
    let headReads = 0;

    await expect(
      provisionProductionBaseline({
        environment,
        assertHead: vi.fn(() => {
          headReads += 1;
          if (headReads === 3) {
            throw new Error("exact_production_head_moved");
          }
        }),
        assertDeploymentAbsent: vi.fn().mockResolvedValue(undefined),
        acquireBranchLock: vi.fn().mockResolvedValue(releaseBranchLock),
        startProvision: vi.fn(() => successfulProcess()),
      }),
    ).rejects.toThrow("exact_production_head_moved");

    expect(releaseBranchLock).not.toHaveBeenCalled();
  });

  it("does not provision when a deployment already exists", async () => {
    const startProvision = vi.fn();
    const acquireBranchLock = vi.fn();

    await expect(
      provisionProductionBaseline({
        environment,
        assertHead: vi.fn(),
        assertDeploymentAbsent: vi
          .fn()
          .mockRejectedValue(
            new Error("production_baseline_already_exists"),
          ),
        acquireBranchLock,
        startProvision,
      }),
    ).rejects.toThrow("production_baseline_already_exists");

    expect(startProvision).not.toHaveBeenCalled();
    expect(acquireBranchLock).not.toHaveBeenCalled();
  });

  it("does not provision without an exact one-time authorization", async () => {
    const acquireBranchLock = vi.fn();

    await expect(
      provisionProductionBaseline({
        environment: {
          ...environment,
          FOUNDRY_BASELINE_PROVISION_COMMIT_SHA: "d".repeat(40),
        },
        acquireBranchLock,
      }),
    ).rejects.toThrow("production_baseline_provision_not_authorized");
    expect(acquireBranchLock).not.toHaveBeenCalled();
  });

  it("acquires, verifies, and releases the GitHub branch lock", async () => {
    const fetchImplementation = vi
      .fn()
      .mockResolvedValueOnce(json({ lock_branch: { enabled: false } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(json({ lock_branch: { enabled: true } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(json({ lock_branch: { enabled: false } }));

    const release = await acquireProductionBranchLock({
      environment: {
        FOUNDRY_GITHUB_OWNER: "owner",
        FOUNDRY_GITHUB_REPOSITORY: "repo",
        FOUNDRY_PRODUCTION_BRANCH: "main",
        FOUNDRY_BASELINE_PROVISION_GITHUB_TOKEN: "token",
      },
      fetchImplementation,
    });
    await release();

    expect(fetchImplementation).toHaveBeenCalledTimes(5);
    expect(fetchImplementation.mock.calls[1]?.[0]).toBe(
      "https://api.github.com/repos/owner/repo/branches/main/lock",
    );
    expect(fetchImplementation.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({ method: "PUT" }),
    );
    expect(fetchImplementation.mock.calls[3]?.[1]).toEqual(
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});
