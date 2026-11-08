// Compares an installation's files before and after a sync. The sync tests and
// `release:verify` use it to prove that a sync changes no file its report does
// not name. It is not packed into a release.

import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

/**
 * Returns installation-relative path to sha256 for every file under
 * `directory`. Top-level directories named in `skip` are not read.
 */
export async function installationFileHashes(directory, { skip = [] } = {}) {
  const hashes = new Map();
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (current === directory && skip.includes(entry.name)) continue;
        await walk(path);
      } else {
        hashes.set(
          relative(directory, path),
          createHash("sha256").update(await readFile(path)).digest("hex"),
        );
      }
    }
  }
  await walk(directory);
  return hashes;
}

/** Returns, sorted, every path that was added, removed or changed. */
export function changedPaths(before, after) {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((path) => before.get(path) !== after.get(path))
    .sort();
}

/** Returns, sorted, the paths a sync report names on a write, add or remove line. */
export function reportedChanges(report) {
  return report
    .split("\n")
    .flatMap((line) => /^(?:write|add|remove)\s+(\S+)/u.exec(line)?.[1] ?? [])
    .sort();
}
