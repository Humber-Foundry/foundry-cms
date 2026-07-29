import { describe, expect, it } from "vitest";

import {
  containsCredentialMaterial,
  findCredentialMaterial,
  isCredentialFieldName,
  looksLikeCredentialMaterial,
} from "./secret-material";

describe("credential-shaped values", () => {
  it.each([
    ["a GitHub personal access token", "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"],
    ["a fine-grained GitHub token", "github_pat_11ABCDEFG0aBcDeFgHiJkLmNoPqRsTuVwXyZ"],
    ["a Brevo API key", "xkeysib-0a1b2c3d4e5f60718293a4b5c6d7e8f90"],
    ["a Turnstile secret key", "0x4AAAAAAABCDEFGhijklmnop_qrstuvwxyz012345"],
    [
      "a PEM private key block",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEow==\n-----END RSA PRIVATE KEY-----",
    ],
    [
      "a JSON web token",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvd25lciJ9.dBjftJeZ4CVPmB92K27uhbUJU1p1r",
    ],
    [
      "an authorization header value",
      // Deliberately not shaped like any real provider's key: this exercises the
      // bearer-token rule, and a realistic literal would trip secret scanning.
      "Bearer QUJDREVGR0hJSktMTU5PUFFSU1RVVldY",
    ],
    ["a URL carrying userinfo", "https://operator:hunter2@api.example.com/v1"],
    [
      "a URL query credential",
      "https://api.example.com/v4/zones?api_token=abcdefghijklmnopqrst",
    ],
    ["a secret-manager reference", ["op", "://Skip Agent/Cloudflare/token"].join("")],
    [
      "a Cloudflare API token",
      "V1a2B3c4D5e6F7g8H9i0J1k2L3m4N5o6P7q8R9s0",
    ],
  ])("detects %s", (_label, value) => {
    expect(looksLikeCredentialMaterial(value)).toBe(true);
  });

  it.each([
    ["a resource stem", "acme-marine-charter-services-ltd-k7mnp2qrstuvwxya"],
    ["an installation slug", "acme-marine"],
    ["a sha-256 digest", `sha256:${"a1b2c3d4".repeat(8)}`],
    ["a bare git object id", "c6be19d3f0a1b2c3d4e5f60718293a4b5c6d7e8f"],
    ["a UUIDv7", "01984f2a-1c00-7000-8000-0000000000aa"],
    ["an ISO timestamp", "2026-07-27T00:10:00.000Z"],
    ["a step identifier", "cloudflare.builds.authorization"],
    ["an evidence reference", "check:auth.protected-routes:7"],
    ["a canonical hostname", "https://acme-marine.example/dash"],
    ["a Cloudflare dashboard action URL", "https://dash.cloudflare.com/abc/workers"],
    ["an empty string", ""],
    ["a stable machine code", "security.output_redacted"],
  ])("does not flag %s", (_label, value) => {
    expect(looksLikeCredentialMaterial(value)).toBe(false);
  });

  it("ignores non-string values", () => {
    expect(looksLikeCredentialMaterial(42)).toBe(false);
    expect(looksLikeCredentialMaterial(null)).toBe(false);
    expect(looksLikeCredentialMaterial(undefined)).toBe(false);
  });
});

describe("credential field names", () => {
  it.each([
    "secret",
    "apiKey",
    "api_key",
    "githubPublisherPrivateKey",
    "turnstile_secret",
    "authorization",
    "accessToken",
    "password",
    "sessionCookie",
    "webhookVerificationSecret",
    "provisioningReceiptSigningKey",
    "recoveryPrivateKey",
  ])("refuses the field name %s", (name) => {
    expect(isCredentialFieldName(name)).toBe(true);
  });

  it.each([
    "installationId",
    "deploymentId",
    "resourceStem",
    "observedFingerprint",
    "credentialSlotId",
    "authority",
    "author",
    "stepId",
    "checkId",
    "provisioningReceiptVerificationKey",
    "publicKey",
    "signature",
    "receiptHash",
    "upgradeGateAppPublicKeyFingerprint",
  ])("permits the field name %s", (name) => {
    expect(isCredentialFieldName(name)).toBe(false);
  });
});

describe("structural credential search", () => {
  it("reports the path of a credential-shaped value", () => {
    const found = findCredentialMaterial({
      step: {
        resource: { name: "acme-kmnpqrstuvwxyzab" },
        evidence: ["ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"],
      },
    });

    expect(found).toEqual([
      { path: "$.step.evidence[0]", reason: "value_shape" },
    ]);
  });

  it("refuses a credential-named field even when its value looks harmless", () => {
    expect(findCredentialMaterial({ brevoApiKey: "" })).toEqual([
      { path: "$.brevoApiKey", reason: "field_name" },
    ]);
    expect(findCredentialMaterial({ nested: { token: null } })).toEqual([
      { path: "$.nested.token", reason: "field_name" },
    ]);
  });

  it("accepts a safe provisioning event payload", () => {
    expect(
      containsCredentialMaterial({
        schemaVersion: "foundry.operator/v1",
        event: "step.changed",
        installationId: "01984f2a-1c00-7000-8000-0000000000aa",
        deploymentId: "01984f2a-1c00-7000-8000-0000000000bb",
        stepId: "cloudflare.d1",
        status: "applied_unverified",
        attempt: 1,
        resource: { kind: "d1", name: "acme-kmnpqrstuvwxyzab" },
      }),
    ).toBe(false);
  });

  it("terminates on a cyclic structure", () => {
    const cyclic: Record<string, unknown> = { name: "acme" };
    cyclic.self = cyclic;
    expect(containsCredentialMaterial(cyclic)).toBe(false);
  });
});
