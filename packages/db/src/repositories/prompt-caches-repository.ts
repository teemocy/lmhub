import type { DatabaseSync } from "node:sqlite";

import {
  type PromptCacheRecord,
  promptCacheRecordSchema,
} from "@localhub/shared-contracts/foundation-config";

import { parseJson, stringifyJson } from "./helpers.js";

export class PromptCachesRepository {
  readonly #database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.#database = database;
  }

  upsert(record: PromptCacheRecord, metadata: Record<string, unknown> = {}): void {
    const parsed = promptCacheRecordSchema.parse(record);

    this.#database
      .prepare(
        `
          INSERT INTO prompt_caches (
            id,
            model_id,
            cache_key,
            file_path,
            size_bytes,
            last_accessed_at,
            expires_at,
            metadata_json
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            model_id = excluded.model_id,
            cache_key = excluded.cache_key,
            file_path = excluded.file_path,
            size_bytes = excluded.size_bytes,
            last_accessed_at = excluded.last_accessed_at,
            expires_at = excluded.expires_at,
            metadata_json = excluded.metadata_json
        `,
      )
      .run(
        parsed.id,
        parsed.modelId,
        parsed.cacheKey,
        parsed.filePath,
        parsed.sizeBytes,
        parsed.lastAccessedAt,
        parsed.expiresAt ?? null,
        stringifyJson(metadata),
      );
  }

  findByCacheKey(
    cacheKey: string,
  ): (PromptCacheRecord & { metadata: Record<string, unknown> }) | undefined {
    const row = this.#database
      .prepare("SELECT * FROM prompt_caches WHERE cache_key = ?")
      .get(cacheKey) as
      | {
          id: string;
          model_id: string;
          cache_key: string;
          file_path: string;
          size_bytes: number;
          last_accessed_at: string;
          expires_at: string | null;
          metadata_json: string;
        }
      | undefined;

    if (!row) {
      return undefined;
    }

    return {
      ...promptCacheRecordSchema.parse({
        id: row.id,
        modelId: row.model_id,
        cacheKey: row.cache_key,
        filePath: row.file_path,
        sizeBytes: row.size_bytes,
        lastAccessedAt: row.last_accessed_at,
        expiresAt: row.expires_at ?? undefined,
      }),
      metadata: parseJson(row.metadata_json, {}),
    };
  }

  touch(cacheKey: string, lastAccessedAt = new Date().toISOString()): void {
    this.#database
      .prepare(
        `
          UPDATE prompt_caches
          SET last_accessed_at = ?
          WHERE cache_key = ?
        `,
      )
      .run(lastAccessedAt, cacheKey);
  }
}
