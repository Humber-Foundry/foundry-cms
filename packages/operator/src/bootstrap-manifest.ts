/**
 * The client-owned bootstrap manifest committed at `.foundry/installation.json`.
 *
 * A fresh machine with only the client repository and client account
 * authorization must be able to identify the installation, its pinned
 * foundation release and its deterministic resource names. The manifest is
 * therefore public-safe: it carries operational identifiers an account
 * administrator can already see, and never a provider account ID, personal
 * email, health response or credential.
 */

import { canonicalJson } from "@humber-foundry/application";

import {
  fingerprintPattern,
  type ConfigurationFingerprint,
} from "./configuration-fingerprint";
import {
  createInstallationIdentity,
  derivedResourceKinds,
  isUuidV7,
  resourceNameFor,
  type DerivedResourceKind,
  type InstallationIdentity,
} from "./installation-identity";
import { OperatorError } from "./operator-errors";
import { findCredentialMaterial } from "./secret-material";

export const bootstrapManifestSchemaVersion = "foundry.installation/v1";

export const bootstrapManifestPath = ".foundry/installation.json";

const hostnamePattern =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;

const releaseVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?$/u;

const base64KeyPattern = /^[A-Za-z0-9+/]{40,}={0,2}$/u;

export type BootstrapManifest = Readonly<{
  schemaVersion: string;
  installationId: string;
  activeDeploymentId: string;
  supersededDeploymentIds: ReadonlyArray<string>;
  installationSlug: string;
  resourceStem: string;
  productionBranch: string;
  provisioningStateBranch: string;
  canonicalHostname: string;
  foundationRelease: Readonly<{ version: string; digest: string }>;
  accountScopeFingerprints: Readonly<{
    github: ConfigurationFingerprint;
    cloudflare: ConfigurationFingerprint;
  }>;
  resourceNames: Readonly<Record<string, string>>;
  provisioningReceiptVerificationKey: string;
  temporaryHosting: boolean;
}>;

export class BootstrapManifestError extends OperatorError {}

/**
 * Fields that must never appear in a manifest committed to a repository the
 * client may make public.
 */
const forbiddenManifestFields = Object.freeze([
  "accountId",
  "accountid",
  "account_id",
  "zoneId",
  "zone_id",
  "ownerEmail",
  "owner_email",
  "email",
  "apiToken",
  "api_token",
]);

function assertPublicSafe(manifest: unknown): void {
  const credential = findCredentialMaterial(manifest);
  if (credential.length > 0) {
    throw new BootstrapManifestError("manifest_carries_credential_material");
  }
  const serialized = canonicalJson(manifest);
  for (const field of forbiddenManifestFields) {
    if (serialized.includes(`"${field}"`)) {
      throw new BootstrapManifestError("manifest_carries_account_identifier");
    }
  }
}

export function createBootstrapManifest({
  identity,
  productionBranch,
  provisioningStateBranch = "foundry/provisioning-state",
  canonicalHostname,
  foundationRelease,
  accountScopeFingerprints,
  resourceNames,
  provisioningReceiptVerificationKey,
  temporaryHosting = false,
}: {
  identity: InstallationIdentity;
  productionBranch: string;
  provisioningStateBranch?: string;
  canonicalHostname: string;
  foundationRelease: { version: string; digest: string };
  accountScopeFingerprints: {
    github: ConfigurationFingerprint;
    cloudflare: ConfigurationFingerprint;
  };
  resourceNames: Record<string, string>;
  provisioningReceiptVerificationKey: string;
  temporaryHosting?: boolean;
}): BootstrapManifest {
  const hostname = canonicalHostname.trim().toLowerCase();
  if (!hostnamePattern.test(hostname)) {
    throw new BootstrapManifestError("manifest_hostname_invalid");
  }
  if (!releaseVersionPattern.test(foundationRelease.version)) {
    throw new BootstrapManifestError("manifest_release_version_invalid");
  }
  if (!fingerprintPattern.test(foundationRelease.digest)) {
    throw new BootstrapManifestError("manifest_release_digest_invalid");
  }
  const accountScopeProviders = Object.keys(accountScopeFingerprints).sort();
  if (
    accountScopeProviders.length !== 2 ||
    accountScopeProviders[0] !== "cloudflare" ||
    accountScopeProviders[1] !== "github"
  ) {
    // Both bindings are what let a fresh operator prove which accounts this
    // installation belongs to; one missing is not a partial manifest, it is an
    // unusable one.
    throw new BootstrapManifestError("manifest_account_scope_incomplete");
  }
  for (const fingerprint of Object.values(accountScopeFingerprints)) {
    if (!fingerprintPattern.test(fingerprint)) {
      throw new BootstrapManifestError("manifest_account_scope_invalid");
    }
  }
  if (!base64KeyPattern.test(provisioningReceiptVerificationKey)) {
    throw new BootstrapManifestError("manifest_receipt_key_invalid");
  }
  if (Object.keys(resourceNames).length === 0) {
    throw new BootstrapManifestError("manifest_resource_names_required");
  }
  // Each name must be exactly what `resourceNameFor` derives for its kind. A
  // prefix check would let an edited manifest substitute `<stem>-anything` and
  // still look self-consistent to a fresh operator.
  for (const [kind, name] of Object.entries(resourceNames)) {
    if (!(derivedResourceKinds as ReadonlyArray<string>).includes(kind)) {
      throw new BootstrapManifestError("manifest_resource_kind_unknown");
    }
    if (name !== resourceNameFor(identity, kind as DerivedResourceKind)) {
      throw new BootstrapManifestError("manifest_resource_name_not_derived");
    }
  }

  const manifest: BootstrapManifest = {
    schemaVersion: bootstrapManifestSchemaVersion,
    installationId: identity.installationId,
    activeDeploymentId: identity.deploymentId,
    supersededDeploymentIds: Object.freeze([
      ...identity.supersededDeploymentIds,
    ]),
    installationSlug: identity.installationSlug,
    resourceStem: identity.resourceStem,
    productionBranch: productionBranch.trim(),
    provisioningStateBranch: provisioningStateBranch.trim(),
    canonicalHostname: hostname,
    foundationRelease: Object.freeze({ ...foundationRelease }),
    accountScopeFingerprints: Object.freeze({ ...accountScopeFingerprints }),
    resourceNames: Object.freeze({ ...resourceNames }),
    provisioningReceiptVerificationKey,
    temporaryHosting,
  };

  assertPublicSafe(manifest);
  return Object.freeze(manifest);
}

/**
 * Serialized through `canonicalJson` so key order is the same deterministic
 * order the fingerprints use, then re-indented for the human who reviews the
 * commit in the client repository.
 */
export function serializeBootstrapManifest(
  manifest: BootstrapManifest,
): string {
  assertPublicSafe(manifest);
  return `${JSON.stringify(JSON.parse(canonicalJson(manifest)), null, 2)}\n`;
}

/**
 * Parses a manifest read from a client repository and re-derives it from its own
 * declared identity. Anything that does not rebuild byte-for-byte — a hostname,
 * fingerprint, branch or resource name that was edited, or a resource stem that
 * does not derive from the declared deployment — is rejected rather than cast
 * into trusted code as a typed value.
 */
export async function parseBootstrapManifest(
  source: string,
): Promise<BootstrapManifest> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new BootstrapManifestError("manifest_unparsable");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new BootstrapManifestError("manifest_unparsable");
  }
  const candidate = parsed as Record<string, unknown>;
  if (candidate.schemaVersion !== bootstrapManifestSchemaVersion) {
    throw new BootstrapManifestError("manifest_schema_incompatible");
  }
  if (
    !isUuidV7(candidate.installationId) ||
    !isUuidV7(candidate.activeDeploymentId)
  ) {
    throw new BootstrapManifestError("manifest_identity_invalid");
  }
  if (candidate.installationId === candidate.activeDeploymentId) {
    throw new BootstrapManifestError("manifest_identity_invalid");
  }
  assertPublicSafe(candidate);

  let rebuilt: BootstrapManifest;
  try {
    rebuilt = createBootstrapManifest({
      identity: await createInstallationIdentity({
        installationId: candidate.installationId,
        deploymentId: candidate.activeDeploymentId,
        label: candidate.installationSlug,
        supersededDeploymentIds:
          (candidate.supersededDeploymentIds as ReadonlyArray<unknown>) ?? [],
      }),
      productionBranch: candidate.productionBranch as string,
      provisioningStateBranch: candidate.provisioningStateBranch as string,
      canonicalHostname: candidate.canonicalHostname as string,
      foundationRelease: candidate.foundationRelease as {
        version: string;
        digest: string;
      },
      accountScopeFingerprints: candidate.accountScopeFingerprints as {
        github: ConfigurationFingerprint;
        cloudflare: ConfigurationFingerprint;
      },
      resourceNames: candidate.resourceNames as Record<string, string>,
      provisioningReceiptVerificationKey:
        candidate.provisioningReceiptVerificationKey as string,
      temporaryHosting: candidate.temporaryHosting as boolean,
    });
  } catch (error) {
    if (error instanceof BootstrapManifestError) {
      throw error;
    }
    throw new BootstrapManifestError("manifest_fields_invalid");
  }

  if (canonicalJson(rebuilt) !== canonicalJson(candidate)) {
    throw new BootstrapManifestError("manifest_not_self_consistent");
  }
  return rebuilt;
}

/**
 * The manifest alone does not prove which installation a repository holds. The
 * repository's own description marker is the second, provider-side fact.
 */
export function assertManifestMatchesRepositoryMarker({
  manifest,
  repositoryMarkerInstallationId,
}: {
  manifest: BootstrapManifest;
  repositoryMarkerInstallationId: string | null;
}): void {
  if (repositoryMarkerInstallationId === null) {
    throw new BootstrapManifestError("manifest_repository_marker_absent");
  }
  if (
    repositoryMarkerInstallationId.toLowerCase() !== manifest.installationId
  ) {
    throw new BootstrapManifestError("manifest_repository_marker_mismatch");
  }
}

/**
 * Every identifier in the manifest is already visible to an administrator of
 * the client accounts, but a public repository shows them to everyone. The
 * scaffold surfaces that as an explicit warning rather than a silent default.
 */
export function publicRepositoryDisclosureWarning(
  manifest: BootstrapManifest,
): ReadonlyArray<string> {
  return Object.freeze([
    `installation ${manifest.installationId}`,
    `deployment ${manifest.activeDeploymentId}`,
    `resource stem ${manifest.resourceStem}`,
    `canonical hostname ${manifest.canonicalHostname}`,
  ]);
}
