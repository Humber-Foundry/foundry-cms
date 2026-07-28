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
      return {
        retained: false,
        release: async () => {
          calls.push("unlock");
          await releaseBranchLock();
        },
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
        acquireBranchLock: vi.fn().mockResolvedValue({
          retained: false,
          release: releaseBranchLock,
        }),
        startProvision: vi.fn(() => successfulProcess()),
      }),
    ).rejects.toThrow("exact_production_head_moved");

    expect(releaseBranchLock).not.toHaveBeenCalled();
  });

  it("does not provision when a deployment already exists", async () => {
    const startProvision = vi.fn();
    const releaseBranchLock = vi.fn();
    const acquireBranchLock = vi.fn().mockResolvedValue({
      retained: false,
      release: releaseBranchLock,
    });

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
    expect(acquireBranchLock).toHaveBeenCalledOnce();
    expect(releaseBranchLock).toHaveBeenCalledOnce();
  });

  it("reconciles an existing deployment under a retained lock", async () => {
    const calls = [];
    const assertHead = vi.fn();
    const authorizeContent = vi.fn().mockImplementation(async () => {
      calls.push("authorize");
    });
    const verifyRelease = vi.fn().mockImplementation(async () => {
      calls.push("verify");
    });
    const release = vi.fn().mockImplementation(async () => {
      calls.push("unlock");
    });
    const startProvision = vi.fn();

    await provisionProductionBaseline({
      environment,
      assertHead,
      assertDeploymentAbsent: vi
        .fn()
        .mockRejectedValue(
          new Error("production_baseline_already_exists"),
        ),
      authorizeContent,
      verifyRelease,
      acquireBranchLock: vi.fn().mockResolvedValue({
        retained: true,
        release,
      }),
      startProvision,
    });

    expect(startProvision).not.toHaveBeenCalled();
    expect(assertHead).toHaveBeenCalledOnce();
    expect(calls).toEqual(["authorize", "verify", "unlock"]);
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
    const ruleset = {
      id: 42,
      name: "Foundry production baseline lock: main",
      target: "branch",
      enforcement: "active",
      bypass_actors: [],
      conditions: {
        ref_name: {
          include: ["refs/heads/main"],
          exclude: [],
        },
      },
      rules: [{
        type: "update",
        parameters: { update_allows_fetch_and_merge: false },
      }],
    };
    const fetchImplementation = vi
      .fn()
      .mockResolvedValueOnce(json([]))
      .mockResolvedValueOnce(json({ id: 42 }, 201))
      .mockResolvedValueOnce(json(ruleset))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(json({ message: "Not Found" }, 404));

    const lock = await acquireProductionBranchLock({
      environment: {
        FOUNDRY_GITHUB_OWNER: "owner",
        FOUNDRY_GITHUB_REPOSITORY: "repo",
        FOUNDRY_PRODUCTION_BRANCH: "main",
        FOUNDRY_BASELINE_PROVISION_GITHUB_TOKEN: "token",
      },
      fetchImplementation,
    });
    expect(lock.retained).toBe(false);
    await lock.release();

    expect(fetchImplementation).toHaveBeenCalledTimes(5);
    expect(fetchImplementation.mock.calls[1]?.[0]).toBe(
      "https://api.github.com/repos/owner/repo/rulesets",
    );
    expect(
      JSON.parse(fetchImplementation.mock.calls[1]?.[1]?.body),
    ).toEqual({
      name: "Foundry production baseline lock: main",
      target: "branch",
      enforcement: "active",
      bypass_actors: [],
      conditions: {
        ref_name: {
          include: ["refs/heads/main"],
          exclude: [],
        },
      },
      rules: [{
        type: "update",
        parameters: { update_allows_fetch_and_merge: false },
      }],
    });
    expect(fetchImplementation.mock.calls.map(([url, init]) => [
      url,
      init?.method,
    ])).toEqual([
      [
        "https://api.github.com/repos/owner/repo/rulesets?includes_parents=false&targets=branch&per_page=100",
        "GET",
      ],
      ["https://api.github.com/repos/owner/repo/rulesets", "POST"],
      ["https://api.github.com/repos/owner/repo/rulesets/42", "GET"],
      ["https://api.github.com/repos/owner/repo/rulesets/42", "DELETE"],
      ["https://api.github.com/repos/owner/repo/rulesets/42", "GET"],
    ]);
  });

  it("fails closed when the temporary ruleset has a bypass actor", async () => {
    const fetchImplementation = vi
      .fn()
      .mockResolvedValueOnce(json([]))
      .mockResolvedValueOnce(json({ id: 42 }, 201))
      .mockResolvedValueOnce(
        json({
          id: 42,
          name: "Foundry production baseline lock: main",
          target: "branch",
          enforcement: "active",
          bypass_actors: [{ actor_id: 1, actor_type: "OrganizationAdmin" }],
          conditions: {
            ref_name: {
              include: ["refs/heads/main"],
              exclude: [],
            },
          },
          rules: [{
            type: "update",
            parameters: { update_allows_fetch_and_merge: false },
          }],
        }),
      );

    await expect(
      acquireProductionBranchLock({
        environment: {
          FOUNDRY_GITHUB_OWNER: "owner",
          FOUNDRY_GITHUB_REPOSITORY: "repo",
          FOUNDRY_PRODUCTION_BRANCH: "main",
          FOUNDRY_BASELINE_PROVISION_GITHUB_TOKEN: "token",
        },
        fetchImplementation,
      }),
    ).rejects.toThrow("production_baseline_branch_lock_failed");

    expect(fetchImplementation).toHaveBeenCalledTimes(3);
  });

  it("fails closed when the update rule permits fetch-and-merge", async () => {
    const fetchImplementation = vi
      .fn()
      .mockResolvedValueOnce(json([]))
      .mockResolvedValueOnce(json({ id: 42 }, 201))
      .mockResolvedValueOnce(
        json({
          id: 42,
          name: "Foundry production baseline lock: main",
          target: "branch",
          enforcement: "active",
          bypass_actors: [],
          conditions: {
            ref_name: {
              include: ["refs/heads/main"],
              exclude: [],
            },
          },
          rules: [{
            type: "update",
            parameters: { update_allows_fetch_and_merge: true },
          }],
        }),
      );

    await expect(
      acquireProductionBranchLock({
        environment: {
          FOUNDRY_GITHUB_OWNER: "owner",
          FOUNDRY_GITHUB_REPOSITORY: "repo",
          FOUNDRY_PRODUCTION_BRANCH: "main",
          FOUNDRY_BASELINE_PROVISION_GITHUB_TOKEN: "token",
        },
        fetchImplementation,
      }),
    ).rejects.toThrow("production_baseline_branch_lock_failed");

    expect(fetchImplementation).toHaveBeenCalledTimes(3);
  });

  it("reuses an exact retained ruleset after an interrupted provisioning run", async () => {
    const ruleset = {
      id: 42,
      name: "Foundry production baseline lock: main",
      target: "branch",
      enforcement: "active",
      bypass_actors: [],
      conditions: {
        ref_name: {
          include: ["refs/heads/main"],
          exclude: [],
        },
      },
      rules: [{
        type: "update",
        parameters: { update_allows_fetch_and_merge: false },
      }],
    };
    const fetchImplementation = vi
      .fn()
      .mockResolvedValueOnce(
        json([{ id: 42, name: ruleset.name, target: "branch" }]),
      )
      .mockResolvedValueOnce(json(ruleset))
      .mockRejectedValueOnce(new Error("delete_response_lost"))
      .mockResolvedValueOnce(json({ message: "Not Found" }, 404));

    const lock = await acquireProductionBranchLock({
      environment: {
        FOUNDRY_GITHUB_OWNER: "owner",
        FOUNDRY_GITHUB_REPOSITORY: "repo",
        FOUNDRY_PRODUCTION_BRANCH: "main",
        FOUNDRY_BASELINE_PROVISION_GITHUB_TOKEN: "token",
      },
      fetchImplementation,
    });
    expect(lock.retained).toBe(true);
    await expect(lock.release()).resolves.toBeUndefined();

    expect(fetchImplementation.mock.calls.map(([, init]) => init?.method))
      .toEqual(["GET", "GET", "DELETE", "GET"]);
  });

  it("reports an unverified unlock when absence cannot be read back", async () => {
    const ruleset = {
      id: 42,
      name: "Foundry production baseline lock: main",
      target: "branch",
      enforcement: "active",
      bypass_actors: [],
      conditions: {
        ref_name: {
          include: ["refs/heads/main"],
          exclude: [],
        },
      },
      rules: [{
        type: "update",
        parameters: { update_allows_fetch_and_merge: false },
      }],
    };
    const fetchImplementation = vi
      .fn()
      .mockResolvedValueOnce(
        json([{ id: 42, name: ruleset.name, target: "branch" }]),
      )
      .mockResolvedValueOnce(json(ruleset))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockRejectedValueOnce(new Error("ruleset_read_failed"));

    const lock = await acquireProductionBranchLock({
      environment: {
        FOUNDRY_GITHUB_OWNER: "owner",
        FOUNDRY_GITHUB_REPOSITORY: "repo",
        FOUNDRY_PRODUCTION_BRANCH: "main",
        FOUNDRY_BASELINE_PROVISION_GITHUB_TOKEN: "token",
      },
      fetchImplementation,
    });

    await expect(lock.release()).rejects.toThrow(
      "production_baseline_branch_unlock_unverified",
    );
  });

  it("rejects a branch pattern before creating a ruleset", async () => {
    const fetchImplementation = vi.fn();

    await expect(
      acquireProductionBranchLock({
        environment: {
          FOUNDRY_GITHUB_OWNER: "owner",
          FOUNDRY_GITHUB_REPOSITORY: "repo",
          FOUNDRY_PRODUCTION_BRANCH: "release/*",
          FOUNDRY_BASELINE_PROVISION_GITHUB_TOKEN: "token",
        },
        fetchImplementation,
      }),
    ).rejects.toThrow("production_baseline_branch_lock_not_configured");

    expect(fetchImplementation).not.toHaveBeenCalled();
  });
});
