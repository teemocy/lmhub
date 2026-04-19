import type { DatabaseSync } from "node:sqlite";

import {
  type EngineVersionRecord,
  engineVersionRecordSchema,
} from "@localhub/shared-contracts/foundation-persistence";

import { parseJson, stringifyJson } from "./helpers.js";

export class EngineVersionsRepository {
  readonly #database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.#database = database;
  }

  upsert(record: EngineVersionRecord): string {
    const parsed = engineVersionRecordSchema.parse(record);
    const existingRow = this.#database
      .prepare("SELECT id FROM engine_versions WHERE binary_path = ?")
      .get(parsed.binaryPath) as { id: string } | undefined;
    const targetId = existingRow?.id ?? parsed.id;

    // Keep one row per binary path so repeated resolves refresh the existing
    // engine record instead of tripping the UNIQUE constraint.
    this.#database
      .prepare(
        `
          INSERT INTO engine_versions (
            id,
            engine_type,
            version_tag,
            binary_path,
            is_active,
            capability_json,
            compatibility_notes,
            installed_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            engine_type = excluded.engine_type,
            version_tag = excluded.version_tag,
            binary_path = excluded.binary_path,
            is_active = excluded.is_active,
            capability_json = excluded.capability_json,
            compatibility_notes = excluded.compatibility_notes,
            installed_at = excluded.installed_at
        `,
      )
      .run(
        targetId,
        parsed.engineType,
        parsed.versionTag,
        parsed.binaryPath,
        parsed.isActive ? 1 : 0,
        stringifyJson(parsed.capabilities),
        parsed.compatibilityNotes ?? null,
        parsed.installedAt,
      );

    return targetId;
  }

  list(): EngineVersionRecord[] {
    return (
      this.#database
        .prepare("SELECT * FROM engine_versions ORDER BY installed_at DESC")
        .all() as Array<{
        id: string;
        engine_type: string;
        version_tag: string;
        binary_path: string;
        is_active: number;
        capability_json: string;
        compatibility_notes: string | null;
        installed_at: string;
      }>
    ).map((row) =>
      engineVersionRecordSchema.parse({
        id: row.id,
        engineType: row.engine_type,
        versionTag: row.version_tag,
        binaryPath: row.binary_path,
        isActive: row.is_active === 1,
        capabilities: parseJson(row.capability_json, {}),
        compatibilityNotes: row.compatibility_notes ?? undefined,
        installedAt: row.installed_at,
      }),
    );
  }

  findById(id: string): EngineVersionRecord | undefined {
    return this.list().find((record) => record.id === id);
  }

  findActive(engineType: string): EngineVersionRecord | undefined {
    return this.list().find((record) => record.engineType === engineType && record.isActive);
  }

  setActive(engineType: string, id: string): void {
    this.#database
      .prepare("UPDATE engine_versions SET is_active = 0 WHERE engine_type = ?")
      .run(engineType);
    this.#database.prepare("UPDATE engine_versions SET is_active = 1 WHERE id = ?").run(id);
  }

  removeByEngineVersion(engineType: string, versionTag: string): void {
    this.#database
      .prepare("DELETE FROM engine_versions WHERE engine_type = ? AND version_tag = ?")
      .run(engineType, versionTag);
  }
}
