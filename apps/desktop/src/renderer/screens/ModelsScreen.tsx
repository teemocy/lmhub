import type {
  DesktopEngineRecord,
  DesktopEngineInstallRequest,
  DesktopEngineInstallResponse,
  DesktopLocalModelImportRequest,
  DesktopLocalModelImportResponse,
  DesktopModelConfigUpdateRequest,
  DesktopModelConfigUpdateResponse,
  DesktopModelRecord,
  DesktopShellState,
} from "@localhub/shared-contracts";
import { useEffect, useState } from "react";

type ModelsScreenProps = {
  engines: DesktopEngineRecord[];
  models: DesktopModelRecord[];
  selectedModelId: string | null;
  shellState: DesktopShellState;
  onSelectModel(modelId: string): void;
  onPickImportFile(): Promise<string | null>;
  onPickEngineBinaryFile(): Promise<string | null>;
  onRegisterModel(
    payload: DesktopLocalModelImportRequest,
  ): Promise<DesktopLocalModelImportResponse>;
  onInstallEngineBinary(
    payload: DesktopEngineInstallRequest,
  ): Promise<DesktopEngineInstallResponse>;
  onActivateEngineVersion(versionTag: string): Promise<DesktopEngineInstallResponse>;
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
  | "rerank"
  | "promptCache";

type CapabilityToggleValue = "inherit" | "enabled" | "disabled";

type ModelDetailTab = "details" | "config";

type FeedbackState =
  | {
      tone: "success" | "error";
      text: string;
    }
  | null;

type EngineFeedbackState =
  | {
      tone: "success" | "error";
      title: string;
      text: string;
    }
  | null;

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
  value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const describeModel = (model: DesktopModelRecord): string => {
  const facets = [model.role, model.format, model.architecture, model.quantization]
    .filter((value): value is string => Boolean(value))
    .map((value) => humanize(value));

  return facets.length > 0 ? facets.join(" • ") : "Registered local model.";
};

const modelMetadataHint =
  "For exact parameter count and tokenizer details, include a companion model metadata file or manifest with explicit values. GGUF-only detection can be incomplete or wrong for those fields.";

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
    key: "tools",
    label: "Tools",
    description: "Function calling and tool execution.",
  },
  {
    key: "streaming",
    label: "Streaming",
    description: "Streaming chat and token-by-token responses.",
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
    key: "promptCache",
    label: "Prompt cache",
    description: "Persistent prompt-cache reuse.",
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
  capabilityDefinitions.reduce((draft, { key }) => {
    draft[key] = getCapabilityToggleValue(overrides, key);
    return draft;
  }, {} as Record<CapabilityKey, CapabilityToggleValue>);

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
      return "Inherit";
  }
};

export function ModelsScreen({
  engines,
  models,
  selectedModelId,
  shellState,
  onSelectModel,
  onPickImportFile,
  onPickEngineBinaryFile,
  onRegisterModel,
  onInstallEngineBinary,
  onActivateEngineVersion,
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
  const [pendingEngineAction, setPendingEngineAction] = useState<
    "download" | "import" | "activate" | null
  >(null);
  const [engineFeedback, setEngineFeedback] = useState<EngineFeedbackState>(null);
  const [selectedEngineVersionTag, setSelectedEngineVersionTag] = useState<string | null>(null);
  const [isDetailModalOpen, setIsDetailModalOpen] = useState(false);
  const [detailTab, setDetailTab] = useState<ModelDetailTab>("details");
  const [configDraft, setConfigDraft] = useState({
    pinned: false,
    defaultTtlMinutes: "15",
    contextLength: "",
    gpuLayers: "",
    capabilityOverrides: createCapabilityDraft({}),
  });

  const selectedModel =
    (selectedModelId ? models.find((model) => model.id === selectedModelId) : undefined) ??
    models[0];
  const connected = shellState.phase === "connected";
  const activeEngineVersionTag = engines.find((engine) => engine.active)?.version ?? engines[0]?.version ?? null;
  const selectedEngineVersion =
    selectedEngineVersionTag && engines.some((engine) => engine.version === selectedEngineVersionTag)
      ? selectedEngineVersionTag
      : activeEngineVersionTag;
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
  const hasCapabilityOverrides =
    !!selectedModel && Object.keys(selectedModel.capabilityOverrides).length > 0;

  useEffect(() => {
    if (!selectedModel) {
      setIsDetailModalOpen(false);
      setDetailTab("details");
      return;
    }

    const capabilityOverrides = createCapabilityDraft(selectedModel.capabilityOverrides);
    setAliasDraft(selectedModel.displayName);
    setConfigDraft({
      pinned: selectedModel.pinned,
      defaultTtlMinutes: String(Math.max(1, Math.round(selectedModel.defaultTtlMs / 60_000))),
      contextLength: selectedModel.contextLength ? String(selectedModel.contextLength) : "",
      gpuLayers: selectedModel.gpuLayers ? String(selectedModel.gpuLayers) : "",
      capabilityOverrides,
    });
  }, [selectedModel?.id]);

  useEffect(() => {
    if (engines.length === 0) {
      setSelectedEngineVersionTag(null);
      return;
    }

    setSelectedEngineVersionTag((current) => {
      if (current && engines.some((engine) => engine.version === current)) {
        return current;
      }

      return engines.find((engine) => engine.active)?.version ?? engines[0]?.version ?? null;
    });
  }, [engines]);

  useEffect(() => {
    if (!isDetailModalOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsDetailModalOpen(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isDetailModalOpen]);

  const openModelDetail = (modelId: string, tab: ModelDetailTab = "details") => {
    onSelectModel(modelId);
    setDetailTab(tab);
    setIsDetailModalOpen(true);
  };

  const closeModelDetail = () => {
    setIsDetailModalOpen(false);
  };

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
        text: "Choose a local GGUF before trying to register it.",
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
        text: error instanceof Error ? error.message : "Unable to register the selected artifact.",
      });
    } finally {
      setPendingImport(false);
    }
  };

  const handleDownloadMetalBinary = async () => {
    setEngineFeedback(null);
    setPendingEngineAction("download");

    try {
      const result = await onInstallEngineBinary({
        action: "download-latest-metal",
      });

      setSelectedEngineVersionTag(result.engine.version);
      setEngineFeedback({
        tone: "success",
        title: "Install complete",
        text: `Installed ${result.engine.version} into ${result.engine.binaryPath}.`,
      });
    } catch (error) {
      setEngineFeedback({
        tone: "error",
        title: "Install blocked",
        text: error instanceof Error ? error.message : "Unable to download the Metal binary.",
      });
    } finally {
      setPendingEngineAction(null);
    }
  };

  const handleImportLocalBinary = async () => {
    setEngineFeedback(null);

    const filePath = await onPickEngineBinaryFile();
    if (!filePath) {
      return;
    }

    setPendingEngineAction("import");
    try {
      const result = await onInstallEngineBinary({
        action: "import-local-binary",
        filePath,
      });

      setSelectedEngineVersionTag(result.engine.version);
      setEngineFeedback({
        tone: "success",
        title: "Install complete",
        text: `Packaged ${result.engine.version} into ${result.engine.binaryPath}.`,
      });
    } catch (error) {
      setEngineFeedback({
        tone: "error",
        title: "Install blocked",
        text: error instanceof Error ? error.message : "Unable to package the selected binary.",
      });
    } finally {
      setPendingEngineAction(null);
    }
  };

  const handleActivateEngineVersion = async () => {
    if (!selectedEngineVersion) {
      return;
    }

    setEngineFeedback(null);
    setPendingEngineAction("activate");

    try {
      const result = await onActivateEngineVersion(selectedEngineVersion);

      setSelectedEngineVersionTag(result.engine.version);
      setEngineFeedback({
        tone: "success",
        title: "Version activated",
        text: `Activated ${result.engine.version}. Future launches will use that llama.cpp binary.`,
      });
    } catch (error) {
      setEngineFeedback({
        tone: "error",
        title: "Action blocked",
        text: error instanceof Error ? error.message : "Unable to activate the selected version.",
      });
    } finally {
      setPendingEngineAction(null);
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

  const saveAdvancedConfig = async () => {
    if (!selectedModel) {
      return;
    }

    setPendingActionModelId(selectedModel.id);
    setFeedback(null);

    try {
      const defaultTtlMinutes = Math.max(1, Number.parseInt(configDraft.defaultTtlMinutes, 10) || 15);
      const result = await onUpdateModelConfig(selectedModel.id, {
        pinned: configDraft.pinned,
        defaultTtlMs: defaultTtlMinutes * 60_000,
        ...(configDraft.contextLength.trim()
          ? { contextLength: Number.parseInt(configDraft.contextLength, 10) }
          : {}),
        ...(configDraft.gpuLayers.trim()
          ? { gpuLayers: Number.parseInt(configDraft.gpuLayers, 10) }
          : {}),
        capabilityOverrides: toCapabilityOverrides(configDraft.capabilityOverrides),
      });
      setConfigDraft({
        pinned: result.model.pinned,
        defaultTtlMinutes: String(Math.max(1, Math.round(result.model.defaultTtlMs / 60_000))),
        contextLength: result.model.contextLength ? String(result.model.contextLength) : "",
        gpuLayers: result.model.gpuLayers ? String(result.model.gpuLayers) : "",
        capabilityOverrides: createCapabilityDraft(result.model.capabilityOverrides),
      });
      setFeedback({
        tone: "success",
        text: `Saved cold-start settings for ${selectedModel.displayName}. Changes apply on the next preload.`,
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
      <article className="hero-card model-runtime-hero">
        <div>
          <span className="section-label">Model library</span>
          <h3>Manage a live local model end to end</h3>
          <p>
            Register a GGUF from disk, inspect real metadata, and move it between cold and ready
            runtime states without leaving the desktop shell.
          </p>
        </div>
        <div className="hero-actions">
          <button className="primary-button" onClick={() => void handlePickImport()} type="button">
            Pick local GGUF
          </button>
          <div className="hero-stat-grid">
            <div className="hero-stat">
              <span className="section-label">Registered</span>
              <strong>{models.length}</strong>
            </div>
            <div className="hero-stat">
              <span className="section-label">Ready now</span>
              <strong>{models.filter((model) => model.state === "ready").length}</strong>
            </div>
          </div>
        </div>
      </article>

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
            <p>{connected ? "Select a model to inspect runtime and artifact details." : shellState.message}</p>
          </div>

          {models.length === 0 ? (
            <div className="empty-panel">
              <strong>No local models registered yet.</strong>
              <p>Pick a GGUF and register it to unlock the runtime detail view and preload controls.</p>
            </div>
          ) : (
            <div className="model-list">
              {models.map((model) => (
                <button
                  className={model.id === selectedModel?.id ? "model-list-item model-list-item-active" : "model-list-item"}
                  key={model.id}
                  onClick={() => openModelDetail(model.id)}
                  type="button"
                >
                  <div className="model-card-head">
                    <div>
                      <span className="section-label">{model.engineType}</span>
                      <h4>{model.displayName}</h4>
                    </div>
                    <span className={`status-pill ${getStateToneClass(model.state)}`}>{humanize(model.state)}</span>
                  </div>
                  <p>{describeModel(model)}</p>
                  <dl className="meta-grid compact-meta-grid">
                    <div>
                      <dt>Artifact</dt>
                      <dd>{formatBytes(model.sizeBytes)}</dd>
                    </div>
                    <div>
                      <dt>Context</dt>
                      <dd>{model.contextLength ?? "Unknown"}</dd>
                    </div>
                    <div>
                      <dt>Status</dt>
                      <dd>{humanize(model.artifactStatus)}</dd>
                    </div>
                    <div>
                      <dt>Last used</dt>
                      <dd>{formatTime(model.lastUsedAt)}</dd>
                    </div>
                  </dl>
                </button>
              ))}
            </div>
          )}
        </article>

        <article className="wide-card detail-panel">
          {selectedModel ? (
            <>
              <div className="panel-header">
                <div>
                  <span className="section-label">Model popup</span>
                  <h3>{selectedModel.displayName}</h3>
                </div>
                <button className="primary-button" onClick={() => openModelDetail(selectedModel.id)} type="button">
                  Open popup
                </button>
              </div>

              <p>
                The popup contains the full model detail view, runtime controls, and config
                overrides in separate tabs.
              </p>
            </>
          ) : (
            <div className="empty-panel">
              <strong>Select a registered model.</strong>
              <p>The popup will surface GGUF metadata, engine information, and lifecycle actions.</p>
            </div>
          )}
        </article>
      </div>

      {selectedModel && isDetailModalOpen ? (
        <div
          className="model-detail-modal-backdrop"
          onClick={closeModelDetail}
          role="presentation"
        >
          <div
            aria-labelledby="model-detail-modal-title"
            aria-modal="true"
            className="model-detail-modal"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
          >
            <div className="modal-shell-header">
              <div>
                <span className="section-label">Model popup</span>
                <h3 id="model-detail-modal-title">{selectedModel.displayName}</h3>
                <p>{describeModel(selectedModel)}</p>
              </div>
              <div className="modal-shell-actions">
                <button className="secondary-button" onClick={closeModelDetail} type="button">
                  Close
                </button>
              </div>
            </div>

            <div className="modal-tabbar" role="tablist" aria-label="Model popup tabs">
              <button
                aria-selected={detailTab === "details"}
                className={detailTab === "details" ? "modal-tab modal-tab-active" : "modal-tab"}
                onClick={() => setDetailTab("details")}
                role="tab"
                type="button"
              >
                Model details
              </button>
              <button
                aria-selected={detailTab === "config"}
                className={detailTab === "config" ? "modal-tab modal-tab-active" : "modal-tab"}
                onClick={() => setDetailTab("config")}
                role="tab"
                type="button"
              >
                Model config overrides
              </button>
            </div>

            {detailTab === "details" ? (
              <div className="modal-panel" role="tabpanel">
                <div className="detail-actions">
                  <button
                    className="primary-button"
                    disabled={detailModelActionDisabled}
                    onClick={() => void runModelAction(detailModelAction)}
                    type="button"
                  >
                    {detailModelActionLabel}
                  </button>
                </div>

                {selectedModel.errorMessage ? (
                  <div className="detail-alert">
                    <strong>Last runtime error</strong>
                    <p>{selectedModel.errorMessage}</p>
                  </div>
                ) : null}

                <dl className="meta-grid modal-meta-grid">
                  <div>
                    <dt>Artifact path</dt>
                    <dd>{selectedModel.localPath}</dd>
                  </div>
                  <div>
                    <dt>Format</dt>
                    <dd>{selectedModel.format.toUpperCase()}</dd>
                  </div>
                  <div>
                    <dt>Artifact size</dt>
                    <dd>{formatBytes(selectedModel.sizeBytes)}</dd>
                  </div>
                  <div>
                    <dt>Runtime role</dt>
                    <dd>{humanize(selectedModel.role)}</dd>
                  </div>
                  <div>
                    <dt>Architecture</dt>
                    <dd>{selectedModel.architecture ?? "Unknown"}</dd>
                  </div>
                  <div>
                    <dt>Quantization</dt>
                    <dd>{selectedModel.quantization ?? "Unknown"}</dd>
                  </div>
                  <div>
                    <dt>Context length</dt>
                    <dd>{selectedModel.contextLength ?? "Unknown"}</dd>
                  </div>
                  <div>
                    <dt>Parameter count</dt>
                    <dd>{selectedModel.parameterCount?.toLocaleString() ?? "Unknown"}</dd>
                  </div>
                  <div>
                    <dt>Tokenizer</dt>
                    <dd>{selectedModel.tokenizer ?? "Unknown"}</dd>
                  </div>
                  <div>
                    <dt>Warm TTL</dt>
                    <dd>{formatTtl(selectedModel.defaultTtlMs)}</dd>
                  </div>
                  <div>
                    <dt>GPU layers</dt>
                    <dd>{selectedModel.gpuLayers ?? "Auto"}</dd>
                  </div>
                  <div>
                    <dt>Engine version</dt>
                    <dd>{selectedModel.engineVersion ?? "Materializes on first preload"}</dd>
                  </div>
                  <div>
                    <dt>Last used</dt>
                    <dd>{formatTime(selectedModel.lastUsedAt)}</dd>
                  </div>
                </dl>

                <div className="detail-meta-note">
                  <strong>Metadata hint</strong>
                  <p>{modelMetadataHint}</p>
                </div>

                <div className="pill-row">
                  {selectedModel.tags.length > 0 ? selectedModel.tags.map((tag) => (
                    <span className="meta-pill" key={tag}>
                      #{tag}
                    </span>
                  )) : <span className="meta-pill meta-pill-muted">No tags</span>}
                  {selectedModel.capabilities.map((capability) => (
                    <span className="meta-pill" key={capability}>
                      {humanize(capability)}
                    </span>
                  ))}
                </div>
            </div>
          ) : (
              <div className="modal-panel" role="tabpanel">
                <div className="advanced-config-card modal-section-card">
                  <div className="panel-header">
                    <div>
                      <span className="section-label">Alias name</span>
                      <h3>Rename this model</h3>
                    </div>
                    <span className="status-pill status-pill-positive">No eviction needed</span>
                  </div>
                  <p>
                    Give the model a friendly alias without touching the artifact name or restarting
                    the worker.
                  </p>

                  <label className="field-stack">
                    <span className="section-label">Alias name</span>
                    <input
                      className="text-input"
                      disabled={!connected || pendingActionModelId !== null}
                      onChange={(event) => setAliasDraft(event.target.value)}
                      type="text"
                      value={aliasDraft}
                    />
                  </label>

                  <div className="button-row">
                    <button
                      className="secondary-button"
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
                    Leave a capability on <strong>Inherit</strong> to keep the heuristic default
                    from the GGUF artifact. Explicit overrides are saved to the profile and apply
                    on the next preload.
                  </p>

                  <div className="capability-override-list">
                    {capabilityDefinitions.map(({ key, label, description }) => (
                      <label className="capability-override-row" key={key}>
                        <div className="capability-override-copy">
                          <strong>{label}</strong>
                          <span>{description}</span>
                        </div>
                        <select
                          className="text-input capability-override-select"
                          disabled={!canSaveConfig}
                          onChange={(event) =>
                            setConfigDraft((current) => ({
                              ...current,
                              capabilityOverrides: {
                                ...current.capabilityOverrides,
                                [key]: event.target.value as CapabilityToggleValue,
                              },
                            }))
                          }
                          value={configDraft.capabilityOverrides[key]}
                        >
                          <option value="inherit">Inherit</option>
                          <option value="enabled">Enabled</option>
                          <option value="disabled">Disabled</option>
                        </select>
                      </label>
                    ))}
                  </div>

                  <div className="capability-override-summary">
                    <span className="section-label">Current overrides</span>
                    <div className="pill-row">
                      {hasCapabilityOverrides ? (
                        capabilityDefinitions
                          .filter(({ key }) => selectedModel.capabilityOverrides[key] !== undefined)
                          .map(({ key, label }) => {
                            const value = selectedModel.capabilityOverrides[key];
                            return (
                              <span className="meta-pill" key={key}>
                                {label}: {formatCapabilityToggle(value === true ? "enabled" : "disabled")}
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
                      <span className="section-label">Advanced configuration</span>
                      <h3>Safe cold-start overrides</h3>
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
                    These settings persist to the model profile and apply on the next preload.
                    Loaded workers must be evicted first so the runtime key stays consistent.
                  </p>

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
                  </div>

                  <label className="checkbox-row">
                    <input
                      checked={configDraft.pinned}
                      disabled={!canSaveConfig}
                      onChange={(event) =>
                        setConfigDraft((current) => ({ ...current, pinned: event.target.checked }))
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
              </div>
            )}
          </div>
        </div>
      ) : null}

      <div className="screen-grid">
        <article className="info-card">
          <span className="section-label">Import and register</span>
          <h3>Local GGUF intake</h3>
          <p>
            The desktop shell only asks the gateway to register artifacts after you pick them
            through the preload-safe dialog.
          </p>

          <div className="import-preview">
            <strong>Selected artifact</strong>
            <span>{importFilePath ?? "No local GGUF selected yet."}</span>
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
            <button className="secondary-button" onClick={() => void handlePickImport()} type="button">
              Choose GGUF
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

        <article className="info-card">
          <span className="section-label">Engine versions</span>
          <h3>Resolved runtime binaries</h3>
          <p>
            The gateway records the engine version that actually served the worker so the desktop
            detail view can show what is running.
          </p>

          <div className="button-row">
            <button
              className="primary-button"
              disabled={!connected || pendingEngineAction !== null}
              onClick={() => void handleDownloadMetalBinary()}
              type="button"
            >
              {pendingEngineAction === "download" ? "Downloading..." : "Download Metal build"}
            </button>
            <button
              className="secondary-button"
              disabled={!connected || pendingEngineAction !== null}
              onClick={() => void handleImportLocalBinary()}
              type="button"
            >
              {pendingEngineAction === "import" ? "Packaging..." : "Import local binary"}
            </button>
          </div>

          <p className="search-detail-note">
            Downloaded Metal builds are copied into the app support engines directory. Local binary
            imports are packaged the same way so the app owns the installed executable. Use the
            picker below to switch the active version for future launches.
          </p>

          {engines.length > 0 ? (
            <>
              <label className="field-stack">
                <span className="section-label">Active llama.cpp version</span>
                <select
                  className="text-input"
                  disabled={!connected || pendingEngineAction !== null}
                  onChange={(event) => setSelectedEngineVersionTag(event.target.value)}
                  value={selectedEngineVersion ?? ""}
                >
                  {engines.map((engine) => (
                    <option key={engine.id} value={engine.version}>
                      {engine.version}
                      {engine.active ? " (active)" : ""}
                    </option>
                  ))}
                </select>
              </label>

              <div className="button-row">
                <button
                  className="primary-button"
                  disabled={!connected || !selectedEngineVersion || pendingEngineAction !== null}
                  onClick={() => void handleActivateEngineVersion()}
                  type="button"
                >
                  {pendingEngineAction === "activate" ? "Activating..." : "Activate selected version"}
                </button>
              </div>

              <p className="search-detail-note">
                Switching versions updates the registry used for future worker launches. Existing
                workers keep running until they are evicted or restarted.
              </p>
            </>
          ) : null}

          {engineFeedback ? (
            <div
              className={
                engineFeedback.tone === "error"
                  ? "detail-alert feedback-card-error"
                  : "detail-alert"
              }
            >
              <strong>{engineFeedback.title}</strong>
              <p>{engineFeedback.text}</p>
            </div>
          ) : null}

          {engines.length === 0 ? (
            <div className="empty-panel compact-empty">
              <strong>No engine versions recorded yet.</strong>
              <p>The first preload will materialize the resolved llama.cpp harness here.</p>
            </div>
          ) : (
            <div className="engine-list">
              {engines.map((engine) => (
                <div className={engine.active ? "engine-card engine-card-active" : "engine-card"} key={engine.id}>
                  <div className="model-card-head">
                    <div>
                      <span className="section-label">{engine.engineType}</span>
                      <h4>{engine.version}</h4>
                    </div>
                    <span className={engine.active ? "status-pill status-pill-positive" : "status-pill status-pill-neutral"}>
                      {engine.active ? "Active" : "Installed"}
                    </span>
                  </div>
                  <p>{engine.compatibilityNotes ?? "Resolved engine binary."}</p>
                  <dl className="meta-grid compact-meta-grid">
                    <div>
                      <dt>Channel</dt>
                      <dd>{engine.channel}</dd>
                    </div>
                    <div>
                      <dt>Installed</dt>
                      <dd>{engine.installed ? "Yes" : "No"}</dd>
                    </div>
                  </dl>
                </div>
              ))}
            </div>
          )}
        </article>
      </div>
    </section>
  );
}
