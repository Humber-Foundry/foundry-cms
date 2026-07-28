import {
  execFileSync,
} from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  assertExactProductionHead,
  assertExactProductionSource,
} from "./assert-exact-production-head.mjs";

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
        readLocalHead: () => `${commit}\n`,
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
        readLocalHead: () => `${"c".repeat(40)}\n`,
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

  it("rejects overridden build metadata that differs from the checkout", () => {
    expect(() =>
      assertExactProductionHead({
        environment: {
          WORKERS_CI_COMMIT_SHA: "d".repeat(40),
          FOUNDRY_PRODUCTION_BRANCH: "main",
        },
        readLocalHead: () => `${"c".repeat(40)}\n`,
        readRemoteHead: () =>
          `${"d".repeat(40)}\trefs/heads/main\n`,
      }),
    ).toThrow("exact_build_commit_mismatch");
  });
});

describe("exact production source deployment fence", () => {
  function initializeRepository() {
    const repository = mkdtempSync(
      join(tmpdir(), "foundry-exact-source-"),
    );
    execFileSync("git", ["init", "--quiet"], { cwd: repository });
    execFileSync(
      "git",
      ["config", "user.email", "foundry-test@example.invalid"],
      { cwd: repository },
    );
    execFileSync(
      "git",
      ["config", "user.name", "Foundry Test"],
      { cwd: repository },
    );
    writeFileSync(
      join(repository, ".gitignore"),
      ".open-next/\n",
    );
    writeFileSync(join(repository, "tracked.ts"), "export {};\n");
    execFileSync("git", ["add", "."], { cwd: repository });
    execFileSync("git", ["commit", "--quiet", "-m", "fixture"], {
      cwd: repository,
    });
    return repository;
  }

  function assertRepositorySource(repository) {
    return assertExactProductionSource({
      assertHead: vi.fn(),
      readSourceStatus: () =>
        execFileSync(
          "git",
          [
            "status",
            "--porcelain=v1",
            "--untracked-files=all",
            "--ignore-submodules=none",
          ],
          { cwd: repository, encoding: "utf8" },
        ),
    });
  }

  it.each([
    { location: "worktree", stage: false },
    { location: "index", stage: true },
  ])(
    "rejects tracked $location changes before checking the head",
    ({ stage }) => {
      const repository = initializeRepository();
      writeFileSync(
        join(repository, "tracked.ts"),
        "export const dirty = true;\n",
      );
      if (stage) {
        execFileSync("git", ["add", "tracked.ts"], {
          cwd: repository,
        });
      }
      const assertHead = vi.fn();

      expect(() =>
        assertExactProductionSource({
          assertHead,
          readSourceStatus: () =>
            execFileSync(
              "git",
              [
                "status",
                "--porcelain=v1",
                "--untracked-files=all",
                "--ignore-submodules=none",
              ],
              { cwd: repository, encoding: "utf8" },
            ),
        }),
      ).toThrow("exact_build_source_dirty");
      expect(assertHead).not.toHaveBeenCalled();
    },
  );

  it("rejects untracked source inputs", () => {
    const repository = initializeRepository();
    writeFileSync(
      join(repository, "untracked-source.ts"),
      "export const untracked = true;\n",
    );

    expect(() => assertRepositorySource(repository)).toThrow(
      "exact_build_source_dirty",
    );
  });

  it("allows ignored generated build output", () => {
    const repository = initializeRepository();
    mkdirSync(join(repository, ".open-next"));
    writeFileSync(
      join(repository, ".open-next", "worker.js"),
      "generated\n",
    );

    expect(() => assertRepositorySource(repository)).not.toThrow();
  });

  it("runs the clean-source preflight before both production builds", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    const preflight =
      "node scripts/assert-exact-production-head.mjs";

    for (const scriptName of [
      "deploy",
      "provision:deployment-baseline",
    ]) {
      const script = packageJson.scripts[scriptName];
      expect(script.indexOf(preflight)).toBe(0);
      expect(script.indexOf(preflight)).toBeLessThan(
        script.indexOf("opennextjs-cloudflare build"),
      );
    }
  });
});
