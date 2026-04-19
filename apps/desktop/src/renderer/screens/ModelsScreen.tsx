import type {
  DesktopLocalModelImportRequest,
  DesktopLocalModelImportResponse,
  DesktopModelDeleteResponse,
  DesktopModelConfigUpdateRequest,
  DesktopModelConfigUpdateResponse,
  DesktopModelRecord,
  DesktopRuntimeContext,
  DesktopShellState,
} from "@localhub/shared-contracts";
import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useState } from "react";

type ModelsScreenProps = {
  models: DesktopModelRecord[];
  runtimeContext: DesktopRuntimeContext | null;
  selectedModelId: string | null;
  shellState: DesktopShellState;
  onSelectModel(modelId: string): void;
  onPickImportFile(): Promise<string | null>;
  onRegisterModel(
    payload: DesktopLocalModelImportRequest,
  ): Promise<DesktopLocalModelImportResponse>;
  onDeleteModel(
    modelId: string,
    options?: { deleteFiles?: boolean },
  ): Promise<DesktopModelDeleteResponse>;
  onUpdateModelConfig(
    modelId: string,
    payload: DesktopModelConfigUpdateRequest,
  ): Promise<DesktopModelConfigUpdateResponse>;
  onPreloadModel(modelId: string): Promise<void>;
  onEvictModel(modelId: string): Promise<void>;
};

type CapabilityKey =
  | "chat"
  | "embeddings"
  | "tools"
  | "streaming"
  | "vision"
  | "audioTranscription"
  | "audioSpeech"
  | "rerank";

type CapabilityToggleValue = "inherit" | "enabled" | "disabled";
type FlashAttentionValue = "auto" | "enabled" | "disabled";
type PoolingMethodValue = "none" | "mean" | "cls" | "last" | "rank";

type ModelDetailTab = "details" | "config";

type FeedbackState = {
  tone: "success" | "error";
  text: string;
} | null;

const formatBytes = (value: number): string => {
  if (value <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  let nextValue = value;
  let unitIndex = 0;

  while (nextValue >= 1024 && unitIndex < units.length - 1) {
    nextValue /= 1024;
    unitIndex += 1;
  }

  return `${nextValue >= 10 ? nextValue.toFixed(0) : nextValue.toFixed(1)} ${units[unitIndex]}`;
};

const formatTime = (value?: string): string => {
  if (!value) {
    return "Never";
  }

  return new Date(value).toLocaleString();
};

const formatTtl = (value: number): string => {
  if (value <= 0) {
    return "Pinned in memory";
  }

  const totalMinutes = Math.round(value / 60_000);
  if (totalMinutes < 60) {
    return `${totalMinutes} min`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours} hr` : `${hours} hr ${minutes} min`;
};

const humanize = (value: string): string =>
  value.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();

const formatFlashAttentionType = (value?: FlashAttentionValue): string => {
  switch (value) {
    case "enabled":
      return "Enabled";
    case "disabled":
      return "Disabled";
    default:
      return "Auto";
  }
};

const formatSourceKind = (value: DesktopModelRecord["sourceKind"]): string => {
  switch (value) {
    case "huggingface":
      return "Hugging Face";
    case "modelscope":
      return "ModelScope";
    case "manual":
      return "Manual";
    case "local":
      return "Local";
    default:
      return "Unknown";
  }
};

const formatParameterCount = (value?: number): string => {
  if (value === undefined) {
    return "Unknown";
  }

  if (value >= 1_000_000_000) {
    const scaled = value / 1_000_000_000;
    return `${scaled >= 10 ? scaled.toFixed(0) : scaled.toFixed(1)}B`;
  }

  if (value >= 1_000_000) {
    const scaled = value / 1_000_000;
    return `${scaled >= 10 ? scaled.toFixed(0) : scaled.toFixed(1)}M`;
  }

  return value.toLocaleString();
};

const formatParameterCountDetail = (value?: number): string => {
  if (value === undefined) {
    return "Unknown";
  }

  const compact = formatParameterCount(value);
  const exact = value.toLocaleString();
  return compact === exact ? exact : `${compact} (${exact})`;
};

const formatContextLengthDetail = (value?: number): string =>
  value !== undefined ? `${value.toLocaleString()} tokens` : "Unknown";

const formatTextValue = (value?: string): string =>
  value && value.trim().length > 0 ? value : "Unknown";

const formatLabel = (value: string): string =>
  humanize(value).replace(/\b\w/g, (character) => character.toUpperCase());

const formatEngineType = (value: DesktopModelRecord["engineType"]): string => {
  switch (value) {
    case "mlx":
      return "MLX";
    case "llama.cpp":
      return "llama.cpp";
    default:
      return "Unknown";
  }
};

const formatModelCardSummary = (model: DesktopModelRecord): string => {
  const architecture = model.architecture ? humanize(model.architecture) : "Unknown";
  const parameters = formatParameterCount(model.parameterCount);
  const publisher = formatSourceKind(model.sourceKind);
  const llmName = model.name;
  const quantization = model.quantization ? humanize(model.quantization) : "Unknown";
  const size = formatBytes(model.sizeBytes);

  return `Arch ${architecture} · Params ${parameters} · Publisher ${publisher} · LLM ${llmName} · Quant ${quantization} · Size ${size}`;
};

const modelMetadataHint =
  "GGUF metadata starts with the model header and can be enriched from sidecars like config.json, generation_config.json, tokenizer_config.json, and tokenizer.json when they are present next to the artifact. MLX metadata is derived from bundled sidecars like config.json, generation_config.json, tokenizer_config.json, tokenizer.json, and quant_strategy.json when available. Parameter counts may still be estimated when a repository does not publish an explicit total.";

const getStateToneClass = (state: DesktopModelRecord["state"]): string => {
  switch (state) {
    case "ready":
      return "status-pill-positive";
    case "loading":
    case "queued":
      return "status-pill-caution";
    case "evicting":
      return "status-pill-neutral";
    case "error":
      return "status-pill-negative";
    default:
      return "status-pill-neutral";
  }
};

const getArtifactToneClass = (status: DesktopModelRecord["artifactStatus"]): string =>
  status === "available" ? "status-pill-positive" : "status-pill-negative";

const capabilityDefinitions: Array<{
  description: string;
  key: CapabilityKey;
  label: string;
}> = [
  {
    key: "chat",
    label: "Chat",
    description: "General conversational completions.",
  },
  {
    key: "embeddings",
    label: "Embeddings",
    description: "Vector search and embedding requests.",
  },
  {
    key: "vision",
    label: "Vision",
    description: "Image inputs and multimodal prompts.",
  },
  {
    key: "audioTranscription",
    label: "Audio transcription",
    description: "Speech-to-text workflows.",
  },
  {
    key: "audioSpeech",
    label: "Audio speech",
    description: "Text-to-speech output workflows.",
  },
  {
    key: "rerank",
    label: "Rerank",
    description: "Document reranking and relevance scoring.",
  },
  {
    key: "tools",
    label: "Tools",
    description: "Function calling and tool execution.",
  },
  {
    key: "streaming",
    label: "Streaming",
    description: "Streaming chat and token-by-token responses.",
  },
];

const capabilityToggleOptions: Array<{
  label: string;
  value: CapabilityToggleValue;
}> = [
  {
    value: "inherit",
    label: "Auto",
  },
  {
    value: "enabled",
    label: "Enabled",
  },
  {
    value: "disabled",
    label: "Disabled",
  },
];

const getCapabilityToggleValue = (
  overrides: DesktopModelRecord["capabilityOverrides"],
  key: CapabilityKey,
): CapabilityToggleValue => {
  if (overrides[key] === true) {
    return "enabled";
  }

  if (overrides[key] === false) {
    return "disabled";
  }

  return "inherit";
};

const createCapabilityDraft = (
  overrides: DesktopModelRecord["capabilityOverrides"],
): Record<CapabilityKey, CapabilityToggleValue> =>
  capabilityDefinitions.reduce(
    (draft, { key }) => {
      draft[key] = getCapabilityToggleValue(overrides, key);
      return draft;
    },
    {} as Record<CapabilityKey, CapabilityToggleValue>,
  );

const toCapabilityOverrides = (
  draft: Record<CapabilityKey, CapabilityToggleValue>,
): DesktopModelConfigUpdateRequest["capabilityOverrides"] => {
  const overrides: NonNullable<DesktopModelConfigUpdateRequest["capabilityOverrides"]> = {};

  for (const { key } of capabilityDefinitions) {
    const value = draft[key];
    if (value === "enabled") {
      overrides[key] = true;
    } else if (value === "disabled") {
      overrides[key] = false;
    }
  }

  return overrides;
};

const formatCapabilityToggle = (value: CapabilityToggleValue): string => {
  switch (value) {
    case "enabled":
      return "Enabled";
    case "disabled":
      return "Disabled";
    default:
      return "Auto";
  }
};

export function ModelsScreen({
  models,
  runtimeContext,
  selectedModelId,
  shellState,
  onSelectModel,
  onPickImportFile,
  onRegisterModel,
  onDeleteModel,
  onUpdateModelConfig,
  onPreloadModel,
  onEvictModel,
}: ModelsScreenProps) {
  const [feedback, setFeedback] = useState<FeedbackState>(null);
  const [importFilePath, setImportFilePath] = useState<string | null>(null);
  const [importAliasName, setImportAliasName] = useState("");
  const [aliasDraft, setAliasDraft] = useState("");
  const [pendingImport, setPendingImport] = useState(false);
  const [pendingActionModelId, setPendingActionModelId] = useState<string | null>(null);
  const [isDetailModalOpen, setIsDetailModalOpen] = useState(false);
  const [detailModelId, setDetailModelId] = useState<string | null>(null);
  const [isConfigModalOpen, setIsConfigModalOpen] = useState(false);
  const [deleteFilesOnRemove, setDeleteFilesOnRemove] = useState(false);
  const [detailTab, setDetailTab] = useState<ModelDetailTab>("details");
  const [configDraft, setConfigDraft] = useState({
    pinned: false,
    defaultTtlMinutes: "15",
    contextLength: "",
    batchSize: "",
    ubatchSize: "",
    gpuLayers: "",
    parallelSlots: "",
    flashAttentionType: "auto" as FlashAttentionValue,
    poolingMethod: "" as "" | PoolingMethodValue,
    capabilityOverrides: createCapabilityDraft({}),
  });

  const selectedModel =
    (selectedModelId ? models.find((model) => model.id === selectedModelId) : undefined) ??
    models[0];
  const mlxSupported = runtimeContext?.mlx.supported ?? false;
  const connected = shellState.phase === "connected";
  const canRegister = connected && Boolean(importFilePath) && !pendingImport;
  const canPreload =
    connected &&
    !!selectedModel &&
    selectedModel.artifactStatus === "available" &&
    selectedModel.state !== "loading" &&
    selectedModel.state !== "ready" &&
    selectedModel.state !== "evicting" &&
    pendingActionModelId !== selectedModel.id;
  const canEvict =
    connected &&
    !!selectedModel &&
    selectedModel.loaded &&
    selectedModel.state !== "evicting" &&
    pendingActionModelId !== selectedModel.id;
  const canEmergencyEvict =
    connected &&
    !!selectedModel &&
    selectedModel.state === "error" &&
    pendingActionModelId !== selectedModel.id;
  const detailModelAction: "preload" | "evict" = selectedModel?.loaded ? "evict" : "preload";
  const detailModelActionDisabled = detailModelAction === "evict" ? !canEvict : !canPreload;
  const detailModelActionLabel =
    detailModelAction === "evict"
      ? pendingActionModelId === selectedModel?.id && selectedModel?.loaded
        ? "Evicting..."
        : "Evict from memory"
      : pendingActionModelId === selectedModel?.id && selectedModel?.state !== "ready"
        ? "Loading..."
        : selectedModel?.state === "error"
          ? "Retry preload"
          : "Preload to memory";
  const canSaveConfig =
    connected &&
    !!selectedModel &&
    !selectedModel.loaded &&
    pendingActionModelId !== selectedModel.id;
  const canDeleteModel =
    connected &&
    !!selectedModel &&
    selectedModel.state !== "loading" &&
    selectedModel.state !== "evicting" &&
    pendingActionModelId !== selectedModel.id;
  const hasCapabilityOverrides =
    !!selectedModel && Object.keys(selectedModel.capabilityOverrides).length > 0;
  const selectedModelUsesLlamaRuntime = selectedModel?.engineType === "llama.cpp";
  const selectedModelRequiresPooledRuntime =
    selectedModelUsesLlamaRuntime &&
    (selectedModel?.role === "embeddings" || selectedModel?.role === "rerank");

  useEffect(() => {
    if (!selectedModel) {
      setIsDetailModalOpen(false);
      setDetailModelId(null);
      setIsConfigModalOpen(false);
      setDetailTab("details");
      return;
    }

    const capabilityOverrides = createCapabilityDraft(selectedModel.capabilityOverrides);
    setAliasDraft(selectedModel.displayName);
    setConfigDraft({
      pinned: selectedModel.pinned,
      defaultTtlMinutes: String(Math.max(1, Math.round(selectedModel.defaultTtlMs / 60_000))),
      contextLength: selectedModel.contextLength ? String(selectedModel.contextLength) : "",
      batchSize: String(selectedModel.batchSize ?? 3072),
      ubatchSize: String(selectedModel.ubatchSize ?? 512),
      gpuLayers: selectedModel.gpuLayers ? String(selectedModel.gpuLayers) : "",
      parallelSlots: selectedModel.parallelSlots ? String(selectedModel.parallelSlots) : "",
      flashAttentionType:
        (selectedModel.flashAttentionType as FlashAttentionValue | undefined) ?? "auto",
      poolingMethod: (selectedModel.poolingMethod as PoolingMethodValue | undefined) ?? "",
      capabilityOverrides,
    });
    setDeleteFilesOnRemove(false);
  }, [selectedModel?.id]);

  useEffect(() => {
    if (!isDetailModalOpen) {
      return;
    }

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsDetailModalOpen(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isDetailModalOpen]);

  const selectModel = (modelId: string) => {
    onSelectModel(modelId);
    setIsDetailModalOpen(false);
    setDetailModelId(null);
    setIsConfigModalOpen(false);
    setDetailTab("details");
  };

  const openModelDetail = (modelId: string, tab: ModelDetailTab = "details") => {
    onSelectModel(modelId);
    setDetailModelId(modelId);
    setDetailTab(tab);
    setIsDetailModalOpen(true);
  };

  const closeModelDetail = () => {
    setIsDetailModalOpen(false);
    setDetailModelId(null);
  };

  const openModelConfigPanel = (modelId: string, tab: ModelDetailTab = "details") => {
    onSelectModel(modelId);
    setDetailTab(tab);
    setIsConfigModalOpen(true);
    setIsDetailModalOpen(false);
    setDetailModelId(null);
  };

  const closeModelConfigPanel = () => {
    setIsConfigModalOpen(false);
  };

  const handleModelCardKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>, modelId: string) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectModel(modelId);
    }
  };

  const detailModel =
    (detailModelId ? models.find((model) => model.id === detailModelId) : selectedModel) ?? null;

  const handlePickImport = async () => {
    setFeedback(null);

    const filePath = await onPickImportFile();
    if (!filePath) {
      return;
    }

    setImportFilePath(filePath);
  };

  const handleRegister = async () => {
    if (!importFilePath) {
      setFeedback({
        tone: "error",
        text: mlxSupported
          ? "Choose a local GGUF file or MLX model directory before trying to register it."
          : "Choose a local GGUF before trying to register it.",
      });
      return;
    }

    setPendingImport(true);
    setFeedback(null);

    try {
      const result = await onRegisterModel({
        filePath: importFilePath,
        ...(importAliasName.trim() ? { displayName: importAliasName.trim() } : {}),
      });

      setImportFilePath(null);
      setImportAliasName("");
      onSelectModel(result.model.id);
      setDetailTab("details");
      setIsDetailModalOpen(true);
      setFeedback({
        tone: "success",
        text: result.created
          ? `Registered ${result.model.displayName}.`
          : `Updated ${result.model.displayName}.`,
      });
    } catch (error) {
      setFeedback({
        tone: "error",
        text: error instanceof Error ? error.message : "Unable to register the selected model.",
      });
    } finally {
      setPendingImport(false);
    }
  };

  const runModelAction = async (action: "preload" | "evict") => {
    if (!selectedModel) {
      return;
    }

    setPendingActionModelId(selectedModel.id);
    setFeedback(null);

    try {
      if (action === "preload") {
        await onPreloadModel(selectedModel.id);
      } else {
        await onEvictModel(selectedModel.id);
      }

      setFeedback({
        tone: "success",
        text:
          action === "preload"
            ? `Preload requested for ${selectedModel.displayName}.`
            : `Eviction requested for ${selectedModel.displayName}.`,
      });
    } catch (error) {
      setFeedback({
        tone: "error",
        text:
          error instanceof Error
            ? error.message
            : `Unable to ${action} ${selectedModel.displayName}.`,
      });
    } finally {
      setPendingActionModelId(null);
    }
  };

  const saveAlias = async () => {
    if (!selectedModel) {
      return;
    }

    const displayName = aliasDraft.trim();
    if (!displayName) {
      setFeedback({
        tone: "error",
        text: "Alias names cannot be empty.",
      });
      return;
    }

    setPendingActionModelId(selectedModel.id);
    setFeedback(null);

    try {
      const result = await onUpdateModelConfig(selectedModel.id, {
        displayName,
      });
      setAliasDraft(result.model.displayName);
      setFeedback({
        tone: "success",
        text: `Saved alias for ${result.model.displayName}.`,
      });
    } catch (error) {
      setFeedback({
        tone: "error",
        text:
          error instanceof Error
            ? error.message
            : `Unable to update the alias for ${selectedModel.displayName}.`,
      });
    } finally {
      setPendingActionModelId(null);
    }
  };

  const deleteModel = async () => {
    if (!selectedModel) {
      return;
    }

    const confirmed = window.confirm(
      deleteFilesOnRemove
        ? `Delete the ${selectedModel.displayName} registration and remove its related files from disk?`
        : `Delete the ${selectedModel.displayName} registration and keep its files on disk?`,
    );
    if (!confirmed) {
      return;
    }

    setPendingActionModelId(selectedModel.id);
    setFeedback(null);

    try {
      const result = await onDeleteModel(selectedModel.id, {
        deleteFiles: deleteFilesOnRemove,
      });
      closeModelConfigPanel();
      closeModelDetail();
      setDeleteFilesOnRemove(false);
      setFeedback({
        tone: "success",
        text: result.deletedFiles
          ? result.deletedPaths.length > 0
            ? `Deleted ${selectedModel.displayName} and removed ${result.deletedPaths.length} related file(s).`
            : `Deleted ${selectedModel.displayName}. Any related files were already missing.`
          : `Deleted ${selectedModel.displayName} from the registered model list and kept its files on disk.`,
      });
    } catch (error) {
      setFeedback({
        tone: "error",
        text:
          error instanceof Error ? error.message : `Unable to delete ${selectedModel.displayName}.`,
      });
    } finally {
      setPendingActionModelId(null);
    }
  };

  const saveAdvancedConfig = async () => {
    if (!selectedModel) {
      return;
    }

    setPendingActionModelId(selectedModel.id);
    setFeedback(null);

    try {
      const defaultTtlMinutes = Math.max(
        1,
        Number.parseInt(configDraft.defaultTtlMinutes, 10) || 15,
      );
      const basePayload: DesktopModelConfigUpdateRequest = {
        pinned: configDraft.pinned,
        defaultTtlMs: defaultTtlMinutes * 60_000,
        capabilityOverrides: toCapabilityOverrides(configDraft.capabilityOverrides),
      };
      const batchSize = configDraft.batchSize.trim()
        ? Number.parseInt(configDraft.batchSize, 10)
        : 3072;
      const ubatchSize = configDraft.ubatchSize.trim()
        ? Number.parseInt(configDraft.ubatchSize, 10)
        : 512;
      if (selectedModel.engineType === "llama.cpp" && batchSize % ubatchSize !== 0) {
        throw new Error(`Batch size must be a multiple of ubatch size (${ubatchSize}).`);
      }
      if (selectedModelRequiresPooledRuntime && batchSize !== ubatchSize) {
        throw new Error("Embedding and rerank models must use the same ubatch size as batch size.");
      }

      const result = await onUpdateModelConfig(selectedModel.id, {
        ...basePayload,
        ...(selectedModel.engineType === "llama.cpp"
          ? {
              ...(configDraft.contextLength.trim()
                ? { contextLength: Number.parseInt(configDraft.contextLength, 10) }
                : {}),
              batchSize,
              ubatchSize,
              ...(configDraft.gpuLayers.trim()
                ? { gpuLayers: Number.parseInt(configDraft.gpuLayers, 10) }
                : {}),
              ...(configDraft.parallelSlots.trim()
                ? { parallelSlots: Number.parseInt(configDraft.parallelSlots, 10) }
                : {}),
              flashAttentionType: configDraft.flashAttentionType,
              ...(configDraft.poolingMethod ? { poolingMethod: configDraft.poolingMethod } : {}),
            }
          : {}),
      });
      setConfigDraft({
        pinned: result.model.pinned,
        defaultTtlMinutes: String(Math.max(1, Math.round(result.model.defaultTtlMs / 60_000))),
        contextLength: result.model.contextLength ? String(result.model.contextLength) : "",
        batchSize: String(result.model.batchSize ?? 3072),
        ubatchSize: String(result.model.ubatchSize ?? 512),
        gpuLayers: result.model.gpuLayers ? String(result.model.gpuLayers) : "",
        parallelSlots: result.model.parallelSlots ? String(result.model.parallelSlots) : "",
        flashAttentionType:
          (result.model.flashAttentionType as FlashAttentionValue | undefined) ?? "auto",
        poolingMethod: (result.model.poolingMethod as PoolingMethodValue | undefined) ?? "",
        capabilityOverrides: createCapabilityDraft(result.model.capabilityOverrides),
      });
      setFeedback({
        tone: "success",
        text:
          selectedModel.engineType === "llama.cpp"
            ? `Saved cold-start settings for ${selectedModel.displayName}. Changes apply on the next preload.`
            : `Saved shared runtime settings for ${selectedModel.displayName}.`,
      });
    } catch (error) {
      setFeedback({
        tone: "error",
        text:
          error instanceof Error
            ? error.message
            : `Unable to update advanced settings for ${selectedModel.displayName}.`,
      });
    } finally {
      setPendingActionModelId(null);
    }
  };

  return (
    <section className="screen-stack">
      {feedback ? (
        <article
          className={
            feedback.tone === "error"
              ? "wide-card feedback-card feedback-card-error"
              : "wide-card feedback-card"
          }
        >
          <strong>{feedback.tone === "error" ? "Action blocked" : "Action queued"}</strong>
          <p>{feedback.text}</p>
        </article>
      ) : null}

      <div className="models-stage-grid">
        <article className="wide-card library-panel">
          <div className="panel-header">
            <div>
              <span className="section-label">Registered models</span>
              <h3>Inventory</h3>
            </div>
            <p>
              {connected
                ? "Select a model to inspect runtime and artifact details."
                : shellState.message}
            </p>
          </div>

          {models.length === 0 ? (
            <div className="empty-panel">
              <strong>No local models registered yet.</strong>
              <p>
                {mlxSupported
                  ? "Pick a GGUF file or MLX model directory and register it to unlock the runtime detail view and preload controls."
                  : "Pick a GGUF and register it to unlock the runtime detail view and preload controls."}
              </p>
            </div>
          ) : (
            <>
              <div className="model-list">
                {models.map((model) => {
                  const summary = formatModelCardSummary(model);
                  const usesMlxRuntime = model.engineType === "mlx";

                  return (
                    <div
                      className={
                        model.id === selectedModel?.id
                          ? "model-list-item model-list-item-active"
                          : "model-list-item"
                      }
                      key={model.id}
                      onClick={() => selectModel(model.id)}
                      onKeyDown={(event) => handleModelCardKeyDown(event, model.id)}
                      role="button"
                      tabIndex={0}
                    >
                      <div className="model-card-head">
                        <div className="model-card-title">
                          <div className="model-card-title-row">
                            <h4>{model.displayName}</h4>
                            <span
                              className={`status-pill status-pill-compact ${getStateToneClass(model.state)}`}
                            >
                              {humanize(model.state)}
                            </span>
                          </div>
                          <div className="pill-row model-card-pill-row">
                            <span
                              className={
                                usesMlxRuntime
                                  ? "meta-pill meta-pill-mlx"
                                  : "meta-pill meta-pill-muted"
                              }
                            >
                              {usesMlxRuntime ? "MLX runtime" : "llama.cpp runtime"}
                            </span>
                            <span className="meta-pill meta-pill-muted">
                              {model.format === "mlx" ? "MLX model" : model.format.toUpperCase()}
                            </span>
                          </div>
                        </div>
                      </div>
                      <div className="model-card-metadata-line" aria-label="Model metadata">
                        <span className="model-card-summary-text" title={summary}>
                          {summary}
                        </span>
                        <button
                          className="secondary-button model-card-config-button"
                          onClick={(event) => {
                            event.stopPropagation();
                            openModelConfigPanel(model.id, "details");
                          }}
                          type="button"
                        >
                          Details
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </article>
      </div>

      {selectedModel && isConfigModalOpen ? (
        <div
          className="model-detail-modal-backdrop"
          onClick={closeModelConfigPanel}
          role="presentation"
        >
          <div
            aria-labelledby="model-config-modal-title"
            aria-modal="true"
            className="model-detail-modal"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
          >
            <div className="modal-shell-header">
              <div>
                <span className="section-label">Model details</span>
                <h3 id="model-config-modal-title">{selectedModel.displayName}</h3>
                <p>{formatModelCardSummary(selectedModel)}</p>
              </div>
              <div className="modal-shell-actions">
                <span
                  className={
                    selectedModel.loaded
                      ? "status-pill status-pill-caution"
                      : `status-pill ${getStateToneClass(selectedModel.state)}`
                  }
                >
                  {selectedModel.loaded ? "Loaded in memory" : humanize(selectedModel.state)}
                </span>
                <button
                  className={detailModelAction === "evict" ? "secondary-button" : "primary-button"}
                  disabled={detailModelActionDisabled}
                  onClick={() => void runModelAction(detailModelAction)}
                  type="button"
                >
                  {detailModelActionLabel}
                </button>
                <button className="secondary-button" onClick={closeModelConfigPanel} type="button">
                  Close
                </button>
              </div>
            </div>

            <div aria-label="Model details sections" className="modal-tabbar" role="tablist">
              <button
                aria-selected={detailTab === "details"}
                className={detailTab === "details" ? "modal-tab modal-tab-active" : "modal-tab"}
                id="model-tab-details"
                onClick={() => setDetailTab("details")}
                role="tab"
                type="button"
              >
                Details
              </button>
              <button
                aria-selected={detailTab === "config"}
                className={detailTab === "config" ? "modal-tab modal-tab-active" : "modal-tab"}
                id="model-tab-config"
                onClick={() => setDetailTab("config")}
                role="tab"
                type="button"
              >
                Config
              </button>
            </div>

            <div
              aria-labelledby={detailTab === "details" ? "model-tab-details" : "model-tab-config"}
              className="modal-panel"
              role="tabpanel"
            >
              {detailTab === "details" ? (
                <>
                  <div className="advanced-config-card modal-section-card">
                    <div className="panel-header">
                      <div>
                        <span className="section-label">Model metadata</span>
                        <h3>Detected artifact details</h3>
                      </div>
                      <div className="detail-status-row">
                        <span
                          className={`status-pill ${getArtifactToneClass(selectedModel.artifactStatus)}`}
                        >
                          {formatLabel(selectedModel.artifactStatus)}
                        </span>
                        <span className={`status-pill ${getStateToneClass(selectedModel.state)}`}>
                          {selectedModel.loaded
                            ? "Loaded in memory"
                            : formatLabel(selectedModel.state)}
                        </span>
                      </div>
                    </div>

                    <dl className="meta-grid compact-meta-grid modal-meta-grid">
                      <div>
                        <dt>Original name</dt>
                        <dd>{selectedModel.name}</dd>
                      </div>
                      <div>
                        <dt>Architecture</dt>
                        <dd>{formatTextValue(selectedModel.architecture)}</dd>
                      </div>
                      <div>
                        <dt>Parameters</dt>
                        <dd>{formatParameterCountDetail(selectedModel.parameterCount)}</dd>
                      </div>
                      <div>
                        <dt>Quantization</dt>
                        <dd>{formatTextValue(selectedModel.quantization)}</dd>
                      </div>
                      <div>
                        <dt>Tokenizer</dt>
                        <dd>{formatTextValue(selectedModel.tokenizer)}</dd>
                      </div>
                      <div>
                        <dt>Context length</dt>
                        <dd>{formatContextLengthDetail(selectedModel.contextLength)}</dd>
                      </div>
                      <div>
                        <dt>Runtime</dt>
                        <dd>{formatEngineType(selectedModel.engineType)}</dd>
                      </div>
                      <div>
                        <dt>Format</dt>
                        <dd>
                          {selectedModel.format === "mlx"
                            ? "MLX"
                            : selectedModel.format.toUpperCase()}
                        </dd>
                      </div>
                      <div>
                        <dt>Role</dt>
                        <dd>{formatLabel(selectedModel.role)}</dd>
                      </div>
                      <div>
                        <dt>Source</dt>
                        <dd>{formatSourceKind(selectedModel.sourceKind)}</dd>
                      </div>
                      <div>
                        <dt>Artifact size</dt>
                        <dd>{formatBytes(selectedModel.sizeBytes)}</dd>
                      </div>
                      <div>
                        <dt>Warm TTL</dt>
                        <dd>{formatTtl(selectedModel.defaultTtlMs)}</dd>
                      </div>
                    </dl>

                    <details className="detail-meta-note">
                      <summary>Metadata detection notes</summary>
                      <p>{modelMetadataHint}</p>
                    </details>
                  </div>

                  <div className="advanced-config-card modal-section-card">
                    <div className="panel-header">
                      <div>
                        <span className="section-label">Storage and lifecycle</span>
                        <h3>Runtime state and local files</h3>
                      </div>
                      <span
                        className={
                          selectedModel.loaded
                            ? "status-pill status-pill-caution"
                            : "status-pill status-pill-neutral"
                        }
                      >
                        {selectedModel.loaded ? "Resident in memory" : "Cold on disk"}
                      </span>
                    </div>

                    <dl className="meta-grid compact-meta-grid modal-meta-grid">
                      <div>
                        <dt>Engine version</dt>
                        <dd>{formatTextValue(selectedModel.engineVersion)}</dd>
                      </div>
                      <div>
                        <dt>Engine channel</dt>
                        <dd>
                          {selectedModel.engineChannel
                            ? formatLabel(selectedModel.engineChannel)
                            : "Unknown"}
                        </dd>
                      </div>
                      <div>
                        <dt>Pinned</dt>
                        <dd>{selectedModel.pinned ? "Yes" : "No"}</dd>
                      </div>
                      <div>
                        <dt>Checksum (SHA-256)</dt>
                        <dd className="meta-value-mono meta-value-wrap">
                          {selectedModel.checksumSha256 ?? "Unavailable"}
                        </dd>
                      </div>
                      <div>
                        <dt>Local path</dt>
                        <dd className="meta-value-mono meta-value-wrap">
                          {selectedModel.localPath}
                        </dd>
                      </div>
                      <div>
                        <dt>Model ID</dt>
                        <dd className="meta-value-mono meta-value-wrap">{selectedModel.id}</dd>
                      </div>
                      <div>
                        <dt>Last used</dt>
                        <dd>
                          {selectedModel.lastUsedAt
                            ? formatTime(selectedModel.lastUsedAt)
                            : "Never"}
                        </dd>
                      </div>
                      <div>
                        <dt>Registered</dt>
                        <dd>{formatTime(selectedModel.createdAt)}</dd>
                      </div>
                      <div>
                        <dt>Updated</dt>
                        <dd>{formatTime(selectedModel.updatedAt)}</dd>
                      </div>
                    </dl>

                    {selectedModel.errorMessage ? (
                      <div className="detail-alert feedback-card-error">
                        <strong>Latest runtime issue</strong>
                        <p>{selectedModel.errorMessage}</p>
                      </div>
                    ) : null}
                  </div>
                </>
              ) : (
                <>
                  <div className="advanced-config-card modal-section-card alias-config-card">
                    <div className="panel-header alias-panel-header">
                      <div className="alias-header-copy">
                        <span className="section-label">Alias name</span>
                        <div className="alias-inline-row">
                          <h3>Rename this model</h3>
                          <input
                            aria-label="Alias name"
                            className="text-input alias-inline-input"
                            disabled={!connected || pendingActionModelId !== null}
                            onChange={(event) => setAliasDraft(event.target.value)}
                            type="text"
                            value={aliasDraft}
                          />
                          <button
                            className="secondary-button alias-inline-save"
                            disabled={
                              !connected ||
                              pendingActionModelId !== null ||
                              aliasDraft.trim().length === 0 ||
                              aliasDraft.trim() === selectedModel.displayName.trim()
                            }
                            onClick={() => void saveAlias()}
                            type="button"
                          >
                            {pendingActionModelId === selectedModel.id ? "Saving..." : "Save alias"}
                          </button>
                        </div>
                      </div>
                      <span
                        className={
                          selectedModel.loaded
                            ? "status-pill status-pill-neutral"
                            : "status-pill status-pill-positive"
                        }
                      >
                        {selectedModel.loaded ? "Alias edits stay live" : "No eviction needed"}
                      </span>
                    </div>
                  </div>

                  <div className="advanced-config-card modal-section-card">
                    <div className="panel-header">
                      <div>
                        <span className="section-label">Advanced configuration</span>
                        <h3>
                          {selectedModelUsesLlamaRuntime
                            ? "Safe cold-start overrides"
                            : "Shared runtime settings"}
                        </h3>
                      </div>
                      <span
                        className={
                          selectedModel.loaded
                            ? "status-pill status-pill-caution"
                            : "status-pill status-pill-neutral"
                        }
                      >
                        {selectedModel.loaded ? "Evict before editing" : "Editable"}
                      </span>
                    </div>
                    <p>
                      {selectedModelUsesLlamaRuntime
                        ? selectedModel.loaded
                          ? "These settings persist to the model profile and apply on the next preload. Use Evict from memory above first so the runtime key stays consistent."
                          : "These settings persist to the model profile and apply on the next preload. Loaded workers must be evicted first so the runtime key stays consistent."
                        : selectedModel.loaded
                          ? "MLX models only expose cross-engine settings in this build. Use Evict from memory above first so the runtime key stays consistent."
                          : "MLX models only expose cross-engine settings in this build. Loaded workers must be evicted first so the runtime key stays consistent."}
                    </p>
                    {selectedModelRequiresPooledRuntime ? (
                      <p>
                        Embedding and rerank workers need matching batch and ubatch sizes. If
                        pooling is left unset, llama.cpp will use the model default.
                      </p>
                    ) : null}

                    <div className="settings-grid">
                      <label className="field-stack">
                        <span className="section-label">Warm TTL (minutes)</span>
                        <input
                          className="text-input"
                          disabled={!canSaveConfig}
                          min="1"
                          onChange={(event) =>
                            setConfigDraft((current) => ({
                              ...current,
                              defaultTtlMinutes: event.target.value,
                            }))
                          }
                          type="number"
                          value={configDraft.defaultTtlMinutes}
                        />
                      </label>
                      {selectedModelUsesLlamaRuntime ? (
                        <>
                          <label className="field-stack">
                            <span className="section-label">Context length</span>
                            <input
                              className="text-input"
                              disabled={!canSaveConfig}
                              min="1"
                              onChange={(event) =>
                                setConfigDraft((current) => ({
                                  ...current,
                                  contextLength: event.target.value,
                                }))
                              }
                              type="number"
                              value={configDraft.contextLength}
                            />
                          </label>
                          <label className="field-stack">
                            <span className="section-label">Batch size</span>
                            <input
                              className="text-input"
                              disabled={!canSaveConfig}
                              min="512"
                              step="512"
                              onChange={(event) =>
                                setConfigDraft((current) => ({
                                  ...current,
                                  batchSize: event.target.value,
                                  ...(selectedModelRequiresPooledRuntime
                                    ? { ubatchSize: event.target.value }
                                    : {}),
                                }))
                              }
                              type="number"
                              value={configDraft.batchSize}
                            />
                          </label>
                          <label className="field-stack">
                            <span className="section-label">Ubatch size</span>
                            <input
                              className="text-input"
                              disabled={!canSaveConfig}
                              min="1"
                              onChange={(event) =>
                                setConfigDraft((current) => ({
                                  ...current,
                                  ubatchSize: event.target.value,
                                  ...(selectedModelRequiresPooledRuntime
                                    ? { batchSize: event.target.value }
                                    : {}),
                                }))
                              }
                              type="number"
                              value={configDraft.ubatchSize}
                            />
                          </label>
                          <label className="field-stack">
                            <span className="section-label">GPU layers</span>
                            <input
                              className="text-input"
                              disabled={!canSaveConfig}
                              min="1"
                              onChange={(event) =>
                                setConfigDraft((current) => ({
                                  ...current,
                                  gpuLayers: event.target.value,
                                }))
                              }
                              type="number"
                              value={configDraft.gpuLayers}
                            />
                          </label>
                          <label className="field-stack">
                            <span className="section-label">Parallel slots</span>
                            <input
                              className="text-input"
                              disabled={!canSaveConfig}
                              min="1"
                              onChange={(event) =>
                                setConfigDraft((current) => ({
                                  ...current,
                                  parallelSlots: event.target.value,
                                }))
                              }
                              type="number"
                              value={configDraft.parallelSlots}
                            />
                          </label>
                          <label className="field-stack">
                            <span className="section-label">Flash attention</span>
                            <select
                              className="text-input"
                              disabled={!canSaveConfig}
                              onChange={(event) =>
                                setConfigDraft((current) => ({
                                  ...current,
                                  flashAttentionType: event.target.value as FlashAttentionValue,
                                }))
                              }
                              value={configDraft.flashAttentionType}
                            >
                              <option value="auto">Auto</option>
                              <option value="enabled">Enabled</option>
                              <option value="disabled">Disabled</option>
                            </select>
                          </label>
                          <label className="field-stack">
                            <span className="section-label">Pooling method</span>
                            <select
                              className="text-input"
                              disabled={!canSaveConfig}
                              onChange={(event) =>
                                setConfigDraft((current) => ({
                                  ...current,
                                  poolingMethod: event.target.value as "" | PoolingMethodValue,
                                }))
                              }
                              value={configDraft.poolingMethod}
                            >
                              <option value="">Not set</option>
                              <option value="none">None</option>
                              <option value="mean">Mean</option>
                              <option value="cls">CLS</option>
                              <option value="last">Last</option>
                              <option value="rank">Rank</option>
                            </select>
                          </label>
                        </>
                      ) : null}
                    </div>

                    <label className="checkbox-row">
                      <input
                        checked={configDraft.pinned}
                        disabled={!canSaveConfig}
                        onChange={(event) =>
                          setConfigDraft((current) => ({
                            ...current,
                            pinned: event.target.checked,
                          }))
                        }
                        type="checkbox"
                      />
                      <span>Pin this model in memory after the next successful preload.</span>
                    </label>

                    <div className="button-row">
                      <button
                        className="secondary-button"
                        disabled={!canSaveConfig}
                        onClick={() => void saveAdvancedConfig()}
                        type="button"
                      >
                        {pendingActionModelId === selectedModel.id
                          ? "Saving..."
                          : "Save advanced settings"}
                      </button>
                    </div>
                  </div>

                  <div className="advanced-config-card modal-section-card">
                    <div className="panel-header">
                      <div>
                        <span className="section-label">Capability overrides</span>
                        <h3>Force model abilities on or off</h3>
                      </div>
                      <span
                        className={
                          hasCapabilityOverrides
                            ? "status-pill status-pill-caution"
                            : "status-pill status-pill-neutral"
                        }
                      >
                        {hasCapabilityOverrides ? "Overrides active" : "Using defaults"}
                      </span>
                    </div>
                    <p>
                      Leave a capability on <strong>Auto</strong> to keep the detected default from
                      the registered model metadata. Explicit overrides are saved to the profile and
                      apply on the next preload.
                    </p>

                    <div className="capability-override-list">
                      {capabilityDefinitions.map(({ key, label, description }) => (
                        <div className="capability-override-row" key={key}>
                          <div className="capability-override-copy">
                            <strong>{label}</strong>
                            <span>{description}</span>
                          </div>
                          <div
                            aria-label={`${label} capability override`}
                            className="capability-toggle-group"
                            role="group"
                          >
                            {capabilityToggleOptions.map((option) => {
                              const isSelected =
                                configDraft.capabilityOverrides[key] === option.value;
                              const optionTone =
                                option.value === "inherit"
                                  ? "auto"
                                  : option.value === "enabled"
                                    ? "enabled"
                                    : "disabled";

                              return (
                                <button
                                  aria-pressed={isSelected}
                                  className={[
                                    "capability-toggle-button",
                                    `capability-toggle-button-${optionTone}`,
                                    isSelected ? "capability-toggle-button-selected" : "",
                                  ]
                                    .filter(Boolean)
                                    .join(" ")}
                                  disabled={!canSaveConfig}
                                  key={option.value}
                                  onClick={() =>
                                    setConfigDraft((current) => ({
                                      ...current,
                                      capabilityOverrides: {
                                        ...current.capabilityOverrides,
                                        [key]: option.value,
                                      },
                                    }))
                                  }
                                  type="button"
                                >
                                  {option.label}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>

                    <div className="capability-override-summary">
                      <span className="section-label">Current overrides</span>
                      <div className="pill-row">
                        {hasCapabilityOverrides ? (
                          capabilityDefinitions
                            .filter(
                              ({ key }) => selectedModel.capabilityOverrides[key] !== undefined,
                            )
                            .map(({ key, label }) => {
                              const value = selectedModel.capabilityOverrides[key];
                              return (
                                <span className="meta-pill" key={key}>
                                  {label}:{" "}
                                  {formatCapabilityToggle(value === true ? "enabled" : "disabled")}
                                </span>
                              );
                            })
                        ) : (
                          <span className="meta-pill meta-pill-muted">No explicit overrides</span>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="advanced-config-card modal-section-card">
                    <div className="panel-header">
                      <div>
                        <span className="section-label">Danger zone</span>
                        <h3>Delete registration</h3>
                      </div>
                      <span className="status-pill status-pill-negative">
                        {selectedModel.loaded ? "Will evict first" : "Permanent change"}
                      </span>
                    </div>
                    <p>
                      Remove this model from the registered inventory. If file deletion is enabled,
                      the gateway also removes the model artifact from disk, including any related
                      MMProj sidecar it knows about.
                    </p>
                    <label className="checkbox-row">
                      <input
                        checked={deleteFilesOnRemove}
                        disabled={!canDeleteModel}
                        onChange={(event) => setDeleteFilesOnRemove(event.target.checked)}
                        type="checkbox"
                      />
                      <span>
                        Also delete related files from disk
                        {selectedModel.artifactStatus === "missing"
                          ? " if any remnants still exist."
                          : "."}
                      </span>
                    </label>
                    <div className="button-row">
                      <button
                        className="secondary-button danger-button"
                        disabled={!canDeleteModel}
                        onClick={() => void deleteModel()}
                        type="button"
                      >
                        {pendingActionModelId === selectedModel.id
                          ? "Deleting..."
                          : deleteFilesOnRemove
                            ? "Delete model and files"
                            : "Delete model registration"}
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      ) : null}

      <div className="screen-grid">
        <article className="info-card">
          <span className="section-label">Import and register</span>
          <h3>{mlxSupported ? "Local model intake" : "Local GGUF intake"}</h3>
          <p>
            {mlxSupported
              ? "The desktop shell only asks the gateway to register artifacts after you pick a GGUF file or MLX model directory through the preload-safe dialog."
              : "The desktop shell only asks the gateway to register artifacts after you pick them through the preload-safe dialog."}
          </p>

          <div className="import-preview">
            <strong>Selected model</strong>
            <span>
              {importFilePath ??
                (mlxSupported
                  ? "No local GGUF file or MLX model directory selected yet."
                  : "No local GGUF selected yet.")}
            </span>
          </div>

          <label className="field-stack">
            <span className="section-label">Alias name</span>
            <input
              className="text-input"
              onChange={(event) => setImportAliasName(event.target.value)}
              placeholder="Optional alias name"
              type="text"
              value={importAliasName}
            />
          </label>

          <div className="button-row">
            <button
              className="secondary-button"
              onClick={() => void handlePickImport()}
              type="button"
            >
              {mlxSupported ? "Choose model" : "Choose GGUF"}
            </button>
            <button
              className="primary-button"
              disabled={!canRegister}
              onClick={() => void handleRegister()}
              type="button"
            >
              {pendingImport ? "Registering..." : "Register model"}
            </button>
          </div>
        </article>

      </div>
    </section>
  );
}
