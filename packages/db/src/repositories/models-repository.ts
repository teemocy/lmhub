import type { DatabaseSync } from "node:sqlite";

import {
  type ModelArtifact,
  type ModelProfile,
  modelArtifactSchema,
  modelProfileSchema,
} from "@localhub/shared-contracts/foundation-models";

import { parseJson, stringifyJson } from "./helpers.js";

export interface StoredModelRecord {
  artifact: ModelArtifact;
  profile: ModelProfile | undefined;
  loadCount: number;
  lastLoadedAt: string | undefined;
}

export class ModelsRepository {
  readonly #database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.#database = database;
  }

  save(artifact: ModelArtifact, profile?: ModelProfile): void {
    const existing = this.#database
      .prepare("SELECT load_count, last_loaded_at FROM models WHERE id = ?")
      .get(artifact.id) as { load_count: number; last_loaded_at: string | null } | undefined;

    this.#database
      .prepare(
        `
          INSERT INTO models (
            id,
            name,
            local_path,
            format,
            architecture,
            quantization,
            size_bytes,
            source_kind,
            artifact_json,
            profile_json,
            created_at,
            updated_at,
            last_loaded_at,
            load_count
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            local_path = excluded.local_path,
            format = excluded.format,
            architecture = excluded.architecture,
            quantization = excluded.quantization,
            size_bytes = excluded.size_bytes,
            source_kind = excluded.source_kind,
            artifact_json = excluded.artifact_json,
            profile_json = excluded.profile_json,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at
        `,
      )
      .run(
        artifact.id,
        artifact.name,
        artifact.localPath,
        artifact.format,
        artifact.architecture ?? null,
        artifact.quantization ?? null,
        artifact.sizeBytes,
        artifact.source.kind,
        stringifyJson(artifact),
        profile ? stringifyJson(profile) : null,
        artifact.createdAt,
        artifact.updatedAt,
        existing?.last_loaded_at ?? null,
        existing?.load_count ?? 0,
      );
  }

  findById(id: string): StoredModelRecord | undefined {
    const row = this.#database.prepare("SELECT * FROM models WHERE id = ?").get(id) as
      | {
          artifact_json: string;
          profile_json: string | null;
          load_count: number;
          last_loaded_at: string | null;
        }
      | undefined;

    if (!row) {
      return undefined;
    }

    return {
      artifact: modelArtifactSchema.parse(JSON.parse(row.artifact_json)),
      profile: row.profile_json
        ? modelProfileSchema.parse(parseJson<ModelProfile | null>(row.profile_json, null))
        : undefined,
      loadCount: row.load_count,
      lastLoadedAt: row.last_loaded_at ?? undefined,
    };
  }

  list(): StoredModelRecord[] {
    return (
      this.#database.prepare("SELECT * FROM models ORDER BY updated_at DESC").all() as Array<{
        artifact_json: string;
        profile_json: string | null;
        load_count: number;
        last_loaded_at: string | null;
      }>
    ).map((row) => ({
      artifact: modelArtifactSchema.parse(JSON.parse(row.artifact_json)),
      profile: row.profile_json
        ? modelProfileSchema.parse(parseJson<ModelProfile | null>(row.profile_json, null))
        : undefined,
      loadCount: row.load_count,
      lastLoadedAt: row.last_loaded_at ?? undefined,
    }));
  }

  markLoaded(id: string, loadedAt = new Date().toISOString()): void {
    this.#database
      .prepare(
        `
          UPDATE models
          SET load_count = load_count + 1,
              last_loaded_at = ?
          WHERE id = ?
        `,
      )
      .run(loadedAt, id);
  }

  delete(id: string): boolean {
    const result = this.#database.prepare("DELETE FROM models WHERE id = ?").run(id);
    return result.changes > 0;
  }
}
