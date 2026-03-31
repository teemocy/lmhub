import { afterEach, describe, expect, it } from "vitest";

import {
  ApiTokensRepository,
  ChatRepository,
  DownloadTasksRepository,
  EngineVersionsRepository,
  ModelsRepository,
  PromptCachesRepository,
  createTestDatabase,
  fixtureApiLog,
  fixtureApiTokenRecord,
  fixtureChatMessage,
  fixtureChatSession,
  fixtureDownloadTask,
  fixtureEngineVersion,
  fixtureModelArtifact,
  fixtureModelProfile,
  fixturePromptCacheRecord,
  pruneApiLogs,
} from "./index.js";

let cleanup: (() => void) | undefined;

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

describe("db foundation", () => {
  it("applies the baseline migrations", () => {
    const testDatabase = createTestDatabase();
    cleanup = testDatabase.cleanup;

    const row = testDatabase.database
      .prepare("SELECT COUNT(*) AS count FROM schema_migrations")
      .get() as { count: number };

    expect(row.count).toBe(3);
  });

  it("persists core operational records", () => {
    const testDatabase = createTestDatabase();
    cleanup = testDatabase.cleanup;

    const models = new ModelsRepository(testDatabase.database);
    const engines = new EngineVersionsRepository(testDatabase.database);
    const downloads = new DownloadTasksRepository(testDatabase.database);
    const promptCaches = new PromptCachesRepository(testDatabase.database);
    const tokens = new ApiTokensRepository(testDatabase.database);

    models.save(fixtureModelArtifact, fixtureModelProfile);
    models.markLoaded(fixtureModelArtifact.id, "2026-03-31T12:15:00.000Z");
    engines.upsert(fixtureEngineVersion);
    downloads.upsert(fixtureDownloadTask);
    promptCaches.upsert(fixturePromptCacheRecord, { source: "test" });
    tokens.upsert(fixtureApiTokenRecord);

    const storedModel = models.findById(fixtureModelArtifact.id);
    const storedPromptCache = promptCaches.findByCacheKey(fixturePromptCacheRecord.cacheKey);

    expect(storedModel?.loadCount).toBe(1);
    expect(engines.list()).toHaveLength(1);
    expect(downloads.listActive()).toHaveLength(1);
    expect(storedPromptCache?.metadata.source).toBe("test");
    expect(tokens.listActive()).toHaveLength(1);
  });

  it("persists chat and audit records", () => {
    const testDatabase = createTestDatabase();
    cleanup = testDatabase.cleanup;

    const models = new ModelsRepository(testDatabase.database);
    const chat = new ChatRepository(testDatabase.database);

    models.save(fixtureModelArtifact, fixtureModelProfile);
    chat.upsertSession(fixtureChatSession);
    chat.appendMessage(fixtureChatMessage);
    const apiLogId = chat.insertApiLog(fixtureApiLog);

    expect(chat.listSessions()).toHaveLength(1);
    expect(chat.listMessages(fixtureChatSession.id)).toHaveLength(1);
    expect(apiLogId).toBeGreaterThan(0);
    expect(chat.listRecentApiLogs()).toHaveLength(1);
  });

  it("prunes api logs by age", () => {
    const testDatabase = createTestDatabase();
    cleanup = testDatabase.cleanup;

    const chat = new ChatRepository(testDatabase.database);
    chat.insertApiLog({
      endpoint: "/v1/models",
      createdAt: "2025-01-01T00:00:00.000Z",
    });

    const deleted = pruneApiLogs(testDatabase.database, {
      maxAgeDays: 1,
      now: new Date("2026-03-31T12:00:00.000Z"),
    });

    expect(deleted).toBe(1);
  });
});
