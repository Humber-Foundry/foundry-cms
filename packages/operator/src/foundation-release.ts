/// <reference types="node" />

import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import { OperatorError } from "./operator-errors";

export const foundationReleaseSchemaVersion =
  "foundry.foundation-release/v1";

export const foundationPackageNames = Object.freeze([
  "@foundry/application",
  "@foundry/operator",
  "@foundry/reference-site",
  "@foundry/site-definition",
] as const);

export type FoundationPackageName = (typeof foundationPackageNames)[number];

export type FoundationReleaseArtifact = Readonly<{
  name: FoundationPackageName;
  version: string;
  filename: string;
  size: number;
  integrity: string;
  sha256: string;
}>;

export type FoundationReleaseDescriptor = Readonly<{
  schemaVersion: typeof foundationReleaseSchemaVersion;
  version: string;
  source: Readonly<{
    repository: string;
    revision: string;
  }>;
  compatibility: Readonly<{
    node: string;
    npm: string;
    packageManager: string;
  }>;
  migrations: Readonly<{
    latest: string;
    files: ReadonlyArray<Readonly<{ path: string; sha256: string }>>;
  }>;
  artifacts: Readonly<Record<FoundationPackageName, FoundationReleaseArtifact>>;
  provenance: Readonly<{
    builderWorkflow: string;
    sourceRevision: string;
    subjects: ReadonlyArray<
      Readonly<{ name: FoundationPackageName; sha256: string }>
    >;
  }>;
}>;

export class FoundationReleaseError extends OperatorError {}

const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const revisionPattern = /^[0-9a-f]{40}$/u;
const sha256Pattern = /^[0-9a-f]{64}$/u;
const integrityPattern = /^sha512-[A-Za-z0-9+/]{86}==$/u;
const migrationPathPattern =
  /^apps\/reference-site\/migrations\/\d{4}_[a-z0-9_]+\.sql$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: ReadonlyArray<string>,
): boolean {
  return (
    Object.keys(value).sort().join("\0") === [...expected].sort().join("\0")
  );
}

function fail(code: string): never {
  throw new FoundationReleaseError(code);
}

/**
 * Parses the generated release descriptor as hostile input. The operator never
 * trusts a version, filename or digest merely because it came from a release
 * workflow; every field is shape-checked before artifact bytes are opened.
 */
export function parseFoundationReleaseDescriptor(
  source: string,
): FoundationReleaseDescriptor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    fail("foundation_release_descriptor_unparsable");
  }
  if (!isRecord(parsed)) fail("foundation_release_descriptor_invalid");
  if (
    !hasExactKeys(parsed, [
      "schemaVersion",
      "version",
      "source",
      "compatibility",
      "migrations",
      "artifacts",
      "provenance",
    ]) ||
    parsed.schemaVersion !== foundationReleaseSchemaVersion ||
    typeof parsed.version !== "string" ||
    !versionPattern.test(parsed.version)
  ) {
    fail("foundation_release_descriptor_invalid");
  }
  const version = parsed.version;
  const sourceRecord = parsed.source;
  const compatibility = parsed.compatibility;
  const migrations = parsed.migrations;
  const artifacts = parsed.artifacts;
  const provenance = parsed.provenance;
  if (
    !isRecord(sourceRecord) ||
    !hasExactKeys(sourceRecord, ["repository", "revision"]) ||
    sourceRecord.repository !==
      "https://github.com/Humber-Foundry/foundry-cms" ||
    typeof sourceRecord.revision !== "string" ||
    !revisionPattern.test(sourceRecord.revision) ||
    !isRecord(compatibility) ||
    !hasExactKeys(compatibility, ["node", "npm", "packageManager"]) ||
    !Object.values(compatibility).every(
      (value) => typeof value === "string" && value.length > 0,
    ) ||
    !isRecord(migrations) ||
    !hasExactKeys(migrations, ["latest", "files"]) ||
    typeof migrations.latest !== "string" ||
    !/^\d{4}$/u.test(migrations.latest) ||
    !Array.isArray(migrations.files) ||
    migrations.files.length === 0 ||
    !isRecord(artifacts) ||
    !hasExactKeys(artifacts, foundationPackageNames) ||
    !isRecord(provenance) ||
    !hasExactKeys(provenance, [
      "builderWorkflow",
      "sourceRevision",
      "subjects",
    ]) ||
    provenance.builderWorkflow !==
      "https://github.com/Humber-Foundry/foundry-cms/actions/workflows/foundation-release.yml" ||
    provenance.sourceRevision !== sourceRecord.revision ||
    !Array.isArray(provenance.subjects)
  ) {
    fail("foundation_release_descriptor_invalid");
  }

  const migrationPaths = new Set<string>();
  for (const migration of migrations.files) {
    if (
      !isRecord(migration) ||
      !hasExactKeys(migration, ["path", "sha256"]) ||
      typeof migration.path !== "string" ||
      !migrationPathPattern.test(migration.path) ||
      typeof migration.sha256 !== "string" ||
      !sha256Pattern.test(migration.sha256) ||
      migrationPaths.has(migration.path)
    ) {
      fail("foundation_release_migrations_invalid");
    }
    migrationPaths.add(migration.path);
  }
  const orderedMigrations = migrations.files.map((entry) =>
    (entry as { path: string }).path,
  );
  if (
    [...orderedMigrations].sort().join("\0") !==
      orderedMigrations.join("\0") ||
    !basename(orderedMigrations.at(-1) ?? "").startsWith(
      `${migrations.latest}_`,
    )
  ) {
    fail("foundation_release_migrations_invalid");
  }

  const filenames = new Set<string>();
  for (const name of foundationPackageNames) {
    const artifact = artifacts[name];
    if (
      !isRecord(artifact) ||
      !hasExactKeys(artifact, [
        "name",
        "version",
        "filename",
        "size",
        "integrity",
        "sha256",
      ]) ||
      artifact.name !== name ||
      artifact.version !== version ||
      typeof artifact.filename !== "string" ||
      basename(artifact.filename) !== artifact.filename ||
      !artifact.filename.endsWith(".tgz") ||
      filenames.has(artifact.filename) ||
      !Number.isSafeInteger(artifact.size) ||
      (artifact.size as number) <= 0 ||
      typeof artifact.integrity !== "string" ||
      !integrityPattern.test(artifact.integrity) ||
      typeof artifact.sha256 !== "string" ||
      !sha256Pattern.test(artifact.sha256)
    ) {
      fail("foundation_release_artifact_invalid");
    }
    filenames.add(artifact.filename);
  }

  if (provenance.subjects.length !== foundationPackageNames.length) {
    fail("foundation_release_provenance_invalid");
  }
  for (const [index, name] of foundationPackageNames.entries()) {
    const subject = provenance.subjects[index];
    const artifact = artifacts[name] as Record<string, unknown>;
    if (
      !isRecord(subject) ||
      !hasExactKeys(subject, ["name", "sha256"]) ||
      subject.name !== name ||
      subject.sha256 !== artifact.sha256
    ) {
      fail("foundation_release_provenance_invalid");
    }
  }

  return parsed as FoundationReleaseDescriptor;
}

export function computeFoundationReleaseDescriptorDigest(source: string): string {
  return `sha256:${createHash("sha256").update(source).digest("hex")}`;
}

export function assertFoundationReleaseDescriptorDigest({
  source,
  expectedDigest,
}: {
  source: string;
  expectedDigest: string;
}): void {
  const actual = Buffer.from(computeFoundationReleaseDescriptorDigest(source));
  const expected = Buffer.from(expectedDigest);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    fail("foundation_release_descriptor_digest_mismatch");
  }
}

export async function loadFoundationReleaseDescriptor({
  descriptorPath,
  expectedDigest,
}: {
  descriptorPath: string;
  expectedDigest: string;
}): Promise<FoundationReleaseDescriptor> {
  const source = await readFile(descriptorPath, "utf8");
  assertFoundationReleaseDescriptorDigest({ source, expectedDigest });
  return parseFoundationReleaseDescriptor(source);
}

export async function verifyFoundationReleaseArtifacts({
  descriptor,
  readArtifact,
}: {
  descriptor: FoundationReleaseDescriptor;
  readArtifact: (filename: string) => Promise<Uint8Array>;
}): Promise<void> {
  for (const name of foundationPackageNames) {
    const artifact = descriptor.artifacts[name];
    const bytes = await readArtifact(artifact.filename);
    const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (
      bytes.byteLength !== artifact.size ||
      integrity !== artifact.integrity ||
      sha256 !== artifact.sha256
    ) {
      fail(`foundation_release_artifact_mismatch:${name}`);
    }
  }
}
