import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { closeDatabase, openDatabase } from "../sqlite.js";

const migrationsDir = path.resolve(import.meta.dirname, "../../migrations");

export function createTestDatabase(): {
  database: ReturnType<typeof openDatabase>["database"];
  filePath: string;
  cleanup: () => void;
} {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "local-llm-hub-db-"));
  const filePath = path.join(tempDir, "gateway.sqlite");
  const { database } = openDatabase({
    filePath,
    migrationsDir,
  });

  return {
    database,
    filePath,
    cleanup() {
      closeDatabase(database);
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}
