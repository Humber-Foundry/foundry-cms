import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  assertFoundationReleaseDescriptorDigest,
  computeFoundationReleaseDescriptorDigest,
  foundationPackageNames,
  parseFoundationReleaseDescriptor,
  verifyFoundationReleaseArtifacts,
} from "./foundation-release";

function fixture() {
  const bytes = Object.fromEntries(
    foundationPackageNames.map((name) => [name, Buffer.from(`artifact:${name}`)]),
  );
  const artifacts = Object.fromEntries(
    foundationPackageNames.map((name) => {
      const value = bytes[name] as Buffer;
      return [
        name,
        {
          name,
          version: "0.1.0",
          filename: `${name.slice(1).replace("/", "-")}-0.1.0.tgz`,
          size: value.byteLength,
          integrity: `sha512-${createHash("sha512").update(value).digest("base64")}`,
          sha256: createHash("sha256").update(value).digest("hex"),
        },
      ];
    }),
  );
  const descriptor = {
    schemaVersion: "foundry.foundation-release/v1",
    version: "0.1.0",
    source: {
      repository: "https://github.com/Humber-Foundry/foundry-cms",
      revision: "a".repeat(40),
    },
    compatibility: {
      node: ">=22.19.0",
      npm: ">=11.12.1",
      packageManager: "npm@11.12.1",
    },
    migrations: {
      latest: "0002",
      files: [
        { path: "apps/reference-site/migrations/0001_first.sql", sha256: "1".repeat(64) },
        { path: "apps/reference-site/migrations/0002_second.sql", sha256: "2".repeat(64) },
      ],
    },
    artifacts,
    provenance: {
      builderWorkflow:
        "https://github.com/Humber-Foundry/foundry-cms/actions/workflows/foundation-release.yml",
      sourceRevision: "a".repeat(40),
      subjects: foundationPackageNames.map((name) => ({
        name,
        sha256: (artifacts[name] as { sha256: string }).sha256,
      })),
    },
  };
  return { bytes, descriptor, source: `${JSON.stringify(descriptor, null, 2)}\n` };
}

describe("foundation release descriptor", () => {
  it("accepts one synchronized, artifact-derived release", async () => {
    const { bytes, source } = fixture();
    const parsed = parseFoundationReleaseDescriptor(source);
    await expect(
      verifyFoundationReleaseArtifacts({
        descriptor: parsed,
        readArtifact: async (filename) => {
          const artifact = Object.values(parsed.artifacts).find(
            (candidate) => candidate.filename === filename,
          );
          return bytes[artifact!.name] as Buffer;
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects hand-written package integrity and version drift", () => {
    const { descriptor } = fixture();
    expect(() =>
      parseFoundationReleaseDescriptor(
        JSON.stringify({
          ...descriptor,
          artifacts: {
            ...descriptor.artifacts,
            "@foundry/operator": {
              ...descriptor.artifacts["@foundry/operator"],
              version: "0.1.1",
              integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
            },
          },
        }),
      ),
    ).toThrow(/foundation_release_artifact_invalid/u);
  });

  it("rejects a changed tarball even when its filename and version match", async () => {
    const { bytes, source } = fixture();
    const parsed = parseFoundationReleaseDescriptor(source);
    await expect(
      verifyFoundationReleaseArtifacts({
        descriptor: parsed,
        readArtifact: async (filename) => {
          const artifact = Object.values(parsed.artifacts).find(
            (candidate) => candidate.filename === filename,
          );
          return artifact!.name === "@foundry/reference-site"
            ? Buffer.from("tampered")
            : (bytes[artifact!.name] as Buffer);
        },
      }),
    ).rejects.toThrow(
      /foundation_release_artifact_mismatch:@foundry\/reference-site/u,
    );
  });

  it("binds callers to the exact descriptor bytes", () => {
    const { source } = fixture();
    const digest = computeFoundationReleaseDescriptorDigest(source);
    expect(() =>
      assertFoundationReleaseDescriptorDigest({ source, expectedDigest: digest }),
    ).not.toThrow();
    expect(() =>
      assertFoundationReleaseDescriptorDigest({
        source: `${source}\n`,
        expectedDigest: digest,
      }),
    ).toThrow(/foundation_release_descriptor_digest_mismatch/u);
  });
});
