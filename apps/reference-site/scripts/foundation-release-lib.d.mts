// Types for the shared scaffold/sync library. The runtime is
// `foundation-release-lib.mjs`; these declarations let TypeScript consumers
// (such as the operator's lockstep test) import it without an implicit `any`.

export function isTemplatePath(path: string): boolean;

export function parseReleaseArguments(
  argv: ReadonlyArray<string>,
  options?: {
    required?: ReadonlyArray<string>;
    booleans?: ReadonlyArray<string>;
  },
): Record<string, string | true>;

export function tarEntries(archive: Uint8Array): Map<string, Uint8Array>;

export function assertLockedReleaseExecutable(args: {
  descriptor: unknown;
  lock: unknown;
  name: string;
}): void;

export function writeInstallationBuildConfiguration(args: {
  target: string;
  descriptor: unknown;
  packageRoot: string;
}): Promise<void>;
