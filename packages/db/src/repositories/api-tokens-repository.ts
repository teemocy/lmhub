import type { DatabaseSync } from "node:sqlite";

import {
  type ApiTokenRecord,
  apiTokenRecordSchema,
} from "@localhub/shared-contracts/foundation-config";

import { parseJson, stringifyJson } from "./helpers.js";

export class ApiTokensRepository {
  readonly #database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.#database = database;
  }

  upsert(record: ApiTokenRecord): void {
    const parsed = apiTokenRecordSchema.parse(record);

    this.#database
      .prepare(
        `
          INSERT INTO api_tokens (id, label, token_hash, scopes_json, created_at, last_used_at, revoked_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            label = excluded.label,
            token_hash = excluded.token_hash,
            scopes_json = excluded.scopes_json,
            created_at = excluded.created_at,
            last_used_at = excluded.last_used_at,
            revoked_at = excluded.revoked_at
        `,
      )
      .run(
        parsed.id,
        parsed.label,
        parsed.tokenHash,
        stringifyJson(parsed.scopes),
        parsed.createdAt,
        parsed.lastUsedAt ?? null,
        parsed.revokedAt ?? null,
      );
  }

  listActive(): ApiTokenRecord[] {
    return (
      this.#database
        .prepare("SELECT * FROM api_tokens WHERE revoked_at IS NULL ORDER BY created_at DESC")
        .all() as Array<{
        id: string;
        label: string;
        token_hash: string;
        scopes_json: string;
        created_at: string;
        last_used_at: string | null;
        revoked_at: string | null;
      }>
    ).map((row) =>
      apiTokenRecordSchema.parse({
        id: row.id,
        label: row.label,
        tokenHash: row.token_hash,
        scopes: parseJson(row.scopes_json, ["public"]),
        createdAt: row.created_at,
        lastUsedAt: row.last_used_at ?? undefined,
        revokedAt: row.revoked_at ?? undefined,
      }),
    );
  }

  findByTokenHash(tokenHash: string): ApiTokenRecord | undefined {
    const row = this.#database
      .prepare("SELECT * FROM api_tokens WHERE token_hash = ?")
      .get(tokenHash) as
      | {
          id: string;
          label: string;
          token_hash: string;
          scopes_json: string;
          created_at: string;
          last_used_at: string | null;
          revoked_at: string | null;
        }
      | undefined;

    if (!row) {
      return undefined;
    }

    return apiTokenRecordSchema.parse({
      id: row.id,
      label: row.label,
      tokenHash: row.token_hash,
      scopes: parseJson(row.scopes_json, ["public"]),
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at ?? undefined,
      revokedAt: row.revoked_at ?? undefined,
    });
  }

  markUsed(id: string, usedAt = new Date().toISOString()): void {
    this.#database.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").run(usedAt, id);
  }

  revoke(id: string, revokedAt = new Date().toISOString()): void {
    this.#database.prepare("UPDATE api_tokens SET revoked_at = ? WHERE id = ?").run(revokedAt, id);
  }
}
