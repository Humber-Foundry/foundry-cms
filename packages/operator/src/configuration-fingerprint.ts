/**
 * Non-secret configuration fingerprints.
 *
 * A fingerprint states what an operator intends a provider resource to be, and
 * what the provider was observed to be, without carrying any credential. Equal
 * fingerprints mean equal declared configuration, so reconciliation can decide
 * between `exact`, `repairable_drift` and `incompatible_drift` without reading
 * a secret back from a provider.
 */

import { canonicalJson, sha256CanonicalJson } from "@foundry/application";

import { OperatorError, requireText } from "./operator-errors";
import {
  findCredentialMaterial,
  type CredentialMaterialLocation,
} from "./secret-material";

export const fingerprintPattern = /^sha256:[0-9a-f]{64}$/u;

const uuidV7Pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type ConfigurationFingerprint = string;

export type AccountScope = Readonly<{
  provider: string;
  accountId: string;
  installationId: string;
  deploymentId: string;
}>;

export class InvalidConfigurationError extends OperatorError {
  readonly path: string;

  constructor(code: string, path = "$") {
    super(code);
    this.path = path;
  }
}

export class CredentialMaterialRefusedError extends OperatorError {
  readonly locations: ReadonlyArray<CredentialMaterialLocation>;

  constructor(locations: ReadonlyArray<CredentialMaterialLocation>) {
    super("configuration_carries_credential_material");
    this.message = `configuration_carries_credential_material: ${locations
      .map((location) => `${location.path} (${location.reason})`)
      .join(", ")}`;
    this.locations = Object.freeze([...locations]);
  }
}

/**
 * Rejects anything `canonicalJson` would silently turn into invalid or lossy
 * output, so a fingerprint can never collapse two different configurations.
 */
function assertCanonicalizable(value: unknown, path: string): void {
  if (value === null) {
    return;
  }
  switch (typeof value) {
    case "string":
    case "boolean":
      return;
    case "number":
      if (!Number.isFinite(value)) {
        throw new InvalidConfigurationError(
          "configuration_value_not_finite",
          path,
        );
      }
      return;
    case "object":
      break;
    default:
      throw new InvalidConfigurationError(
        "configuration_value_not_serializable",
        path,
      );
  }

  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertCanonicalizable(entry, `${path}[${index}]`),
    );
    return;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new InvalidConfigurationError(
      "configuration_value_not_plain_object",
      path,
    );
  }
  for (const [key, entry] of Object.entries(value as object)) {
    assertCanonicalizable(entry, `${path}.${key}`);
  }
}

export function assertNonSecretConfiguration(configuration: unknown): void {
  const locations = findCredentialMaterial(configuration);
  if (locations.length > 0) {
    throw new CredentialMaterialRefusedError(locations);
  }
}

export async function computeConfigurationFingerprint(
  configuration: unknown,
): Promise<ConfigurationFingerprint> {
  assertCanonicalizable(configuration, "$");
  assertNonSecretConfiguration(configuration);
  return `sha256:${await sha256CanonicalJson(configuration)}`;
}

export function fingerprintsMatch(
  left: unknown,
  right: unknown,
): boolean {
  return (
    typeof left === "string" &&
    typeof right === "string" &&
    fingerprintPattern.test(left) &&
    fingerprintPattern.test(right) &&
    left === right
  );
}

function requiredScopeField(
  value: unknown,
  code: string,
  path: string,
): string {
  return requireText(
    value,
    code,
    (reason) => new InvalidConfigurationError(reason, path),
  );
}

/**
 * Binds an operation to one provider account without committing the raw
 * account ID, so a fresh operator can recompute and compare the scope while the
 * repository never records which account it names.
 */
export async function computeAccountScopeFingerprint(
  scope: AccountScope,
): Promise<ConfigurationFingerprint> {
  const provider = requiredScopeField(
    scope.provider,
    "account_scope_provider_invalid",
    "$.provider",
  ).toLowerCase();
  const accountId = requiredScopeField(
    scope.accountId,
    "account_scope_account_invalid",
    "$.accountId",
  );
  const installationId = requiredScopeField(
    scope.installationId,
    "account_scope_installation_invalid",
    "$.installationId",
  ).toLowerCase();
  const deploymentId = requiredScopeField(
    scope.deploymentId,
    "account_scope_deployment_invalid",
    "$.deploymentId",
  ).toLowerCase();

  if (!uuidV7Pattern.test(installationId)) {
    throw new InvalidConfigurationError(
      "account_scope_installation_invalid",
      "$.installationId",
    );
  }
  if (!uuidV7Pattern.test(deploymentId)) {
    throw new InvalidConfigurationError(
      "account_scope_deployment_invalid",
      "$.deploymentId",
    );
  }

  // Canonical JSON quotes and delimits every field, so no value can be shifted
  // across a field boundary to forge another account's fingerprint.
  return `sha256:${await sha256CanonicalJson({
    schemaVersion: "foundry.account-scope/v1",
    provider,
    accountId,
    installationId,
    deploymentId,
  })}`;
}
