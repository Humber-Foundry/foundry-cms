import { describe, expect, it } from "vitest";

import {
  CredentialMaterialRefusedError,
  InvalidConfigurationError,
  assertNonSecretConfiguration,
  computeAccountScopeFingerprint,
  computeConfigurationFingerprint,
  fingerprintPattern,
  fingerprintsMatch,
} from "./configuration-fingerprint";

const installationId = "01984f2a-1c00-7000-8000-0000000000aa";
const deploymentId = "01984f2a-1c00-7000-8000-0000000000bb";

const workerConfiguration = {
  kind: "worker",
  name: "acme-kmnpqrstuvwxyzab",
  bindings: [
    { type: "d1", name: "DB", database: "acme-kmnpqrstuvwxyzab" },
    { type: "r2", name: "MEDIA", bucket: "acme-kmnpqrstuvwxyzab-media" },
  ],
  workersDevEnabled: false,
  previewUrlsEnabled: false,
};

describe("configuration fingerprints", () => {
  it("produces a namespaced sha-256 digest", async () => {
    const fingerprint = await computeConfigurationFingerprint(
      workerConfiguration,
    );
    expect(fingerprint).toMatch(fingerprintPattern);
  });

  it("ignores key order", async () => {
    const reordered = {
      previewUrlsEnabled: false,
      workersDevEnabled: false,
      bindings: [
        { database: "acme-kmnpqrstuvwxyzab", name: "DB", type: "d1" },
        { bucket: "acme-kmnpqrstuvwxyzab-media", name: "MEDIA", type: "r2" },
      ],
      name: "acme-kmnpqrstuvwxyzab",
      kind: "worker",
    };

    expect(await computeConfigurationFingerprint(reordered)).toBe(
      await computeConfigurationFingerprint(workerConfiguration),
    );
  });

  it("respects array order because binding order is meaningful", async () => {
    const swapped = {
      ...workerConfiguration,
      bindings: [...workerConfiguration.bindings].reverse(),
    };

    expect(await computeConfigurationFingerprint(swapped)).not.toBe(
      await computeConfigurationFingerprint(workerConfiguration),
    );
  });

  it("changes when any configured value changes", async () => {
    expect(
      await computeConfigurationFingerprint({
        ...workerConfiguration,
        workersDevEnabled: true,
      }),
    ).not.toBe(await computeConfigurationFingerprint(workerConfiguration));
  });

  it("distinguishes an absent field from an explicitly null field", async () => {
    expect(
      await computeConfigurationFingerprint({ name: "acme", route: null }),
    ).not.toBe(await computeConfigurationFingerprint({ name: "acme" }));
  });

  it("refuses credential material anywhere in the configuration", async () => {
    await expect(
      computeConfigurationFingerprint({
        ...workerConfiguration,
        turnstileSecret: "0x4AAAAAAABCDEFGhijklmnop_qrstuvwxyz012345",
      }),
    ).rejects.toThrow(CredentialMaterialRefusedError);

    await expect(
      computeConfigurationFingerprint({
        notes: "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8",
      }),
    ).rejects.toThrow(CredentialMaterialRefusedError);
  });

  it("names the offending path without repeating the value", async () => {
    const error = await computeConfigurationFingerprint({
      adapters: { brevo: { apiKey: "xkeysib-0a1b2c3d4e5f60718293a4b5c6d7e8f90" } },
    }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(CredentialMaterialRefusedError);
    const refusal = error as CredentialMaterialRefusedError;
    expect(refusal.locations.map((location) => location.path)).toEqual([
      "$.adapters.brevo.apiKey",
    ]);
    expect(refusal.message).not.toContain("xkeysib");
  });

  it("refuses values that cannot be canonicalized", async () => {
    await expect(
      computeConfigurationFingerprint({ apply: () => undefined }),
    ).rejects.toThrow(InvalidConfigurationError);
    await expect(
      computeConfigurationFingerprint({ size: 10n }),
    ).rejects.toThrow(InvalidConfigurationError);
    await expect(
      computeConfigurationFingerprint({ ratio: Number.NaN }),
    ).rejects.toThrow(InvalidConfigurationError);
  });
});

describe("fingerprint comparison", () => {
  it("matches two identical fingerprints", async () => {
    const fingerprint = await computeConfigurationFingerprint(
      workerConfiguration,
    );
    expect(fingerprintsMatch(fingerprint, fingerprint)).toBe(true);
  });

  it("does not match a missing or malformed fingerprint", async () => {
    const fingerprint = await computeConfigurationFingerprint(
      workerConfiguration,
    );
    expect(fingerprintsMatch(fingerprint, null)).toBe(false);
    expect(fingerprintsMatch(null, null)).toBe(false);
    expect(fingerprintsMatch(fingerprint, "sha256:short")).toBe(false);
    expect(fingerprintsMatch(fingerprint, fingerprint.toUpperCase())).toBe(
      false,
    );
  });
});

describe("account-scope fingerprints", () => {
  const scope = {
    provider: "cloudflare",
    accountId: "9f1c0a2b3d4e5f60718293a4b5c6d7e8",
    installationId,
    deploymentId,
  } as const;

  it("is a one-way digest that never contains the account id", async () => {
    const fingerprint = await computeAccountScopeFingerprint(scope);

    expect(fingerprint).toMatch(fingerprintPattern);
    expect(fingerprint).not.toContain(scope.accountId);
  });

  it("is deterministic and recomputable by a fresh operator", async () => {
    expect(await computeAccountScopeFingerprint(scope)).toBe(
      await computeAccountScopeFingerprint({ ...scope }),
    );
  });

  it("changes with the provider, account, installation or deployment", async () => {
    const base = await computeAccountScopeFingerprint(scope);

    expect(
      await computeAccountScopeFingerprint({ ...scope, provider: "github" }),
    ).not.toBe(base);
    expect(
      await computeAccountScopeFingerprint({
        ...scope,
        accountId: "0000000000000000000000000000dead",
      }),
    ).not.toBe(base);
    expect(
      await computeAccountScopeFingerprint({
        ...scope,
        installationId: deploymentId,
      }),
    ).not.toBe(base);
    expect(
      await computeAccountScopeFingerprint({
        ...scope,
        deploymentId: installationId,
      }),
    ).not.toBe(base);
  });

  it("cannot be confused by shifting characters across a field boundary", async () => {
    expect(
      await computeAccountScopeFingerprint({
        ...scope,
        provider: "cloudflare",
        accountId: "abc",
      }),
    ).not.toBe(
      await computeAccountScopeFingerprint({
        ...scope,
        provider: "cloudflarea",
        accountId: "bc",
      }),
    );
  });

  it("requires every scope field", async () => {
    await expect(
      computeAccountScopeFingerprint({ ...scope, accountId: "" }),
    ).rejects.toThrow(InvalidConfigurationError);
    await expect(
      computeAccountScopeFingerprint({ ...scope, provider: "  " }),
    ).rejects.toThrow(InvalidConfigurationError);
    await expect(
      computeAccountScopeFingerprint({
        ...scope,
        installationId: "not-a-uuid",
      }),
    ).rejects.toThrow(InvalidConfigurationError);
  });
});

describe("non-secret configuration assertion", () => {
  it("passes a safe configuration", () => {
    expect(() => assertNonSecretConfiguration(workerConfiguration)).not.toThrow();
  });

  it("throws with every offending path", () => {
    const error = (() => {
      try {
        assertNonSecretConfiguration({
          brevo: { apiKey: "" },
          github: { privateKey: "" },
        });
        return null;
      } catch (thrown) {
        return thrown;
      }
    })();

    expect(error).toBeInstanceOf(CredentialMaterialRefusedError);
    expect(
      (error as CredentialMaterialRefusedError).locations.map(
        (location) => location.path,
      ),
    ).toEqual(["$.brevo.apiKey", "$.github.privateKey"]);
  });
});
