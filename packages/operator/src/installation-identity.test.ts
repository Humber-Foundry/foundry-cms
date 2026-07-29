import { describe, expect, it } from "vitest";

import {
  InvalidInstallationIdentityError,
  createInstallationIdentity,
  createDeploymentId,
  createInstallationId,
  createOperationId,
  generateOperationId,
  deriveResourceStem,
  deriveResourceSuffix,
  installationMarker,
  normalizeInstallationSlug,
  parseInstallationMarker,
  resourceNameFor,
} from "./installation-identity";

const installationId = "01984f2a-1c00-7000-8000-0000000000aa";
const deploymentId = "01984f2a-1c00-7000-8000-0000000000bb";

describe("installation slug normalization", () => {
  it("lowercases and hyphenates an ordinary client label", () => {
    expect(normalizeInstallationSlug("Acme Marine Ltd.")).toBe(
      "acme-marine-ltd",
    );
  });

  it("removes repeated and edge hyphens", () => {
    expect(normalizeInstallationSlug("--Acme   __ Marine--")).toBe(
      "acme-marine",
    );
  });

  it("caps the slug at thirty-two characters without a trailing hyphen", () => {
    const slug = normalizeInstallationSlug(
      "a".repeat(31) + " " + "b".repeat(10),
    );
    expect(slug).toBe("a".repeat(31));
    expect(slug.length).toBeLessThanOrEqual(32);
  });

  it("caps a long single word at thirty-two characters", () => {
    expect(normalizeInstallationSlug("c".repeat(64))).toBe("c".repeat(32));
  });

  it("falls back to site when no ASCII alphanumeric remains", () => {
    expect(normalizeInstallationSlug("—— ✳︎ ——")).toBe("site");
    expect(normalizeInstallationSlug("")).toBe("site");
  });

  it("transliterates nothing and drops non-ASCII alphanumerics", () => {
    expect(normalizeInstallationSlug("Ærø Sejlklub")).toBe("r-sejlklub");
  });

  it("rejects a non-string label", () => {
    expect(() => normalizeInstallationSlug(42 as unknown as string)).toThrow(
      InvalidInstallationIdentityError,
    );
  });
});

describe("resource suffix derivation", () => {
  it("derives sixteen lowercase base32 characters from the deployment id", async () => {
    const suffix = await deriveResourceSuffix(deploymentId);
    expect(suffix).toMatch(/^[a-z2-7]{16}$/u);
  });

  it("is deterministic for the same deployment id", async () => {
    expect(await deriveResourceSuffix(deploymentId)).toBe(
      await deriveResourceSuffix(deploymentId),
    );
  });

  it("normalizes deployment id casing before hashing", async () => {
    expect(await deriveResourceSuffix(deploymentId.toUpperCase())).toBe(
      await deriveResourceSuffix(deploymentId),
    );
  });

  it("differs for a different deployment id", async () => {
    expect(await deriveResourceSuffix(deploymentId)).not.toBe(
      await deriveResourceSuffix(installationId),
    );
  });

  it("does not derive from the installation id", async () => {
    const identity = await createInstallationIdentity({
      installationId,
      deploymentId,
      label: "Acme",
    });
    expect(identity.resourceSuffix).toBe(
      await deriveResourceSuffix(deploymentId),
    );
  });

  it("rejects an identifier that is not a UUIDv7", async () => {
    await expect(
      deriveResourceSuffix("01984f2a-1c00-4000-8000-0000000000bb"),
    ).rejects.toThrow(InvalidInstallationIdentityError);
    await expect(
      deriveResourceSuffix("01984f2a-1c00-7000-c000-0000000000bb"),
    ).rejects.toThrow(InvalidInstallationIdentityError);
    await expect(deriveResourceSuffix("not-a-uuid")).rejects.toThrow(
      InvalidInstallationIdentityError,
    );
  });
});

describe("resource stem", () => {
  it("joins the slug and suffix", () => {
    expect(deriveResourceStem("acme", "kmnpqrstuvwxyzab")).toBe(
      "acme-kmnpqrstuvwxyzab",
    );
  });

  it("rejects an unnormalized slug", () => {
    expect(() => deriveResourceStem("Acme", "kmnpqrstuvwxyzab")).toThrow(
      InvalidInstallationIdentityError,
    );
  });

  it("rejects a suffix that is not sixteen base32 characters", () => {
    expect(() => deriveResourceStem("acme", "short")).toThrow(
      InvalidInstallationIdentityError,
    );
    expect(() => deriveResourceStem("acme", "KMNPQRSTUVWXYZAB")).toThrow(
      InvalidInstallationIdentityError,
    );
  });
});

describe("installation identity", () => {
  it("binds a logical installation to one account-bound deployment", async () => {
    const identity = await createInstallationIdentity({
      installationId,
      deploymentId,
      label: "Acme Marine",
    });

    expect(identity.installationId).toBe(installationId);
    expect(identity.deploymentId).toBe(deploymentId);
    expect(identity.installationSlug).toBe("acme-marine");
    expect(identity.resourceStem).toBe(
      `acme-marine-${identity.resourceSuffix}`,
    );
    expect(identity.supersededDeploymentIds).toEqual([]);
  });

  it("normalizes identifier casing", async () => {
    const identity = await createInstallationIdentity({
      installationId: installationId.toUpperCase(),
      deploymentId: deploymentId.toUpperCase(),
      label: "Acme",
    });
    expect(identity.installationId).toBe(installationId);
    expect(identity.deploymentId).toBe(deploymentId);
  });

  it("rejects an installation id equal to the deployment id", async () => {
    await expect(
      createInstallationIdentity({
        installationId,
        deploymentId: installationId,
        label: "Acme",
      }),
    ).rejects.toThrow(InvalidInstallationIdentityError);
  });

  it("carries deployments it has already superseded", async () => {
    const identity = await createInstallationIdentity({
      installationId,
      deploymentId,
      label: "Acme Marine",
      supersededDeploymentIds: ["01984f2a-1c00-7000-8000-0000000000cc"],
    });

    expect(identity.supersededDeploymentIds).toEqual([
      "01984f2a-1c00-7000-8000-0000000000cc",
    ]);
  });

  it("refuses an active deployment that is also listed as superseded", async () => {
    await expect(
      createInstallationIdentity({
        installationId,
        deploymentId,
        label: "Acme",
        supersededDeploymentIds: [deploymentId],
      }),
    ).rejects.toThrow(InvalidInstallationIdentityError);
  });

  it("is frozen", async () => {
    const identity = await createInstallationIdentity({
      installationId,
      deploymentId,
      label: "Acme",
    });
    expect(Object.isFrozen(identity)).toBe(true);
    expect(Object.isFrozen(identity.supersededDeploymentIds)).toBe(true);
  });
});

describe("resource names", () => {
  it("prefixes the resource stem with the resource kind", async () => {
    const identity = await createInstallationIdentity({
      installationId,
      deploymentId,
      label: "Acme Marine",
    });

    expect(resourceNameFor(identity, "d1")).toBe(identity.resourceStem);
    expect(resourceNameFor(identity, "r2")).toBe(
      `${identity.resourceStem}-media`,
    );
    expect(resourceNameFor(identity, "worker")).toBe(identity.resourceStem);
    expect(resourceNameFor(identity, "analytics-dataset")).toBe(
      `${identity.resourceStem}_events`,
    );
  });

  it("produces names within provider length limits", async () => {
    const identity = await createInstallationIdentity({
      installationId,
      deploymentId,
      label: "z".repeat(60),
    });

    for (const kind of [
      "d1",
      "r2",
      "worker",
      "analytics-dataset",
      "turnstile-widget",
      "access-application",
    ] as const) {
      expect(resourceNameFor(identity, kind).length).toBeLessThanOrEqual(63);
      expect(resourceNameFor(identity, kind)).toMatch(/^[a-z0-9][a-z0-9_-]*$/u);
    }
  });

  it("rejects an unknown resource kind", async () => {
    const identity = await createInstallationIdentity({
      installationId,
      deploymentId,
      label: "Acme",
    });
    expect(() =>
      resourceNameFor(identity, "queue" as unknown as "d1"),
    ).toThrow(InvalidInstallationIdentityError);
  });
});

describe("installation marker", () => {
  it("renders the marker used in the repository description", () => {
    expect(installationMarker(installationId)).toBe(
      `[foundry-installation:${installationId}]`,
    );
  });

  it("parses its own marker out of surrounding description text", () => {
    expect(
      parseInstallationMarker(
        `Acme Marine site ${installationMarker(installationId)} — managed by Foundry CMS`,
      ),
    ).toBe(installationId);
  });

  it("returns null when no marker is present", () => {
    expect(parseInstallationMarker("Acme Marine site")).toBeNull();
    expect(parseInstallationMarker(null)).toBeNull();
    expect(parseInstallationMarker(undefined)).toBeNull();
  });

  it("returns null for a marker that is not a UUIDv7", () => {
    expect(
      parseInstallationMarker("[foundry-installation:not-a-uuid]"),
    ).toBeNull();
  });

  it("refuses an ambiguous description carrying two different markers", () => {
    const other = "01984f2a-1c00-7000-8000-0000000000dd";
    expect(() =>
      parseInstallationMarker(
        `${installationMarker(installationId)} ${installationMarker(other)}`,
      ),
    ).toThrow(InvalidInstallationIdentityError);
  });

  it("accepts a description repeating the same marker", () => {
    expect(
      parseInstallationMarker(
        `${installationMarker(installationId)} ${installationMarker(
          installationId.toUpperCase(),
        )}`,
      ),
    ).toBe(installationId);
  });
});

describe("identifier validators", () => {
  it("accepts a normalized UUIDv7 for each identifier kind", () => {
    expect(createInstallationId(installationId.toUpperCase())).toBe(
      installationId,
    );
    expect(createDeploymentId(deploymentId)).toBe(deploymentId);
    expect(createOperationId(generateOperationId())).toMatch(
      /^[0-9a-f-]{36}$/u,
    );
  });

  it("refuses an identifier that is not a UUIDv7", () => {
    expect(() => createInstallationId("not-a-uuid")).toThrow(
      InvalidInstallationIdentityError,
    );
    expect(() =>
      createDeploymentId("01984f2a-1c00-4000-8000-0000000000bb"),
    ).toThrow(InvalidInstallationIdentityError);
    expect(() => createOperationId(undefined)).toThrow(
      InvalidInstallationIdentityError,
    );
  });
});

describe("operation identity", () => {
  it("creates a distinct UUIDv7 for each invocation", () => {
    const first = generateOperationId();
    const second = generateOperationId();

    expect(first).not.toBe(second);
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
  });

  it("sorts lexicographically by creation time", () => {
    const earlier = generateOperationId({ now: () => 1_700_000_000_000 });
    const later = generateOperationId({ now: () => 1_800_000_000_000 });

    expect(earlier < later).toBe(true);
  });
});
