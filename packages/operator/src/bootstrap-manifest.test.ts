import { describe, expect, it } from "vitest";

import {
  BootstrapManifestError,
  assertManifestMatchesRepositoryMarker,
  bootstrapManifestPath,
  bootstrapManifestSchemaVersion,
  createBootstrapManifest,
  parseBootstrapManifest,
  publicRepositoryDisclosureWarning,
  serializeBootstrapManifest,
} from "./bootstrap-manifest";
import {
  createInstallationIdentity,
  resourceNameFor,
} from "./installation-identity";

const installationId = "01984f2a-1c00-7000-8000-0000000000aa";
const deploymentId = "01984f2a-1c00-7000-8000-0000000000bb";

async function identity() {
  return createInstallationIdentity({
    installationId,
    deploymentId,
    label: "Acme Marine",
  });
}

async function manifest(overrides: Record<string, unknown> = {}) {
  const bound = await identity();
  return createBootstrapManifest({
    identity: bound,
    productionBranch: "main",
    canonicalHostname: "acme-marine.example",
    foundationRelease: {
      version: "1.4.0",
      digest: `sha256:${"f".repeat(64)}`,
    },
    accountScopeFingerprints: {
      github: `sha256:${"1".repeat(64)}`,
      cloudflare: `sha256:${"2".repeat(64)}`,
    },
    resourceNames: {
      d1: resourceNameFor(bound, "d1"),
      r2: resourceNameFor(bound, "r2"),
      worker: resourceNameFor(bound, "worker"),
    },
    provisioningReceiptVerificationKey: "A".repeat(43) + "=",
    ...overrides,
  } as never);
}

describe("bootstrap manifest", () => {
  it("lives at the documented path and records both identities", async () => {
    const record = await manifest();

    expect(bootstrapManifestPath).toBe(".foundry/installation.json");
    expect(record).toMatchObject({
      schemaVersion: bootstrapManifestSchemaVersion,
      installationId,
      activeDeploymentId: deploymentId,
      supersededDeploymentIds: [],
      productionBranch: "main",
      provisioningStateBranch: "foundry/provisioning-state",
      canonicalHostname: "acme-marine.example",
      temporaryHosting: false,
    });
  });

  it("carries the superseded deployment list after a cutover", async () => {
    const next = await createInstallationIdentity({
      installationId,
      deploymentId: "01984f2a-1c00-7000-8000-0000000000cc",
      label: "Acme Marine",
      supersededDeploymentIds: [deploymentId],
    });
    const record = await manifest({
      identity: next,
      resourceNames: { d1: resourceNameFor(next, "d1") },
    });

    expect(record.activeDeploymentId).toBe(
      "01984f2a-1c00-7000-8000-0000000000cc",
    );
    expect(record.supersededDeploymentIds).toEqual([deploymentId]);
  });

  it("refuses a resource name that is not derived from the resource stem", async () => {
    await expect(
      manifest({ resourceNames: { d1: "someone-elses-database" } }),
    ).rejects.toThrow(BootstrapManifestError);
  });

  it("builds only from named public-safe inputs and drops anything else", async () => {
    const record = await manifest({
      accountId: "9f1c0a2b3d4e5f60718293a4b5c6d7e8",
      ownerEmail: "owner@example.com",
    });

    expect(record).not.toHaveProperty("accountId");
    expect(record).not.toHaveProperty("ownerEmail");
  });

  it("refuses a committed manifest carrying a provider account identifier", async () => {
    const serialized = JSON.stringify({
      ...(await manifest()),
      accountId: "9f1c0a2b3d4e5f60718293a4b5c6d7e8",
    });

    await expect(parseBootstrapManifest(serialized)).rejects.toThrow(
      BootstrapManifestError,
    );
  });

  it("refuses a committed manifest carrying credential material", async () => {
    const serialized = JSON.stringify({
      ...(await manifest()),
      buildToken: "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8",
    });

    await expect(parseBootstrapManifest(serialized)).rejects.toThrow(
      BootstrapManifestError,
    );
  });

  it("refuses an invalid hostname, release version or digest", async () => {
    await expect(manifest({ canonicalHostname: "not a host" })).rejects.toThrow(
      BootstrapManifestError,
    );
    await expect(
      manifest({
        foundationRelease: { version: "latest", digest: `sha256:${"f".repeat(64)}` },
      }),
    ).rejects.toThrow(BootstrapManifestError);
    await expect(
      manifest({ foundationRelease: { version: "1.4.0", digest: "abc" } }),
    ).rejects.toThrow(BootstrapManifestError);
  });

  it("round-trips through a stable, key-sorted serialization", async () => {
    const record = await manifest();
    const serialized = serializeBootstrapManifest(record);

    expect(serialized.endsWith("\n")).toBe(true);
    expect(serialized).toBe(
      serializeBootstrapManifest(await parseBootstrapManifest(serialized)),
    );
    expect((await parseBootstrapManifest(serialized)).installationId).toBe(
      installationId,
    );
  });

  it("refuses a manifest from an incompatible schema version", async () => {
    const serialized = serializeBootstrapManifest(await manifest()).replace(
      bootstrapManifestSchemaVersion,
      "foundry.installation/v2",
    );

    await expect(parseBootstrapManifest(serialized)).rejects.toThrow(
      BootstrapManifestError,
    );
  });

  it("refuses a manifest whose deployment id equals its installation id", async () => {
    const serialized = serializeBootstrapManifest(await manifest()).replace(
      deploymentId,
      installationId,
    );

    await expect(parseBootstrapManifest(serialized)).rejects.toThrow(
      BootstrapManifestError,
    );
  });

  it("refuses unparsable input", async () => {
    await expect(parseBootstrapManifest("not json")).rejects.toThrow(
      BootstrapManifestError,
    );
    await expect(parseBootstrapManifest("[]")).rejects.toThrow(
      BootstrapManifestError,
    );
  });

  it("refuses a committed manifest whose fields are malformed", async () => {
    const serialized = serializeBootstrapManifest(await manifest());

    for (const [from, to] of [
      ['"canonicalHostname": "acme-marine.example"', '"canonicalHostname": "not a host"'],
      ['"version": "1.4.0"', '"version": "latest"'],
      [`"digest": "sha256:${"f".repeat(64)}"`, '"digest": "abc"'],
      ['"provisioningReceiptVerificationKey"', '"provisioningReceiptVerificationkey"'],
    ] as const) {
      expect(serialized).toContain(from);
      await expect(
        parseBootstrapManifest(serialized.replace(from, to)),
      ).rejects.toThrow(BootstrapManifestError);
    }
  });

  it("refuses a resource name that is not exactly the derived name", async () => {
    const record = await manifest();

    for (const substitute of [
      "someone-elses-database",
      `${record.resourceStem}-attacker`,
      record.resourceStem.toUpperCase(),
    ]) {
      await expect(
        parseBootstrapManifest(
          JSON.stringify({
            ...record,
            resourceNames: { ...record.resourceNames, d1: substitute },
          }),
        ),
      ).rejects.toThrow(BootstrapManifestError);
    }
  });

  it("refuses a resource name for a kind the identity does not derive", async () => {
    const record = await manifest();

    await expect(
      parseBootstrapManifest(
        JSON.stringify({
          ...record,
          resourceNames: {
            ...record.resourceNames,
            queue: `${record.resourceStem}-queue`,
          },
        }),
      ),
    ).rejects.toThrow(BootstrapManifestError);
  });

  it("refuses a manifest missing either account-scope binding", async () => {
    const record = await manifest();

    for (const fingerprints of [
      {},
      { github: `sha256:${"1".repeat(64)}` },
      { cloudflare: `sha256:${"2".repeat(64)}` },
      {
        github: `sha256:${"1".repeat(64)}`,
        cloudflare: `sha256:${"2".repeat(64)}`,
        netlify: `sha256:${"4".repeat(64)}`,
      },
    ]) {
      await expect(
        parseBootstrapManifest(
          JSON.stringify({ ...record, accountScopeFingerprints: fingerprints }),
        ),
      ).rejects.toThrow(BootstrapManifestError);
    }
  });

  it("refuses a resource stem that does not derive from the declared deployment", async () => {
    const record = await manifest();
    const serialized = JSON.stringify({
      ...record,
      resourceStem: "acme-marine-aaaaaaaaaaaaaaaa",
    });

    await expect(parseBootstrapManifest(serialized)).rejects.toThrow(
      BootstrapManifestError,
    );
  });

  it("refuses a manifest missing a required field", async () => {
    const record = await manifest() as Record<string, unknown>;
    const { canonicalHostname: _omitted, ...missing } = record;

    await expect(parseBootstrapManifest(JSON.stringify(missing))).rejects.toThrow(
      BootstrapManifestError,
    );
  });
});

describe("manifest and repository marker agreement", () => {
  it("accepts a repository whose description marks this installation", async () => {
    const record = await manifest();
    expect(() =>
      assertManifestMatchesRepositoryMarker({
        manifest: record,
        repositoryMarkerInstallationId: installationId.toUpperCase(),
      }),
    ).not.toThrow();
  });

  it("refuses a repository with no marker", async () => {
    const record = await manifest();
    expect(() =>
      assertManifestMatchesRepositoryMarker({
        manifest: record,
        repositoryMarkerInstallationId: null,
      }),
    ).toThrow(BootstrapManifestError);
  });

  it("refuses a repository marking a different installation", async () => {
    const record = await manifest();
    expect(() =>
      assertManifestMatchesRepositoryMarker({
        manifest: record,
        repositoryMarkerInstallationId: "01984f2a-1c00-7000-8000-0000000000dd",
      }),
    ).toThrow(BootstrapManifestError);
  });
});

describe("public repository disclosure", () => {
  it("names every identifier a public repository would reveal", async () => {
    const warning = publicRepositoryDisclosureWarning(await manifest());

    expect(warning).toHaveLength(4);
    expect(warning.join(" ")).toContain(installationId);
    expect(warning.join(" ")).toContain("acme-marine.example");
  });
});
