import { readFile } from "node:fs/promises";

import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach } from "vitest";

export type TestD1Database = Awaited<
  ReturnType<Miniflare["getD1Database"]>
>;

type DatabaseMigrationPlan = Readonly<Record<string, readonly string[]>>;

type TableSnapshot = {
  readonly name: string;
  readonly columns: readonly string[];
  readonly rows: readonly Record<string, unknown>[];
  readonly dependencies: readonly string[];
};

type DatabaseSnapshot = {
  readonly tablesInDependencyOrder: readonly TableSnapshot[];
  readonly triggers: readonly { name: string; sql: string }[];
};

type MigratedTestDatabaseOptions = {
  readonly compatibilityDate?: string;
};

export function createTestDatabaseRuntime(
  databaseNames: readonly string[],
  options: MigratedTestDatabaseOptions = {},
) {
  const runtime = new Miniflare({
    ...(options.compatibilityDate === undefined
      ? {}
      : { compatibilityDate: options.compatibilityDate }),
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    d1Databases: [...databaseNames],
  });

  return {
    getDatabase(name: string) {
      return runtime.getD1Database(name);
    },
    async dispose() {
      await runtime.dispose();
    },
  };
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

export function migrationStatements(migration: string): string[] {
  const statements: string[] = [];
  let current = "";
  let inTrigger = false;

  for (const line of migration.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("--")) continue;
    current += ` ${trimmed}`;
    if (trimmed.startsWith("CREATE TRIGGER")) inTrigger = true;
    if (
      (!inTrigger && trimmed.endsWith(";")) ||
      (inTrigger && trimmed === "END;")
    ) {
      statements.push(current.trim());
      current = "";
      inTrigger = false;
    }
  }

  return statements;
}

export async function migrateTestDatabase(
  database: TestD1Database,
  migrationNames: readonly string[],
): Promise<void> {
  for (const migrationName of migrationNames) {
    const migration = await readFile(
      new URL(`../../migrations/${migrationName}`, import.meta.url),
      "utf8",
    );
    for (const statement of migrationStatements(migration)) {
      await database.exec(statement);
    }
  }
}

function orderTablesByDependencies(
  tables: readonly TableSnapshot[],
): readonly TableSnapshot[] {
  const remaining = new Map(tables.map((table) => [table.name, table]));
  const ordered: TableSnapshot[] = [];

  while (remaining.size > 0) {
    const ready = [...remaining.values()].filter((table) =>
      table.dependencies.every(
        (dependency) =>
          dependency === table.name || !remaining.has(dependency),
      ),
    );
    if (ready.length === 0) {
      throw new Error(
        `Test database contains a foreign-key cycle: ${[
          ...remaining.keys(),
        ].join(", ")}`,
      );
    }
    ready.sort((left, right) => left.name.localeCompare(right.name));
    for (const table of ready) {
      remaining.delete(table.name);
      ordered.push(table);
    }
  }

  return ordered;
}

async function captureDatabaseSnapshot(
  database: TestD1Database,
): Promise<DatabaseSnapshot> {
  const { results: tableRows } = await database
    .prepare(
      `SELECT name
       FROM sqlite_master
       WHERE type = 'table'
         AND (name NOT LIKE 'sqlite_%' OR name = 'sqlite_sequence')
         AND name NOT LIKE '_cf_%'
       ORDER BY name`,
    )
    .all<{ name: string }>();

  const tables: TableSnapshot[] = [];
  for (const { name } of tableRows) {
    const quotedName = quoteIdentifier(name);
    const [columnResult, rowResult, foreignKeyResult] = await Promise.all([
      database
        .prepare(`PRAGMA table_info(${quotedName})`)
        .all<{ name: string }>(),
      database.prepare(`SELECT * FROM ${quotedName}`).all(),
      database
        .prepare(`PRAGMA foreign_key_list(${quotedName})`)
        .all<{ table: string }>(),
    ]);
    const columnRows = columnResult.results as { name: string }[];
    const foreignKeys = foreignKeyResult.results as { table: string }[];
    tables.push({
      name,
      columns: columnRows.map((column) => column.name),
      rows: rowResult.results as Record<string, unknown>[],
      dependencies: [...new Set(foreignKeys.map((key) => key.table))],
    });
  }

  const { results: triggerRows } = await database
    .prepare(
      `SELECT name, sql
       FROM sqlite_master
       WHERE type = 'trigger' AND sql IS NOT NULL
       ORDER BY rowid`,
    )
    .all<{ name: string; sql: string }>();

  return {
    tablesInDependencyOrder: orderTablesByDependencies(tables),
    triggers: triggerRows,
  };
}

async function resetDatabase(
  database: TestD1Database,
  snapshot: DatabaseSnapshot,
): Promise<void> {
  const { results: currentTriggers } = await database
    .prepare(
      `SELECT name
       FROM sqlite_master
       WHERE type = 'trigger'
       ORDER BY name`,
    )
    .all<{ name: string }>();

  for (const { name } of currentTriggers) {
    await database.exec(`DROP TRIGGER ${quoteIdentifier(name)}`);
  }

  const baselineNames = new Set(
    snapshot.tablesInDependencyOrder.map((table) => table.name),
  );
  const { results: currentTableRows } = await database
    .prepare(
      `SELECT name
       FROM sqlite_master
       WHERE type = 'table'
         AND (name NOT LIKE 'sqlite_%' OR name = 'sqlite_sequence')
         AND name NOT LIKE '_cf_%'
       ORDER BY name`,
    )
    .all<{ name: string }>();
  const extraTables: TableSnapshot[] = [];
  let hasExtraSequenceTable = false;
  for (const { name } of currentTableRows) {
    if (baselineNames.has(name)) continue;
    if (name === "sqlite_sequence") {
      hasExtraSequenceTable = true;
      continue;
    }
    const { results: foreignKeys } = await database
      .prepare(`PRAGMA foreign_key_list(${quoteIdentifier(name)})`)
      .all<{ table: string }>();
    extraTables.push({
      name,
      columns: [],
      rows: [],
      dependencies: (foreignKeys as { table: string }[]).map(
        (key) => key.table,
      ),
    });
  }
  for (const table of [...orderTablesByDependencies(extraTables)].reverse()) {
    await database.exec(`DROP TABLE ${quoteIdentifier(table.name)}`);
  }
  if (hasExtraSequenceTable) {
    await database.exec("DELETE FROM sqlite_sequence");
  }

  for (const table of [...snapshot.tablesInDependencyOrder].reverse()) {
    await database.exec(`DELETE FROM ${quoteIdentifier(table.name)}`);
  }

  for (const table of snapshot.tablesInDependencyOrder) {
    if (table.rows.length === 0) continue;
    const placeholders = table.columns.map((_, index) => `?${index + 1}`);
    const statement = database.prepare(
      `INSERT INTO ${quoteIdentifier(table.name)} (${table.columns
        .map(quoteIdentifier)
        .join(", ")}) VALUES (${placeholders.join(", ")})`,
    );
    await database.batch(
      table.rows.map((row) =>
        statement.bind(
          ...table.columns.map(
            (column) => row[column] as string | number | null | ArrayBuffer,
          ),
        ),
      ),
    );
  }

  for (const trigger of snapshot.triggers) {
    await database.exec(trigger.sql);
  }
}

export function useMigratedTestDatabase(
  migrations: readonly string[] | DatabaseMigrationPlan,
  options: MigratedTestDatabaseOptions = {},
) {
  const plan: DatabaseMigrationPlan = Array.isArray(migrations)
    ? { FOUNDRY_DB: [...migrations] }
    : (migrations as DatabaseMigrationPlan);
  let runtime: ReturnType<typeof createTestDatabaseRuntime> | undefined;
  const databases = new Map<string, TestD1Database>();
  const snapshots = new Map<string, DatabaseSnapshot>();

  beforeAll(async () => {
    runtime = createTestDatabaseRuntime(Object.keys(plan), options);

    for (const [databaseName, migrationNames] of Object.entries(plan)) {
      const database = await runtime.getDatabase(databaseName);
      databases.set(databaseName, database);
      await migrateTestDatabase(database, migrationNames);
      snapshots.set(databaseName, await captureDatabaseSnapshot(database));
    }
  });

  beforeEach(async () => {
    for (const [name, database] of databases) {
      const snapshot = snapshots.get(name);
      if (snapshot === undefined) {
        throw new Error(`Missing baseline for test database ${name}`);
      }
      await resetDatabase(database, snapshot);
    }
  });

  afterAll(async () => {
    await runtime?.dispose();
  });

  function getDatabase(name: string): TestD1Database {
    const database = databases.get(name);
    if (database === undefined) {
      throw new Error(`Test database ${name} is not ready`);
    }
    return database;
  }

  function databaseFor(name: string): TestD1Database {
    return new Proxy({} as TestD1Database, {
      get(_target, property) {
        const database = getDatabase(name);
        const value = Reflect.get(database, property, database) as unknown;
        return typeof value === "function" ? value.bind(database) : value;
      },
    });
  }

  return {
    database: databaseFor("FOUNDRY_DB"),
    databaseFor,
    getDatabase,
  };
}
