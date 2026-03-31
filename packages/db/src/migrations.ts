import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

export interface MigrationDefinition {
  version: number;
  name: string;
  fileName: string;
  checksum: string;
  sql: string;
}

export interface AppliedMigration {
  version: number;
  file_name: string;
  checksum: string;
  applied_at: string;
}

export interface MigrationRunResult {
  applied: MigrationDefinition[];
  skipped: MigrationDefinition[];
}

function checksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

export function loadMigrations(migrationsDir: string): MigrationDefinition[] {
  return readdirSync(migrationsDir)
    .filter((fileName) => fileName.endsWith(".sql"))
    .map((fileName) => {
      const match = /^(\d+)_([a-z0-9_]+)\.sql$/i.exec(fileName);

      if (!match) {
        throw new Error(`Invalid migration filename: ${fileName}`);
      }

      const sql = readFileSync(path.join(migrationsDir, fileName), "utf8");
      const versionText = match[1];
      const name = match[2];

      if (!versionText || !name) {
        throw new Error(`Invalid migration filename: ${fileName}`);
      }

      return {
        version: Number(versionText),
        name,
        fileName,
        checksum: checksum(sql),
        sql,
      };
    })
    .sort((left, right) => left.version - right.version);
}

function ensureMigrationTable(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      file_name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);
}

export function listAppliedMigrations(database: DatabaseSync): AppliedMigration[] {
  ensureMigrationTable(database);
  return database
    .prepare(
      `
        SELECT version, file_name, checksum, applied_at
        FROM schema_migrations
        ORDER BY version ASC
      `,
    )
    .all() as unknown as AppliedMigration[];
}

export function runMigrations(
  database: DatabaseSync,
  migrationsDir: string,
  migrationDefinitions = loadMigrations(migrationsDir),
): MigrationRunResult {
  ensureMigrationTable(database);
  const appliedByVersion = new Map(
    listAppliedMigrations(database).map((migration) => [migration.version, migration]),
  );
  const insertStatement = database.prepare(
    `
      INSERT INTO schema_migrations (version, file_name, checksum)
      VALUES (?, ?, ?)
    `,
  );

  const applied: MigrationDefinition[] = [];
  const skipped: MigrationDefinition[] = [];

  for (const migration of migrationDefinitions) {
    const existing = appliedByVersion.get(migration.version);

    if (existing) {
      if (existing.checksum !== migration.checksum || existing.file_name !== migration.fileName) {
        throw new Error(
          `Migration drift detected for version ${migration.version}: ${migration.fileName} does not match the recorded checksum.`,
        );
      }

      skipped.push(migration);
      continue;
    }

    database.exec("BEGIN IMMEDIATE");

    try {
      database.exec(migration.sql);
      insertStatement.run(migration.version, migration.fileName, migration.checksum);
      database.exec("COMMIT");
      applied.push(migration);
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  return { applied, skipped };
}
