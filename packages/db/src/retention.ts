import type { DatabaseSync } from "node:sqlite";

export interface ApiLogRetentionPolicy {
  maxAgeDays?: number;
  maxRows?: number;
  now?: Date;
}

export function pruneApiLogs(
  database: DatabaseSync,
  { maxAgeDays = 30, maxRows = 100000, now = new Date() }: ApiLogRetentionPolicy = {},
): number {
  const cutoff = new Date(now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
  let deleted = Number(
    (
      database.prepare("DELETE FROM api_logs WHERE created_at < ?").run(cutoff) as {
        changes?: number | bigint;
      }
    ).changes ?? 0,
  );

  const countRow = database.prepare("SELECT COUNT(*) AS count FROM api_logs").get() as {
    count: number;
  };
  const overflow = Math.max(0, countRow.count - maxRows);

  if (overflow > 0) {
    deleted += Number(
      (
        database
          .prepare(
            `
              DELETE FROM api_logs
              WHERE id IN (
                SELECT id
                FROM api_logs
                ORDER BY created_at ASC
                LIMIT ?
              )
            `,
          )
          .run(overflow) as { changes?: number | bigint }
      ).changes ?? 0,
    );
  }

  return deleted;
}

export function pruneExpiredPromptCaches(database: DatabaseSync, now = new Date()): number {
  return Number(
    (
      database
        .prepare(
          `
            DELETE FROM prompt_caches
            WHERE expires_at IS NOT NULL
              AND expires_at <= ?
          `,
        )
        .run(now.toISOString()) as { changes?: number | bigint }
    ).changes ?? 0,
  );
}
