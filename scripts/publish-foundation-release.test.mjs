import { spawnSync } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertProtectedEnvironment,
  assertPublicationAuthentication,
  isAbsentGitHubRelease,
  publishRegistryArtifacts,
  reconcileGitHubRelease,
} from "./publish-foundation-release.mjs";

describe("foundation release publication boundary", () => {
  it("refuses an untracked source that could enter a public artifact", async () => {
    const source = resolve(
      import.meta.dirname,
      "../packages/operator/src/untracked-release-source.ts",
    );
    await writeFile(source, "export const untrackedReleaseSource = true;\n");
    try {
      const preparation = spawnSync(
        process.execPath,
        [resolve(import.meta.dirname, "prepare-foundation-release.mjs")],
        { encoding: "utf8" },
      );
      expect(preparation.status).toBe(1);
      expect(preparation.stderr).toContain(
        "foundation_release_requires_clean_source_commit",
      );
    } finally {
      await rm(source);
    }
  });

  it("packs the MIT notice into every public artifact", async () => {
    const preparation = spawnSync(
      process.execPath,
      [resolve(import.meta.dirname, "prepare-foundation-release.mjs"), "--allow-dirty"],
      { encoding: "utf8" },
    );
    expect(preparation.status).toBe(0);
    const descriptor = JSON.parse(
      await readFile(
        resolve(import.meta.dirname, "../foundation-release/foundation-release.json"),
        "utf8",
      ),
    );
    expect(Object.keys(descriptor.artifacts)).toHaveLength(4);
    for (const { filename } of Object.values(descriptor.artifacts)) {
      const archive = resolve(
        import.meta.dirname,
        "../foundation-release/artifacts",
        filename,
      );
      const entries = spawnSync("tar", ["-tzf", archive], {
        encoding: "utf8",
      });
      expect(entries.status).toBe(0);
      expect(entries.stdout.split("\n")).toContain("package/LICENSE");
      const manifest = spawnSync(
        "tar",
        ["-xOzf", archive, "package/package.json"],
        { encoding: "utf8" },
      );
      expect(manifest.status).toBe(0);
      expect(JSON.parse(manifest.stdout).license).toBe("MIT");
    }
  });

  it("keeps source workspaces unpublishable outside staging", async () => {
    for (const path of [
      "../packages/application/package.json",
      "../packages/operator/package.json",
      "../packages/site-definition/package.json",
      "../apps/reference-site/package.json",
    ]) {
      const manifest = JSON.parse(
        await readFile(resolve(import.meta.dirname, path), "utf8"),
      );
      expect(manifest.private).toBe(true);
      expect(manifest.publishConfig).toBeUndefined();
    }
  });

  it("cannot publish outside the approved protected workflow", () => {
    const env = { ...process.env };
    delete env.GITHUB_ACTIONS;
    delete env.FOUNDRY_RELEASE_APPROVED;
    const result = spawnSync(
      process.execPath,
      [resolve(import.meta.dirname, "publish-foundation-release.mjs")],
      { encoding: "utf8", env },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("foundation_release_publication_not_approved");
    expect(result.stdout).toBe("");
  });

  it("requires a real reviewer gate and prevents self-review", () => {
    expect(() =>
      assertProtectedEnvironment({
        name: "foundation-release",
        can_admins_bypass: false,
        protection_rules: [
          {
            type: "required_reviewers",
            prevent_self_review: true,
            reviewers: [{ type: "User" }],
          },
        ],
      }),
    ).not.toThrow();
    expect(() =>
      assertProtectedEnvironment({
        name: "foundation-release",
        can_admins_bypass: true,
        protection_rules: [],
      }),
    ).toThrow(/foundation_release_environment_not_protected/u);
  });

  it("allows a token only for first package registration", async () => {
    const artifacts = [
      { name: "@humber-foundry/application" },
      { name: "@humber-foundry/operator" },
    ];
    await expect(
      assertPublicationAuthentication({
        artifacts,
        mode: "bootstrap",
        bootstrapToken: "short-lived",
        packageExists: async (artifact) =>
          artifact.name === "@humber-foundry/application",
      }),
    ).resolves.toBeUndefined();
    await expect(
      assertPublicationAuthentication({
        artifacts,
        mode: "bootstrap",
        bootstrapToken: "short-lived",
        packageExists: async () => true,
      }),
    ).rejects.toThrow(/foundation_release_bootstrap_not_permitted/u);
    await expect(
      assertPublicationAuthentication({
        artifacts,
        mode: "trusted",
        bootstrapToken: "",
        packageExists: async () => false,
      }),
    ).rejects.toThrow(/foundation_release_trusted_publisher_unavailable/u);
    await expect(
      assertPublicationAuthentication({
        artifacts,
        mode: "trusted",
        bootstrapToken: "",
        packageExists: async () => true,
      }),
    ).resolves.toBeUndefined();
  });

  it("publishes a fresh or partial release before provenance verification", async () => {
    const artifacts = [
      { name: "@humber-foundry/application", integrity: "sha512-a" },
      { name: "@humber-foundry/operator", integrity: "sha512-b" },
    ];
    const registry = new Map([["@humber-foundry/application", "sha512-a"]]);
    const events = [];
    await publishRegistryArtifacts({
      artifacts,
      getIntegrity: async (artifact) => registry.get(artifact.name) ?? null,
      publish: async (artifact) => {
        events.push(`publish:${artifact.name}`);
        registry.set(artifact.name, artifact.integrity);
      },
      verifyProvenance: async () => events.push("provenance"),
    });
    expect(events).toEqual(["publish:@humber-foundry/operator", "provenance"]);
  });

  it("fails before publication on conflicting registry integrity", async () => {
    await expect(
      publishRegistryArtifacts({
        artifacts: [{ name: "@humber-foundry/operator", integrity: "sha512-good" }],
        getIntegrity: async () => "sha512-conflict",
        publish: async () => undefined,
        verifyProvenance: async () => undefined,
      }),
    ).rejects.toThrow(/foundation_release_registry_conflict/u);
  });

  it("creates only for an exact absent-release response and propagates verification errors", async () => {
    expect(isAbsentGitHubRelease("gh: Not Found (HTTP 404)\n")).toBe(true);
    expect(isAbsentGitHubRelease("repository not found")).toBe(false);
    expect(isAbsentGitHubRelease("gh: authentication failed: not found")).toBe(false);
    const events = [];
    await reconcileGitHubRelease({
      existing: null,
      verifyExisting: async () => events.push("verify"),
      create: async () => events.push("create"),
    });
    expect(events).toEqual(["create"]);
    await expect(
      reconcileGitHubRelease({
        existing: { tagName: "foundation-v0.1.0" },
        verifyExisting: async () => {
          throw new Error("download_failed");
        },
        create: async () => undefined,
      }),
    ).rejects.toThrow(/download_failed/u);
  });
});
