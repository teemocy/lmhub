import type { DatabaseSync } from "node:sqlite";

import {
  type ApiLogRecord,
  type ChatMessage,
  type ChatSession,
  apiLogRecordSchema,
  chatMessageSchema,
  chatSessionSchema,
} from "@localhub/shared-contracts/foundation-persistence";

import { parseJson, stringifyJson } from "./helpers.js";

export class ChatRepository {
  readonly #database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.#database = database;
  }

  upsertSession(session: ChatSession): void {
    const parsed = chatSessionSchema.parse(session);

    this.#database
      .prepare(
        `
          INSERT INTO chat_sessions (id, title, model_id, system_prompt, metadata_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            model_id = excluded.model_id,
            system_prompt = excluded.system_prompt,
            metadata_json = excluded.metadata_json,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at
        `,
      )
      .run(
        parsed.id,
        parsed.title ?? null,
        parsed.modelId ?? null,
        parsed.systemPrompt ?? null,
        stringifyJson(parsed.metadata),
        parsed.createdAt,
        parsed.updatedAt,
      );
  }

  appendMessage(message: ChatMessage): void {
    const parsed = chatMessageSchema.parse(message);

    this.#database
      .prepare(
        `
          INSERT INTO chat_messages (
            id,
            session_id,
            role,
            content,
            tool_calls_json,
            tokens_count,
            metadata_json,
            created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        parsed.id,
        parsed.sessionId,
        parsed.role,
        parsed.content,
        stringifyJson(parsed.toolCalls),
        parsed.tokensCount ?? null,
        stringifyJson(parsed.metadata),
        parsed.createdAt,
      );
  }

  listSessions(): ChatSession[] {
    return (
      this.#database
        .prepare("SELECT * FROM chat_sessions ORDER BY updated_at DESC")
        .all() as Array<{
        id: string;
        title: string | null;
        model_id: string | null;
        system_prompt: string | null;
        metadata_json: string;
        created_at: string;
        updated_at: string;
      }>
    ).map((row) =>
      chatSessionSchema.parse({
        id: row.id,
        title: row.title ?? undefined,
        modelId: row.model_id ?? undefined,
        systemPrompt: row.system_prompt ?? undefined,
        metadata: parseJson(row.metadata_json, {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }),
    );
  }

  listMessages(sessionId: string): ChatMessage[] {
    return (
      this.#database
        .prepare(
          `
          SELECT *
          FROM chat_messages
          WHERE session_id = ?
          ORDER BY created_at ASC
        `,
        )
        .all(sessionId) as Array<{
        id: string;
        session_id: string;
        role: ChatMessage["role"];
        content: string | null;
        tool_calls_json: string;
        tokens_count: number | null;
        metadata_json: string;
        created_at: string;
      }>
    ).map((row) =>
      chatMessageSchema.parse({
        id: row.id,
        sessionId: row.session_id,
        role: row.role,
        content: row.content,
        toolCalls: parseJson(row.tool_calls_json, []),
        tokensCount: row.tokens_count ?? undefined,
        metadata: parseJson(row.metadata_json, {}),
        createdAt: row.created_at,
      }),
    );
  }

  insertApiLog(record: ApiLogRecord): number {
    const parsed = apiLogRecordSchema.parse(record);
    const result = this.#database
      .prepare(
        `
          INSERT INTO api_logs (
            trace_id,
            model_id,
            endpoint,
            request_ip,
            prompt_tokens,
            completion_tokens,
            ttft_ms,
            total_duration_ms,
            tokens_per_second,
            status_code,
            error_message,
            created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        parsed.traceId ?? null,
        parsed.modelId ?? null,
        parsed.endpoint,
        parsed.requestIp ?? null,
        parsed.promptTokens ?? null,
        parsed.completionTokens ?? null,
        parsed.ttftMs ?? null,
        parsed.totalDurationMs ?? null,
        parsed.tokensPerSecond ?? null,
        parsed.statusCode ?? null,
        parsed.errorMessage ?? null,
        parsed.createdAt,
      ) as { lastInsertRowid: number | bigint };

    return Number(result.lastInsertRowid);
  }

  listRecentApiLogs(limit = 50): ApiLogRecord[] {
    return (
      this.#database
        .prepare(
          `
          SELECT *
          FROM api_logs
          ORDER BY created_at DESC
          LIMIT ?
        `,
        )
        .all(limit) as Array<{
        id: number;
        trace_id: string | null;
        model_id: string | null;
        endpoint: string;
        request_ip: string | null;
        prompt_tokens: number | null;
        completion_tokens: number | null;
        ttft_ms: number | null;
        total_duration_ms: number | null;
        tokens_per_second: number | null;
        status_code: number | null;
        error_message: string | null;
        created_at: string;
      }>
    ).map((row) =>
      apiLogRecordSchema.parse({
        id: row.id,
        traceId: row.trace_id ?? undefined,
        modelId: row.model_id ?? undefined,
        endpoint: row.endpoint,
        requestIp: row.request_ip ?? undefined,
        promptTokens: row.prompt_tokens ?? undefined,
        completionTokens: row.completion_tokens ?? undefined,
        ttftMs: row.ttft_ms ?? undefined,
        totalDurationMs: row.total_duration_ms ?? undefined,
        tokensPerSecond: row.tokens_per_second ?? undefined,
        statusCode: row.status_code ?? undefined,
        errorMessage: row.error_message ?? undefined,
        createdAt: row.created_at,
      }),
    );
  }
}
