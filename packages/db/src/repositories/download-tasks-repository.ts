import type { DatabaseSync } from "node:sqlite";

import {
  type DownloadTask,
  downloadTaskSchema,
} from "@localhub/shared-contracts/foundation-persistence";

import { parseJson, stringifyJson } from "./helpers.js";

export class DownloadTasksRepository {
  readonly #database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.#database = database;
  }

  upsert(task: DownloadTask): void {
    const parsed = downloadTaskSchema.parse(task);

    this.#database
      .prepare(
        `
          INSERT INTO download_tasks (
            id,
            model_id,
            provider,
            url,
            total_bytes,
            downloaded_bytes,
            status,
            checksum_sha256,
            error_message,
            metadata_json,
            created_at,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            model_id = excluded.model_id,
            provider = excluded.provider,
            url = excluded.url,
            total_bytes = excluded.total_bytes,
            downloaded_bytes = excluded.downloaded_bytes,
            status = excluded.status,
            checksum_sha256 = excluded.checksum_sha256,
            error_message = excluded.error_message,
            metadata_json = excluded.metadata_json,
            updated_at = excluded.updated_at
        `,
      )
      .run(
        parsed.id,
        parsed.modelId ?? null,
        parsed.provider,
        parsed.url,
        parsed.totalBytes ?? null,
        parsed.downloadedBytes,
        parsed.status,
        parsed.checksumSha256 ?? null,
        parsed.errorMessage ?? null,
        stringifyJson(parsed.metadata),
        parsed.createdAt,
        parsed.updatedAt,
      );
  }

  findById(id: string): DownloadTask | undefined {
    const row = this.#database.prepare("SELECT * FROM download_tasks WHERE id = ?").get(id) as
      | {
          id: string;
          model_id: string | null;
          provider: string;
          url: string;
          total_bytes: number | null;
          downloaded_bytes: number;
          status: DownloadTask["status"];
          checksum_sha256: string | null;
          error_message: string | null;
          metadata_json: string;
          created_at: string;
          updated_at: string;
        }
      | undefined;

    return row ? this.parseRow(row) : undefined;
  }

  list(): DownloadTask[] {
    return (
      this.#database
        .prepare("SELECT * FROM download_tasks ORDER BY updated_at DESC")
        .all() as Array<{
        id: string;
        model_id: string | null;
        provider: string;
        url: string;
        total_bytes: number | null;
        downloaded_bytes: number;
        status: DownloadTask["status"];
        checksum_sha256: string | null;
        error_message: string | null;
        metadata_json: string;
        created_at: string;
        updated_at: string;
      }>
    ).map((row) => this.parseRow(row));
  }

  listActive(): DownloadTask[] {
    return (
      this.#database
        .prepare(
          `
          SELECT *
          FROM download_tasks
          WHERE status IN ('pending', 'downloading', 'paused')
          ORDER BY updated_at DESC
        `,
        )
        .all() as Array<{
        id: string;
        model_id: string | null;
        provider: string;
        url: string;
        total_bytes: number | null;
        downloaded_bytes: number;
        status: DownloadTask["status"];
        checksum_sha256: string | null;
        error_message: string | null;
        metadata_json: string;
        created_at: string;
        updated_at: string;
      }>
    ).map((row) => this.parseRow(row));
  }

  delete(id: string): boolean {
    const result = this.#database.prepare("DELETE FROM download_tasks WHERE id = ?").run(id);
    return result.changes > 0;
  }

  deleteMany(ids: readonly string[]): number {
    if (ids.length === 0) {
      return 0;
    }

    const statement = this.#database.prepare("DELETE FROM download_tasks WHERE id = ?");
    let deleted = 0;
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      for (const id of ids) {
        deleted += Number(statement.run(id).changes);
      }
      this.#database.exec("COMMIT");
      return deleted;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  private parseRow(row: {
    id: string;
    model_id: string | null;
    provider: string;
    url: string;
    total_bytes: number | null;
    downloaded_bytes: number;
    status: DownloadTask["status"];
    checksum_sha256: string | null;
    error_message: string | null;
    metadata_json: string;
    created_at: string;
    updated_at: string;
  }): DownloadTask {
    return downloadTaskSchema.parse({
      id: row.id,
      modelId: row.model_id ?? undefined,
      provider: row.provider,
      url: row.url,
      totalBytes: row.total_bytes ?? undefined,
      downloadedBytes: row.downloaded_bytes,
      status: row.status,
      checksumSha256: row.checksum_sha256 ?? undefined,
      errorMessage: row.error_message ?? undefined,
      metadata: parseJson(row.metadata_json, {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }
}
