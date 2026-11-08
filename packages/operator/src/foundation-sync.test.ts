import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isTemplatePath } from "../../../apps/reference-site/scripts/foundation-release-lib.mjs";

import {
  parseFoundationFrameworkManifest,
  planFoundationSync,
  reconcileFoundationFramework,
  renderFoundationSyncReport,
} from "./foundation-sync";

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function file(path: string, content: string) {
  return { path, sha256: sha256(content) };
}

describe("foundation framework manifest", () => {
  it("accepts a sorted, unique manifest of framework paths", () => {
    const manifest = parseFoundationFrameworkManifest({
      files: [
        { path: "app/layout.tsx", sha256: "a".repeat(64) },
        { path: "foundry/README.md", sha256: "b".repeat(64) },
        { path: "migrations/0001_init.sql", sha256: "c".repeat(64) },
        { path: "next.config.ts", sha256: "d".repeat(64) },
      ],
    });
    expect(manifest.files).toHaveLength(4);
  });

  it("rejects a non-framework path", () => {
    expect(() =>
      parseFoundationFrameworkManifest({
        files: [{ path: "secret/keys.txt", sha256: "a".repeat(64) }],
      }),
    ).toThrow(/foundation_release_framework_invalid/u);
  });

  it("rejects a traversal path", () => {
    expect(() =>
      parseFoundationFrameworkManifest({
        files: [{ path: "app/../../etc/passwd", sha256: "a".repeat(64) }],
      }),
    ).toThrow(/foundation_release_framework_invalid/u);
  });

  it("stays in lockstep with the shared isTemplatePath classifier", () => {
    // The manifest validator and the scaffold/prepare classifier must agree on
    // which well-formed paths are framework source; otherwise prepare could
    // record a path the validator rejects, or the reverse. (The validator is
    // deliberately stricter on hostile input such as traversal.)
    const wellFormed = [
      "app/layout.tsx",
      "components/Button.tsx",
      "src/lib/util.ts",
      "migrations/0001_init.sql",
      "public/logo.svg",
      "foundry/README.md",
      "custom-worker.ts",
      "cloudflare-email.d.ts",
      "next-env.d.ts",
      "next.config.ts",
      "open-next.config.ts",
      "wrangler.jsonc",
      "wrangler.recovery.jsonc",
      "package.json",
      "tsconfig.json",
      "LICENSE",
      "README.md",
      "scripts/scaffold-foundation-release.mjs",
      "docs/notes.md",
    ];
    for (const path of wellFormed) {
      let accepted = true;
      try {
        parseFoundationFrameworkManifest({
          files: [{ path, sha256: "a".repeat(64) }],
        });
      } catch {
        accepted = false;
      }
      expect(accepted).toBe(isTemplatePath(path));
    }
  });

  it("rejects an unsorted or duplicated manifest", () => {
    expect(() =>
      parseFoundationFrameworkManifest({
        files: [
          { path: "src/b.ts", sha256: "a".repeat(64) },
          { path: "src/a.ts", sha256: "b".repeat(64) },
        ],
      }),
    ).toThrow(/foundation_release_framework_invalid/u);
    expect(() =>
      parseFoundationFrameworkManifest({
        files: [
          { path: "src/a.ts", sha256: "a".repeat(64) },
          { path: "src/a.ts", sha256: "b".repeat(64) },
        ],
      }),
    ).toThrow(/foundation_release_framework_invalid/u);
  });
});

describe("planFoundationSync three-way reconciliation", () => {
  it("overwrites a file the installation never changed", () => {
    const old = [file("app/page.tsx", "A")];
    const next = [file("app/page.tsx", "B")];
    const plan = planFoundationSync({
      oldFiles: old,
      newFiles: next,
      installationHashes: new Map([["app/page.tsx", sha256("A")]]),
    });
    expect(plan.entries).toContainEqual({
      path: "app/page.tsx",
      disposition: "updated",
    });
    expect(plan.toWrite).toContain("app/page.tsx");
    expect(plan.blocked).toBe(false);
  });

  it("reports a conflict and keeps the local file when both sides changed", () => {
    const old = [file("app/page.tsx", "A")];
    const next = [file("app/page.tsx", "B")];
    const plan = planFoundationSync({
      oldFiles: old,
      newFiles: next,
      installationHashes: new Map([["app/page.tsx", sha256("LOCAL")]]),
    });
    expect(plan.conflicts).toEqual(["app/page.tsx"]);
    expect(plan.toWrite).not.toContain("app/page.tsx");
    expect(plan.blocked).toBe(true);
  });

  it("does not block a conflict when the operator accepts conflicts", () => {
    const old = [file("app/page.tsx", "A")];
    const next = [file("app/page.tsx", "B")];
    const plan = planFoundationSync({
      oldFiles: old,
      newFiles: next,
      installationHashes: new Map([["app/page.tsx", sha256("LOCAL")]]),
      acceptConflicts: true,
    });
    expect(plan.conflicts).toEqual(["app/page.tsx"]);
    expect(plan.blocked).toBe(false);
    expect(plan.toWrite).not.toContain("app/page.tsx");
  });

  it("keeps a local override the target release did not change", () => {
    const old = [file("app/page.tsx", "A")];
    const next = [file("app/page.tsx", "A")];
    const plan = planFoundationSync({
      oldFiles: old,
      newFiles: next,
      installationHashes: new Map([["app/page.tsx", sha256("LOCAL")]]),
    });
    expect(plan.keptOverrides).toEqual(["app/page.tsx"]);
    expect(plan.blocked).toBe(false);
  });

  it("adds a file new in the target and removes an unmodified deletion", () => {
    const old = [file("src/gone.ts", "OLD")];
    const next = [file("src/new.ts", "NEW")];
    const plan = planFoundationSync({
      oldFiles: old,
      newFiles: next,
      installationHashes: new Map([
        ["src/gone.ts", sha256("OLD")],
        ["src/new.ts", null],
      ]),
    });
    expect(plan.toWrite).toContain("src/new.ts");
    expect(plan.toRemove).toContain("src/gone.ts");
  });

  it("keeps a locally modified file the target removed", () => {
    const old = [file("src/gone.ts", "OLD")];
    const next: Array<{ path: string; sha256: string }> = [];
    const plan = planFoundationSync({
      oldFiles: old,
      newFiles: next,
      installationHashes: new Map([["src/gone.ts", sha256("CHANGED")]]),
    });
    expect(plan.removedButModified).toEqual(["src/gone.ts"]);
    expect(plan.toRemove).not.toContain("src/gone.ts");
  });

  it("never touches an installation-owned foundry path", () => {
    const old = [file("foundry/site-definition.ts", "A")];
    const next = [file("foundry/site-definition.ts", "B")];
    const plan = planFoundationSync({
      oldFiles: old,
      newFiles: next,
      installationHashes: new Map([
        ["foundry/site-definition.ts", sha256("LOCAL")],
      ]),
    });
    expect(plan.toWrite).not.toContain("foundry/site-definition.ts");
    expect(plan.toRemove).not.toContain("foundry/site-definition.ts");
    expect(plan.conflicts).not.toContain("foundry/site-definition.ts");
    expect(plan.entries).toContainEqual({
      path: "foundry/site-definition.ts",
      disposition: "skipped-installation-owned",
    });
  });

  it("adds a new migration but never rewrites an existing one", () => {
    const old = [file("migrations/0001_init.sql", "one")];
    const next = [
      file("migrations/0001_init.sql", "one"),
      file("migrations/0002_next.sql", "two"),
    ];
    const plan = planFoundationSync({
      oldFiles: old,
      newFiles: next,
      installationHashes: new Map([
        ["migrations/0001_init.sql", sha256("one")],
        ["migrations/0002_next.sql", null],
      ]),
    });
    expect(plan.toWrite).toContain("migrations/0002_next.sql");
    expect(plan.entries).toContainEqual({
      path: "migrations/0002_next.sql",
      disposition: "migration-added",
    });
  });

  it("fails closed when an existing migration does not match the target", () => {
    const old = [file("migrations/0001_init.sql", "one")];
    const next = [file("migrations/0001_init.sql", "one-tampered")];
    const plan = planFoundationSync({
      oldFiles: old,
      newFiles: next,
      installationHashes: new Map([
        ["migrations/0001_init.sql", sha256("one")],
      ]),
      acceptConflicts: true,
    });
    expect(plan.migrationMismatches).toEqual(["migrations/0001_init.sql"]);
    // A migration mismatch is a hard stop even when conflicts are accepted.
    expect(plan.blocked).toBe(true);
    expect(plan.toWrite).not.toContain("migrations/0001_init.sql");
  });

  it("keeps a past migration the target no longer lists", () => {
    const old = [file("migrations/0001_init.sql", "one")];
    const next: Array<{ path: string; sha256: string }> = [];
    const plan = planFoundationSync({
      oldFiles: old,
      newFiles: next,
      installationHashes: new Map([
        ["migrations/0001_init.sql", sha256("one")],
      ]),
    });
    expect(plan.toRemove).not.toContain("migrations/0001_init.sql");
    expect(plan.entries).toContainEqual({
      path: "migrations/0001_init.sql",
      disposition: "migration-removed-upstream-kept",
    });
  });
});

describe("planFoundationSync derived files", () => {
  const manifest = [file("app/page.tsx", "A")];
  const hashes = (entries: Array<[string, string | null]>) =>
    new Map<string, string | null>([["app/page.tsx", sha256("A")], ...entries]);

  it("writes and reports a derived file whose bytes change", () => {
    const plan = planFoundationSync({
      oldFiles: manifest,
      newFiles: manifest,
      installationHashes: hashes([["package.json", sha256("old")]]),
      derivedFiles: [
        { path: "package.json", sha256: sha256("new"), note: "build configuration" },
      ],
    });
    expect(plan.derivedWrites).toEqual(["package.json"]);
    expect(plan.entries).toContainEqual({
      path: "package.json",
      disposition: "derived-written",
      note: "build configuration",
    });
    expect(renderFoundationSyncReport(plan)).toContain(
      "write    package.json (build configuration)\n1 written,",
    );
  });

  it("leaves out a derived file whose bytes are already current", () => {
    const plan = planFoundationSync({
      oldFiles: manifest,
      newFiles: manifest,
      installationHashes: hashes([["package.json", sha256("same")]]),
      derivedFiles: [
        { path: "package.json", sha256: sha256("same"), note: "build configuration" },
      ],
    });
    expect(plan.derivedWrites).toEqual([]);
    expect(renderFoundationSyncReport(plan)).toBe(
      "0 written, 0 removed, 0 kept as override, 0 conflict(s), " +
        "0 kept after upstream removal, 0 migration mismatch(es)\n",
    );
  });

  it("rejects a derived file that is also framework source", () => {
    expect(() =>
      planFoundationSync({
        oldFiles: manifest,
        newFiles: manifest,
        installationHashes: hashes([]),
        derivedFiles: [{ path: "app/page.tsx", sha256: sha256("B"), note: "x" }],
      }),
    ).toThrow(/foundation_sync_derived_path_invalid/u);
  });
});

describe("reconcileFoundationFramework applied to a fixture installation", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "foundry-sync-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function write(path: string, content: string) {
    const full = join(root, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  }

  async function exists(path: string): Promise<boolean> {
    try {
      await stat(join(root, path));
      return true;
    } catch {
      return false;
    }
  }

  it("updates untouched files, preserves overrides, reports conflicts and leaves owned paths", async () => {
    // Release A (the pinned installation).
    const releaseA = new Map<string, string>([
      ["app/untouched.tsx", "A-untouched"],
      ["app/override.tsx", "A-override"],
      ["src/conflict.ts", "A-conflict"],
      ["src/removed.ts", "A-removed"],
      ["migrations/0001_init.sql", "A-migration-1"],
      ["foundry/site-definition.ts", "A-owned"],
    ]);
    // Release B (the sync target).
    const releaseB = new Map<string, string>([
      ["app/untouched.tsx", "B-untouched"], // changed upstream, unchanged locally -> update
      ["app/override.tsx", "A-override"], // unchanged upstream -> keep local override
      ["src/conflict.ts", "B-conflict"], // changed both sides -> conflict
      ["app/added.tsx", "B-added"], // new in target -> add
      ["migrations/0001_init.sql", "A-migration-1"], // unchanged
      ["migrations/0002_next.sql", "B-migration-2"], // additive migration
      ["foundry/site-definition.ts", "B-owned"], // owned; must not be touched
    ]);

    const oldFiles = [...releaseA].map(([path, content]) => file(path, content));
    const newFiles = [...releaseB].map(([path, content]) => file(path, content));

    // Scaffold the fixture installation from release A.
    for (const [path, content] of releaseA) {
      await write(path, content);
    }
    // Local installation work.
    await write("app/override.tsx", "LOCAL-override");
    await write("src/conflict.ts", "LOCAL-conflict");
    await write("foundry/site-definition.ts", "LOCAL-owned");
    // A client media asset under public/ that no manifest lists.
    await write("public/media/photo.bin", "client-photo-bytes");

    const targetFiles = new Map<string, Uint8Array>(
      [...releaseB].map(([path, content]) => [path, Buffer.from(content)]),
    );

    const result = await reconcileFoundationFramework({
      installationDir: root,
      targetFiles,
      oldFiles,
      newFiles,
      acceptConflicts: true,
    });

    // Untouched framework file is updated to the target.
    expect(await readFile(join(root, "app/untouched.tsx"), "utf8")).toBe(
      "B-untouched",
    );
    // Local override is preserved.
    expect(await readFile(join(root, "app/override.tsx"), "utf8")).toBe(
      "LOCAL-override",
    );
    // Conflict keeps the local file and is reported.
    expect(await readFile(join(root, "src/conflict.ts"), "utf8")).toBe(
      "LOCAL-conflict",
    );
    expect(result.plan.conflicts).toEqual(["src/conflict.ts"]);
    // New file added.
    expect(await readFile(join(root, "app/added.tsx"), "utf8")).toBe("B-added");
    // Unmodified deletion removed.
    expect(await exists("src/removed.ts")).toBe(false);
    // Additive migration added; existing migration retained.
    expect(await readFile(join(root, "migrations/0002_next.sql"), "utf8")).toBe(
      "B-migration-2",
    );
    expect(await readFile(join(root, "migrations/0001_init.sql"), "utf8")).toBe(
      "A-migration-1",
    );
    // Installation-owned foundry path untouched.
    expect(await readFile(join(root, "foundry/site-definition.ts"), "utf8")).toBe(
      "LOCAL-owned",
    );
    // Client media untouched.
    expect(await readFile(join(root, "public/media/photo.bin"), "utf8")).toBe(
      "client-photo-bytes",
    );

    const report = renderFoundationSyncReport(result.plan);
    expect(report).toContain("app/untouched.tsx");
    expect(report).toContain("src/conflict.ts");
    expect(report).toContain("app/added.tsx");
    expect(report).toContain("migrations/0002_next.sql");
  });

  async function snapshot(): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    async function walk(directory: string) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await walk(path);
        else result.set(relative(root, path), sha256(await readFile(path)));
      }
    }
    await walk(root);
    return result;
  }

  function changed(before: Map<string, string>, after: Map<string, string>) {
    return [...new Set([...before.keys(), ...after.keys()])]
      .filter((path) => before.get(path) !== after.get(path))
      .sort();
  }

  function reported(report: string): string[] {
    return report
      .split("\n")
      .flatMap((line) => /^(?:write|add|remove)\s+(\S+)/u.exec(line)?.[1] ?? [])
      .sort();
  }

  it("names every file it changes, derived files included, in its report", async () => {
    const releaseA = new Map([
      ["app/page.tsx", "A-page"],
      ["src/removed.ts", "A-removed"],
      ["tsconfig.json", "A-tsconfig"],
    ]);
    const releaseB = new Map([
      ["app/page.tsx", "B-page"],
      ["app/added.tsx", "B-added"],
      ["tsconfig.json", "B-tsconfig"],
    ]);
    for (const [path, content] of releaseA) await write(path, content);
    await write("package.json", "old-package");
    await write(".foundry-foundation-release.json", "old-pin");
    const before = await snapshot();

    const result = await reconcileFoundationFramework({
      installationDir: root,
      targetFiles: new Map(
        [...releaseB].map(([path, content]) => [path, Buffer.from(content)]),
      ),
      oldFiles: [...releaseA].map(([path, content]) => file(path, content)),
      newFiles: [...releaseB].map(([path, content]) => file(path, content)),
      derivedFiles: [
        { path: "package.json", bytes: Buffer.from("new-package"), note: "build" },
        {
          path: ".foundry-foundation-release.json",
          bytes: Buffer.from("new-pin"),
          note: "release pin",
        },
        { path: ".foundry/installation.json", bytes: Buffer.from("pin"), note: "release pin" },
      ],
    });

    const changes = changed(before, await snapshot());
    expect(changes).toEqual([
      ".foundry-foundation-release.json",
      ".foundry/installation.json",
      "app/added.tsx",
      "app/page.tsx",
      "package.json",
      "src/removed.ts",
      "tsconfig.json",
    ]);
    expect(reported(result.report)).toEqual(changes);
    expect(result.report).toContain("\n6 written, 1 removed,");
  });

  it("writes no derived file while a conflict blocks the sync", async () => {
    await write("app/page.tsx", "LOCAL-page");
    await write("package.json", "old-package");
    const before = await snapshot();

    const result = await reconcileFoundationFramework({
      installationDir: root,
      targetFiles: new Map([["app/page.tsx", Buffer.from("B-page")]]),
      oldFiles: [file("app/page.tsx", "A-page")],
      newFiles: [file("app/page.tsx", "B-page")],
      derivedFiles: [
        { path: "package.json", bytes: Buffer.from("new-package"), note: "build" },
      ],
    });

    expect(result.plan.blocked).toBe(true);
    expect(changed(before, await snapshot())).toEqual([]);
  });
});
