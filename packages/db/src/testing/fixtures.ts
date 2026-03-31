import type {
  ApiTokenRecord,
  PromptCacheRecord,
} from "@localhub/shared-contracts/foundation-config";
import type { ModelArtifact, ModelProfile } from "@localhub/shared-contracts/foundation-models";
import type {
  ApiLogRecord,
  ChatMessage,
  ChatSession,
  DownloadTask,
  EngineVersionRecord,
} from "@localhub/shared-contracts/foundation-persistence";

export const FIXTURE_TIMESTAMP = "2026-03-31T12:00:00.000Z";

export const fixtureModelArtifact: ModelArtifact = {
  schemaVersion: 1,
  id: "model_qwen25_coder",
  name: "Qwen 2.5 Coder 7B Instruct",
  localPath: "/models/qwen2.5-coder.gguf",
  format: "gguf",
  sizeBytes: 4_294_967_296,
  architecture: "qwen2",
  quantization: "Q4_K_M",
  createdAt: FIXTURE_TIMESTAMP,
  updatedAt: FIXTURE_TIMESTAMP,
  source: {
    kind: "local",
  },
  metadata: {
    schemaVersion: 1,
    architecture: "qwen2",
    quantization: "Q4_K_M",
    contextLength: 32768,
    metadata: {},
  },
  capabilities: {
    chat: true,
    embeddings: false,
    tools: true,
    streaming: true,
    vision: false,
    audioTranscription: false,
    audioSpeech: false,
    rerank: false,
    promptCache: true,
  },
  tags: ["code", "instruct"],
};

export const fixtureModelProfile: ModelProfile = {
  schemaVersion: 1,
  id: "profile_qwen25_coder_default",
  modelId: fixtureModelArtifact.id,
  displayName: "Qwen 2.5 Coder (Default)",
  engineType: "llama.cpp",
  pinned: false,
  defaultTtlMs: 900000,
  role: "chat",
  parameterOverrides: {
    temperature: 0.2,
  },
  createdAt: FIXTURE_TIMESTAMP,
  updatedAt: FIXTURE_TIMESTAMP,
};

export const fixtureEngineVersion: EngineVersionRecord = {
  id: "engine_llamacpp_b3000",
  engineType: "llama.cpp",
  versionTag: "b3000",
  binaryPath: "/engines/llama.cpp/b3000/llama-server",
  isActive: true,
  capabilities: {
    chat: true,
    embeddings: true,
    streaming: true,
  },
  installedAt: FIXTURE_TIMESTAMP,
};

export const fixtureDownloadTask: DownloadTask = {
  id: "download_qwen25",
  modelId: fixtureModelArtifact.id,
  provider: "huggingface",
  url: "https://huggingface.co/example/model.gguf",
  totalBytes: 1_000,
  downloadedBytes: 250,
  status: "downloading",
  createdAt: FIXTURE_TIMESTAMP,
  updatedAt: FIXTURE_TIMESTAMP,
  metadata: {
    fileName: "model.gguf",
  },
};

export const fixturePromptCacheRecord: PromptCacheRecord = {
  id: "cache_qwen25",
  modelId: fixtureModelArtifact.id,
  cacheKey: "prompt-cache-qwen25",
  filePath: "/prompt-cache/qwen25.bin",
  sizeBytes: 512,
  lastAccessedAt: FIXTURE_TIMESTAMP,
  expiresAt: "2026-04-01T12:00:00.000Z",
};

export const fixtureApiTokenRecord: ApiTokenRecord = {
  id: "token_primary",
  label: "Primary",
  tokenHash: "scrypt$16384$8$1$test-salt$test-hash",
  scopes: ["public", "control"],
  createdAt: FIXTURE_TIMESTAMP,
};

export const fixtureChatSession: ChatSession = {
  id: "session_main",
  title: "Starter session",
  modelId: fixtureModelArtifact.id,
  systemPrompt: "You are a helpful local coding assistant.",
  metadata: {},
  createdAt: FIXTURE_TIMESTAMP,
  updatedAt: FIXTURE_TIMESTAMP,
};

export const fixtureChatMessage: ChatMessage = {
  id: "message_1",
  sessionId: fixtureChatSession.id,
  role: "user",
  content: "Hello there",
  toolCalls: [],
  tokensCount: 4,
  metadata: {},
  createdAt: FIXTURE_TIMESTAMP,
};

export const fixtureApiLog: ApiLogRecord = {
  traceId: "trace_12345678",
  modelId: fixtureModelArtifact.id,
  endpoint: "/v1/chat/completions",
  requestIp: "127.0.0.1",
  promptTokens: 12,
  completionTokens: 18,
  ttftMs: 150,
  totalDurationMs: 1200,
  tokensPerSecond: 18.5,
  statusCode: 200,
  createdAt: FIXTURE_TIMESTAMP,
};
