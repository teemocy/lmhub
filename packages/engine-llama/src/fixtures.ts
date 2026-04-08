import type { ModelArtifact, ModelProfile } from "@localhub/shared-contracts/foundation-models";
import type { RuntimeKey } from "@localhub/shared-contracts/foundation-runtime";

const FIXTURE_TS = "2026-04-01T00:00:00.000Z";

export const LLAMA_CPP_FIXTURE_ARTIFACT: ModelArtifact = {
  schemaVersion: 1,
  id: "localhub/qwen2.5-7b-instruct-q4km",
  name: "Qwen 2.5 7B Instruct Q4_K_M",
  localPath: "/tmp/localhub/models/qwen2.5-7b-instruct-q4_k_m.gguf",
  format: "gguf",
  sizeBytes: 4_861_222_912,
  architecture: "qwen2",
  quantization: "Q4_K_M",
  createdAt: FIXTURE_TS,
  updatedAt: FIXTURE_TS,
  source: {
    kind: "local",
  },
  metadata: {
    schemaVersion: 1,
    architecture: "qwen2",
    quantization: "Q4_K_M",
    contextLength: 8192,
    parameterCount: 7_610_000_000,
    tensorCount: 291,
    tokenizer: "qwen2",
    metadata: {
      "general.name": "Qwen 2.5 7B Instruct",
    },
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
  tags: ["chat", "instruct", "gguf", "fixture"],
};

export const LLAMA_CPP_FIXTURE_PROFILE: ModelProfile = {
  schemaVersion: 1,
  id: "profile:qwen2.5-7b-instruct",
  modelId: LLAMA_CPP_FIXTURE_ARTIFACT.id,
  displayName: "Qwen 2.5 7B Instruct",
  engineType: "llama.cpp",
  pinned: false,
  defaultTtlMs: 900_000,
  promptCacheKey: "cache-qwen2.5-7b",
  role: "chat",
  parameterOverrides: {
    contextLength: 8192,
    batchSize: 3072,
    gpuLayers: 99,
    flashAttentionType: "auto",
  },
  createdAt: FIXTURE_TS,
  updatedAt: FIXTURE_TS,
};

export const LLAMA_CPP_FIXTURE_RUNTIME_KEY: RuntimeKey = {
  modelId: LLAMA_CPP_FIXTURE_ARTIFACT.id,
  engineType: "llama.cpp",
  role: "chat",
  configHash: "cfg-stage1",
};
