// Types for `installation-file-changes.mjs`, so the operator's TypeScript
// tests can import it without an implicit `any`.

export function installationFileHashes(
  directory: string,
  options?: { skip?: ReadonlyArray<string> },
): Promise<Map<string, string>>;

export function changedPaths(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): string[];

export function reportedChanges(report: string): string[];
