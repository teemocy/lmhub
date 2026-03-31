import path from "node:path";

import { closeDatabase, openDatabase } from "../sqlite.js";

const migrationsDir = path.resolve(import.meta.dirname, "../../migrations");
const filePath =
  process.argv[2] ??
  process.env.LOCAL_LLM_HUB_DATABASE_FILE ??
  path.resolve(".local/local-llm-hub/dev/data/gateway.sqlite");

const { database, migrations } = openDatabase({
  filePath,
  migrationsDir,
});

for (const migration of migrations.applied) {
  process.stdout.write(`applied ${migration.fileName}\n`);
}

if (migrations.applied.length === 0) {
  process.stdout.write("no migrations applied\n");
}

closeDatabase(database);
