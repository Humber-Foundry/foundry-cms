/// <reference types="node" />

/**
 * Three-way reconciliation for the source-sync half of a foundation upgrade.
 *
 * The scaffold lays a foundation release's framework files into a new
 * installation once, create-only. This module updates an existing installation
 * to a newer release without discarding installation-owned work. It compares
 * three sides for every framework path — the installation's current file, the
 * file in the release it is pinned to (old), and the file in the target release
 * (new) — and decides one disposition per path. See
 * `docs/decisions/ADR-0015-foundation-framework-sync-seam.md`.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { OperatorError } from "./operator-errors";

export class FoundationSyncError extends OperatorError {}

export type FrameworkManifestFile = Readonly<{ path: string; sha256: string }>;

export type FoundationFrameworkManifest = Readonly<{
  files: ReadonlyArray<FrameworkManifestFile>;
}>;

const sha256Pattern = /^[0-9a-f]{64}$/u;

/**
 * The framework classification, matching the scaffold's `isTemplatePath`. It is
 * a shape check on hostile descriptor input, not the source classifier: the
 * scaffold and `release:prepare` share one `isTemplatePath` for deciding which
 * files ship, and this validator independently rejects any manifest path that
 * is not a well-formed member of that set, exactly as `migrationPathPattern`
 * re-states the migration path shape.
 */
const frameworkPathPattern =
  /^(?:(?:app|components|foundry|migrations|public|src)\/.+|custom-worker\.ts|cloudflare-email\.d\.ts|next-env\.d\.ts|next\.config\.ts|open-next\.config\.ts|tsconfig\.json|wrangler\.jsonc|wrangler\.recovery\.jsonc)$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFrameworkPathSafe(path: string): boolean {
  return (
    frameworkPathPattern.test(path) &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    !path.startsWith("/") &&
    !path.endsWith("/") &&
    !path.split("/").some((segment) => segment === "" || segment === "..")
  );
}

/**
 * Whether a manifest path is installation-owned and must never be written,
 * removed or reported as a conflict by sync. The scaffold seeds `foundry/`
 * once, create-only; from then on the installation owns it. Client media under
 * `public/` is protected differently: it is simply never in the manifest, so
 * the reconciliation loop never visits it.
 */
export function isInstallationOwnedPath(path: string): boolean {
  return path === "foundry" || path.startsWith("foundry/");
}

function isMigrationPath(path: string): boolean {
  return path.startsWith("migrations/");
}

/**
 * Parses the framework manifest embedded in a release descriptor as hostile
 * input. Order and uniqueness matter: an out-of-order or duplicated manifest is
 * rejected rather than silently reduced.
 */
export function parseFoundationFrameworkManifest(
  value: unknown,
): FoundationFrameworkManifest {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join("\0") !== "files" ||
    !Array.isArray(value.files) ||
    value.files.length === 0
  ) {
    throw new FoundationSyncError("foundation_release_framework_invalid");
  }
  const paths = new Set<string>();
  const files: FrameworkManifestFile[] = [];
  for (const entry of value.files) {
    if (
      !isRecord(entry) ||
      Object.keys(entry).sort().join("\0") !== "path\0sha256" ||
      typeof entry.path !== "string" ||
      !isFrameworkPathSafe(entry.path) ||
      typeof entry.sha256 !== "string" ||
      !sha256Pattern.test(entry.sha256) ||
      paths.has(entry.path)
    ) {
      throw new FoundationSyncError("foundation_release_framework_invalid");
    }
    paths.add(entry.path);
    files.push({ path: entry.path, sha256: entry.sha256 });
  }
  const ordered = files.map((entry) => entry.path);
  if ([...ordered].sort().join("\0") !== ordered.join("\0")) {
    throw new FoundationSyncError("foundation_release_framework_invalid");
  }
  return Object.freeze({ files: Object.freeze(files) });
}

export type FrameworkFileDisposition =
  | "unchanged"
  | "updated"
  | "added"
  | "removed"
  | "kept-override"
  | "conflict"
  | "removed-modified"
  | "absent"
  | "skipped-installation-owned"
  | "migration-added"
  | "migration-present"
  | "migration-removed-upstream-kept"
  | "migration-mismatch"
  | "derived-written"
  | "derived-unchanged";

export type FrameworkReconciliationEntry = Readonly<{
  path: string;
  disposition: FrameworkFileDisposition;
  note?: string;
}>;

/**
 * A file the sync derives from the target release instead of copying it from
 * the framework source: the installation's `package.json` build configuration
 * and the release pin files. It is written only when its bytes change, and
 * every write is reported like a framework write.
 */
export type DerivedInstallationFile = Readonly<{
  path: string;
  bytes: Uint8Array;
  note: string;
}>;

/** A derived file as the pure planner sees it: the sha256 of its new bytes. */
export type DerivedFileHash = Readonly<{
  path: string;
  sha256: string;
  note: string;
}>;

export type FoundationSyncPlan = Readonly<{
  entries: ReadonlyArray<FrameworkReconciliationEntry>;
  toWrite: ReadonlyArray<string>;
  derivedWrites: ReadonlyArray<string>;
  toRemove: ReadonlyArray<string>;
  conflicts: ReadonlyArray<string>;
  keptOverrides: ReadonlyArray<string>;
  removedButModified: ReadonlyArray<string>;
  migrationMismatches: ReadonlyArray<string>;
  blocked: boolean;
}>;

function toMap(
  files: ReadonlyArray<FrameworkManifestFile>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of files) {
    map.set(entry.path, entry.sha256);
  }
  return map;
}

/**
 * The pure three-way rule. `installationHashes` maps every union path, and
 * every derived path, to the installation's current sha256, or `null` when the
 * file is absent. `derivedFiles` lists the files the sync derives from the
 * target release, each with the sha256 of its new bytes. Nothing here touches
 * the filesystem, so every branch is exhaustively testable.
 */
export function planFoundationSync({
  oldFiles,
  newFiles,
  installationHashes,
  derivedFiles = [],
  acceptConflicts = false,
}: {
  oldFiles: ReadonlyArray<FrameworkManifestFile>;
  newFiles: ReadonlyArray<FrameworkManifestFile>;
  installationHashes: ReadonlyMap<string, string | null>;
  derivedFiles?: ReadonlyArray<DerivedFileHash>;
  acceptConflicts?: boolean;
}): FoundationSyncPlan {
  const oldMap = toMap(oldFiles);
  const newMap = toMap(newFiles);
  const paths = [...new Set([...oldMap.keys(), ...newMap.keys()])].sort();
  // A derived file is never framework source. If a manifest listed one, the
  // three-way rule and the derived write would both claim the same path.
  if (
    new Set(derivedFiles.map((file) => file.path)).size !==
      derivedFiles.length ||
    derivedFiles.some(
      (file) => oldMap.has(file.path) || newMap.has(file.path),
    )
  ) {
    throw new FoundationSyncError("foundation_sync_derived_path_invalid");
  }

  const entries: FrameworkReconciliationEntry[] = [];
  const toWrite: string[] = [];
  const derivedWrites: string[] = [];
  const toRemove: string[] = [];
  const conflicts: string[] = [];
  const keptOverrides: string[] = [];
  const removedButModified: string[] = [];
  const migrationMismatches: string[] = [];

  const record = (path: string, disposition: FrameworkFileDisposition) => {
    entries.push({ path, disposition });
  };

  for (const path of paths) {
    if (isInstallationOwnedPath(path)) {
      record(path, "skipped-installation-owned");
      continue;
    }
    const oldHash = oldMap.get(path);
    const newHash = newMap.get(path);
    const current = installationHashes.get(path) ?? null;

    if (isMigrationPath(path)) {
      if (newHash === undefined) {
        // Removed upstream. A past migration is history; never delete it.
        record(path, "migration-removed-upstream-kept");
        continue;
      }
      if (current === null) {
        record(path, "migration-added");
        toWrite.push(path);
        continue;
      }
      if (current === newHash) {
        record(path, "migration-present");
        continue;
      }
      // Present but not byte-identical to the target. Migrations are immutable;
      // this is corruption or tampering. Hard stop, even with acceptConflicts.
      record(path, "migration-mismatch");
      migrationMismatches.push(path);
      continue;
    }

    if (newHash === undefined) {
      if (current === null) {
        record(path, "absent");
      } else if (current === oldHash) {
        record(path, "removed");
        toRemove.push(path);
      } else {
        record(path, "removed-modified");
        removedButModified.push(path);
      }
      continue;
    }

    if (current === newHash) {
      record(path, "unchanged");
      continue;
    }
    if (current === null) {
      record(path, "added");
      toWrite.push(path);
      continue;
    }
    if (oldHash !== undefined && current === oldHash) {
      record(path, "updated");
      toWrite.push(path);
      continue;
    }
    // Locally modified.
    if (oldHash !== undefined && oldHash === newHash) {
      record(path, "kept-override");
      keptOverrides.push(path);
      continue;
    }
    record(path, "conflict");
    conflicts.push(path);
  }

  for (const file of derivedFiles) {
    const current = installationHashes.get(file.path) ?? null;
    if (current === file.sha256) {
      entries.push({ path: file.path, disposition: "derived-unchanged" });
      continue;
    }
    entries.push({
      path: file.path,
      disposition: "derived-written",
      note: file.note,
    });
    derivedWrites.push(file.path);
  }

  const blocked =
    migrationMismatches.length > 0 ||
    (conflicts.length > 0 && !acceptConflicts);

  return Object.freeze({
    entries: Object.freeze(entries),
    toWrite: Object.freeze(toWrite),
    derivedWrites: Object.freeze(derivedWrites),
    toRemove: Object.freeze(toRemove),
    conflicts: Object.freeze(conflicts),
    keptOverrides: Object.freeze(keptOverrides),
    removedButModified: Object.freeze(removedButModified),
    migrationMismatches: Object.freeze(migrationMismatches),
    blocked,
  });
}

async function hashInstallationFile(
  installationDir: string,
  path: string,
): Promise<string | null> {
  try {
    const bytes = await readFile(join(installationDir, path));
    return createHash("sha256").update(bytes).digest("hex");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      (error as { code?: string }).code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

export type FoundationSyncResult = Readonly<{
  plan: FoundationSyncPlan;
  report: string;
}>;

/**
 * Reads the installation, computes the plan and applies it. `targetFiles` holds
 * the target release's framework bytes keyed by installation-relative path, and
 * must match `newFiles` exactly; a mismatch means the packed source and the
 * recorded manifest disagree and sync fails closed.
 *
 * `derivedFiles` are written after the framework files, in order, and only
 * when their bytes change. This function is the only place the sync writes or
 * removes an installation file, so the report it returns names every file the
 * sync changed.
 */
export async function reconcileFoundationFramework({
  installationDir,
  targetFiles,
  oldFiles,
  newFiles,
  derivedFiles = [],
  acceptConflicts = false,
}: {
  installationDir: string;
  targetFiles: ReadonlyMap<string, Uint8Array>;
  oldFiles: ReadonlyArray<FrameworkManifestFile>;
  newFiles: ReadonlyArray<FrameworkManifestFile>;
  derivedFiles?: ReadonlyArray<DerivedInstallationFile>;
  acceptConflicts?: boolean;
}): Promise<FoundationSyncResult> {
  // The manifest is authoritative: every non-owned target file must be present
  // in the byte source with the exact recorded hash.
  for (const entry of newFiles) {
    if (isInstallationOwnedPath(entry.path)) continue;
    const bytes = targetFiles.get(entry.path);
    if (
      bytes === undefined ||
      createHash("sha256").update(bytes).digest("hex") !== entry.sha256
    ) {
      throw new FoundationSyncError("foundation_sync_manifest_mismatch");
    }
  }

  const union = [
    ...new Set([
      ...oldFiles.map((entry) => entry.path),
      ...newFiles.map((entry) => entry.path),
    ]),
  ];
  const installationHashes = new Map<string, string | null>();
  for (const path of union) {
    if (isInstallationOwnedPath(path)) continue;
    installationHashes.set(
      path,
      await hashInstallationFile(installationDir, path),
    );
  }
  for (const file of derivedFiles) {
    installationHashes.set(
      file.path,
      await hashInstallationFile(installationDir, file.path),
    );
  }

  const plan = planFoundationSync({
    oldFiles,
    newFiles,
    installationHashes,
    derivedFiles: derivedFiles.map((file) => ({
      path: file.path,
      sha256: createHash("sha256").update(file.bytes).digest("hex"),
      note: file.note,
    })),
    acceptConflicts,
  });

  if (!plan.blocked) {
    for (const path of plan.toWrite) {
      const bytes = targetFiles.get(path);
      if (bytes === undefined) {
        throw new FoundationSyncError("foundation_sync_manifest_mismatch");
      }
      const destination = join(installationDir, path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, bytes);
    }
    for (const path of plan.toRemove) {
      await rm(join(installationDir, path), { force: true });
    }
    for (const file of derivedFiles) {
      if (!plan.derivedWrites.includes(file.path)) continue;
      const destination = join(installationDir, file.path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, file.bytes);
    }
  }

  return Object.freeze({ plan, report: renderFoundationSyncReport(plan) });
}

/**
 * A plain-language report of every decision, one file per line. The verbs are
 * fixed so an operator can scan for `conflict` or `migration-mismatch`.
 */
export function renderFoundationSyncReport(plan: FoundationSyncPlan): string {
  const label: Record<FrameworkFileDisposition, string> = {
    unchanged: "unchanged",
    updated: "write   ",
    added: "add     ",
    removed: "remove  ",
    "kept-override": "keep    ",
    conflict: "conflict",
    "removed-modified": "keep    ",
    absent: "absent  ",
    "skipped-installation-owned": "own     ",
    "migration-added": "add     ",
    "migration-present": "unchanged",
    "migration-removed-upstream-kept": "keep    ",
    "migration-mismatch": "mismatch",
    "derived-written": "write   ",
    "derived-unchanged": "unchanged",
  };
  const note: Partial<Record<FrameworkFileDisposition, string>> = {
    "kept-override": " (local override; unchanged in target)",
    conflict: " (changed in installation and target; installation kept)",
    "removed-modified": " (removed in target but modified locally; not deleted)",
    "skipped-installation-owned": " (installation-owned; not touched)",
    "migration-added": " (new migration)",
    "migration-removed-upstream-kept": " (past migration retained)",
    "migration-mismatch":
      " (present migration differs from target; sync stopped)",
  };
  // The report lists what sync did: files written, added, removed, kept as an
  // override and conflicts. An unchanged, absent or installation-owned path is
  // not an action, so it is left out of the per-file lines.
  const silent = new Set<FrameworkFileDisposition>([
    "unchanged",
    "absent",
    "skipped-installation-owned",
    "derived-unchanged",
  ]);
  const lines = plan.entries
    .filter((entry) => !silent.has(entry.disposition))
    .map((entry) => {
      const detail =
        entry.note === undefined ? note[entry.disposition] : ` (${entry.note})`;
      return `${label[entry.disposition]} ${entry.path}${detail ?? ""}`;
    });
  const written = plan.toWrite.length + plan.derivedWrites.length;
  const summary =
    `${written} written, ${plan.toRemove.length} removed, ` +
    `${plan.keptOverrides.length} kept as override, ` +
    `${plan.conflicts.length} conflict(s), ` +
    `${plan.removedButModified.length} kept after upstream removal, ` +
    `${plan.migrationMismatches.length} migration mismatch(es)`;
  return `${[...lines, summary].join("\n")}\n`;
}
