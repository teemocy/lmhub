import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { type MigrationRunResult, loadMigrations, runMigrations } from "./migrations.js";

export interface OpenDatabaseOptions {
  filePath: string;
  migrationsDir: string;
  migrate?: boolean;
}

export interface OpenDatabaseResult {
  database: DatabaseSync;
  migrations: MigrationRunResult;
}

function ensureParentDirectory(filePath: string): void {
  if (filePath === ":memory:") {
    return;
  }

  mkdirSync(path.dirname(filePath), { recursive: true });
}

function applyPragmas(database: DatabaseSync): void {
  database.exec("PRAGMA journal_mode = WAL;");
  database.exec("PRAGMA foreign_keys = ON;");
  database.exec("PRAGMA busy_timeout = 5000;");
}

export function openDatabase(options: OpenDatabaseOptions): OpenDatabaseResult {
  ensureParentDirectory(options.filePath);
  const database = new DatabaseSync(options.filePath);
  applyPragmas(database);

  const migrations =
    options.migrate === false
      ? { applied: [], skipped: [] }
      : runMigrations(database, options.migrationsDir, loadMigrations(options.migrationsDir));

  return { database, migrations };
}

export function closeDatabase(database: DatabaseSync): void {
  database.close();
}
