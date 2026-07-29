/**
 * Durable logical and deployment identity for one Foundry CMS installation.
 *
 * `installationId` names the logical site for its whole life. `deploymentId`
 * names one account-bound Cloudflare resource set and changes only when a
 * separate set is intentionally created. Every provider resource name is
 * derived from the deployment so that two installations, or two deployments of
 * the same installation, can never collide on a name.
 */

import { OperatorError } from "./operator-errors";

const uuidV7Pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const base32Alphabet = "abcdefghijklmnopqrstuvwxyz234567";

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

const resourceSuffixPattern = /^[a-z2-7]{16}$/u;

const installationMarkerPattern =
  /\[foundry-installation:([0-9a-fA-F-]{36})\]/gu;

export const maximumInstallationSlugLength = 32;

export const resourceSuffixLength = 16;

declare const installationIdBrand: unique symbol;
export type InstallationId = string & {
  readonly [installationIdBrand]: "InstallationId";
};

declare const deploymentIdBrand: unique symbol;
export type DeploymentId = string & {
  readonly [deploymentIdBrand]: "DeploymentId";
};

declare const operationIdBrand: unique symbol;
export type OperationId = string & {
  readonly [operationIdBrand]: "OperationId";
};

export const derivedResourceKinds = Object.freeze([
  "d1",
  "r2",
  "worker",
  "analytics-dataset",
  "turnstile-widget",
  "access-application",
  "access-policy",
  "web-analytics-site",
] as const);

export type DerivedResourceKind = (typeof derivedResourceKinds)[number];

const derivedResourceNameSuffixes: Readonly<
  Record<DerivedResourceKind, string>
> = Object.freeze({
  d1: "",
  worker: "",
  r2: "-media",
  "analytics-dataset": "_events",
  "turnstile-widget": "-forms",
  "access-application": "-dash",
  "access-policy": "-dash-owner",
  "web-analytics-site": "-rum",
});

export type InstallationIdentity = Readonly<{
  installationId: InstallationId;
  deploymentId: DeploymentId;
  supersededDeploymentIds: ReadonlyArray<DeploymentId>;
  installationSlug: string;
  resourceSuffix: string;
  resourceStem: string;
}>;

export class InvalidInstallationIdentityError extends OperatorError {}

export function createInstallationId(value: unknown): InstallationId {
  return normalizeUuidV7(value, "installation_id_invalid") as InstallationId;
}

export function createDeploymentId(value: unknown): DeploymentId {
  return normalizeUuidV7(value, "deployment_id_invalid") as DeploymentId;
}

export function createOperationId(value: unknown): OperationId {
  return normalizeUuidV7(value, "operation_id_invalid") as OperationId;
}

function normalizeUuidV7(value: unknown, code: string): string {
  if (typeof value !== "string") {
    throw new InvalidInstallationIdentityError(code);
  }
  const normalized = value.trim().toLowerCase();
  if (!uuidV7Pattern.test(normalized)) {
    throw new InvalidInstallationIdentityError(code);
  }
  return normalized;
}

export function isUuidV7(value: unknown): value is string {
  return typeof value === "string" && uuidV7Pattern.test(value.toLowerCase());
}

export function normalizeInstallationSlug(label: unknown): string {
  if (typeof label !== "string") {
    throw new InvalidInstallationIdentityError("installation_label_invalid");
  }
  const hyphenated = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "");
  const capped = hyphenated
    .slice(0, maximumInstallationSlugLength)
    .replace(/-+$/u, "");
  return capped.length === 0 ? "site" : capped;
}

function encodeBase32(bytes: Uint8Array, characters: number): string {
  let bits = 0;
  let value = 0;
  let encoded = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      encoded += base32Alphabet[(value >>> bits) & 0b11111];
      if (encoded.length === characters) {
        return encoded;
      }
    }
  }
  if (encoded.length < characters) {
    throw new InvalidInstallationIdentityError("resource_suffix_unavailable");
  }
  return encoded;
}

export async function deriveResourceSuffix(
  deploymentId: unknown,
): Promise<string> {
  const canonical = normalizeUuidV7(deploymentId, "deployment_id_invalid");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return encodeBase32(new Uint8Array(digest), resourceSuffixLength);
}

export function deriveResourceStem(slug: string, suffix: string): string {
  if (typeof slug !== "string" || !slugPattern.test(slug)) {
    throw new InvalidInstallationIdentityError("installation_slug_invalid");
  }
  if (slug.length > maximumInstallationSlugLength) {
    throw new InvalidInstallationIdentityError("installation_slug_invalid");
  }
  if (typeof suffix !== "string" || !resourceSuffixPattern.test(suffix)) {
    throw new InvalidInstallationIdentityError("resource_suffix_invalid");
  }
  return `${slug}-${suffix}`;
}

export async function createInstallationIdentity({
  installationId,
  deploymentId,
  label,
  supersededDeploymentIds = [],
}: {
  installationId: unknown;
  deploymentId: unknown;
  label: unknown;
  /**
   * Deployments this installation has already superseded, read back from the
   * bootstrap manifest so a resumed run never reuses an old deployment binding.
   */
  supersededDeploymentIds?: ReadonlyArray<unknown>;
}): Promise<InstallationIdentity> {
  const normalizedInstallationId = normalizeUuidV7(
    installationId,
    "installation_id_invalid",
  );
  const normalizedDeploymentId = normalizeUuidV7(
    deploymentId,
    "deployment_id_invalid",
  );
  if (normalizedInstallationId === normalizedDeploymentId) {
    throw new InvalidInstallationIdentityError("deployment_id_not_distinct");
  }
  const superseded = supersededDeploymentIds.map((value) =>
    normalizeUuidV7(value, "superseded_deployment_id_invalid"),
  );
  if (superseded.includes(normalizedDeploymentId)) {
    throw new InvalidInstallationIdentityError("deployment_id_superseded");
  }
  const installationSlug = normalizeInstallationSlug(label);
  const resourceSuffix = await deriveResourceSuffix(normalizedDeploymentId);

  return Object.freeze({
    installationId: normalizedInstallationId as InstallationId,
    deploymentId: normalizedDeploymentId as DeploymentId,
    supersededDeploymentIds: Object.freeze([
      ...new Set(superseded),
    ]) as ReadonlyArray<DeploymentId>,
    installationSlug,
    resourceSuffix,
    resourceStem: deriveResourceStem(installationSlug, resourceSuffix),
  });
}

export function resourceNameFor(
  identity: InstallationIdentity,
  kind: DerivedResourceKind,
): string {
  const suffix = derivedResourceNameSuffixes[kind];
  if (suffix === undefined) {
    throw new InvalidInstallationIdentityError("resource_kind_unknown");
  }
  return `${identity.resourceStem}${suffix}`;
}

export function installationMarker(installationId: unknown): string {
  return `[foundry-installation:${normalizeUuidV7(
    installationId,
    "installation_id_invalid",
  )}]`;
}

export function parseInstallationMarker(
  description: unknown,
): InstallationId | null {
  if (typeof description !== "string") {
    return null;
  }
  const found = new Set<string>();
  for (const match of description.matchAll(installationMarkerPattern)) {
    const candidate = match[1]?.toLowerCase() ?? "";
    if (uuidV7Pattern.test(candidate)) {
      found.add(candidate);
    }
  }
  if (found.size > 1) {
    throw new InvalidInstallationIdentityError("installation_marker_ambiguous");
  }
  const [only] = found;
  return (only as InstallationId | undefined) ?? null;
}

export function generateOperationId({
  now = () => Date.now(),
  randomBytes = (length: number) =>
    crypto.getRandomValues(new Uint8Array(length)),
}: {
  now?: () => number;
  randomBytes?: (length: number) => Uint8Array;
} = {}): OperationId {
  const milliseconds = Math.floor(now());
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new InvalidInstallationIdentityError("operation_time_invalid");
  }
  const bytes = randomBytes(10);
  if (bytes.length !== 10) {
    throw new InvalidInstallationIdentityError("operation_entropy_invalid");
  }
  const timestamp = milliseconds.toString(16).padStart(12, "0").slice(-12);
  const random = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const version = `7${random.slice(0, 3)}`;
  const variantByte = ((parseInt(random.slice(3, 5), 16) & 0b0011_1111) |
    0b1000_0000)
    .toString(16)
    .padStart(2, "0");
  const variant = `${variantByte}${random.slice(5, 7)}`;
  const node = random.slice(7, 19).padEnd(12, "0");

  return `${timestamp.slice(0, 8)}-${timestamp.slice(
    8,
    12,
  )}-${version}-${variant}-${node}` as OperationId;
}
