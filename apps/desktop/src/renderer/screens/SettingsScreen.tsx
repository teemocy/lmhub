import type {
  DesktopEngineInstallRequest,
  DesktopEngineInstallResponse,
  DesktopEngineRecord,
  DesktopRuntimeContext,
  DesktopShellState,
} from "@localhub/shared-contracts";
import { useEffect, useState } from "react";

type DesktopSystemPaths = {
  workspaceRoot: string;
  supportDir: string;
  logsDir: string;
  sessionLogFile: string;
  discoveryFile: string;
};

type SettingsScreenProps = {
  engines: DesktopEngineRecord[];
  shellState: DesktopShellState;
  paths: DesktopSystemPaths | null;
  runtimeContext: DesktopRuntimeContext | null;
  onPickEngineBinaryFile(): Promise<string | null>;
  onPickModelsDirectory(): Promise<string | null>;
  onRestartGateway(): Promise<void>;
  onShutdownGateway(): Promise<void>;
  onInstallEngineBinary(
    payload: DesktopEngineInstallRequest,
  ): Promise<DesktopEngineInstallResponse>;
  onActivateEngineVersion(payload: {
    engineType: "llama.cpp" | "mlx";
    versionTag: string;
  }): Promise<DesktopEngineInstallResponse>;
  onUpdateGatewaySettings(payload: {
    publicHost: string;
    publicPort: number;
    maxActiveModelsInMemory: number;
    apiAuthToken: string;
  }): Promise<void>;
  onUpdateModelsDirectory(modelsDir: string): Promise<void>;
};

const FIRST_RUN_KEY = "localhub.desktop.stage4.firstRunDismissed";

type EngineFeedbackState = {
  tone: "success" | "error";
  title: string;
  text: string;
} | null;

const isLoopbackHost = (host: string): boolean => {
  const normalized = host.trim().toLowerCase();
  return normalized === "localhost" || normalized === "::1" || normalized.startsWith("127.");
};

export function SettingsScreen({
  engines,
  shellState,
  paths,
  runtimeContext,
  onPickEngineBinaryFile,
  onPickModelsDirectory,
  onRestartGateway,
  onShutdownGateway,
  onInstallEngineBinary,
  onActivateEngineVersion,
  onUpdateGatewaySettings,
  onUpdateModelsDirectory,
}: SettingsScreenProps) {
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [busyAction, setBusyAction] = useState<
    "restart" | "shutdown" | "gateway-settings" | "models-dir" | null
  >(null);
  const [pathFeedback, setPathFeedback] = useState<{
    tone: "success" | "error";
    text: string;
  } | null>(null);
  const [gatewaySettingsFeedback, setGatewaySettingsFeedback] = useState<{
    tone: "success" | "error";
    text: string;
  } | null>(null);
  const [modelsDirDraft, setModelsDirDraft] = useState("");
  const [publicHostDraft, setPublicHostDraft] = useState("");
  const [publicPortDraft, setPublicPortDraft] = useState("");
  const [maxActiveModelsDraft, setMaxActiveModelsDraft] = useState("");
  const [apiAuthTokenDraft, setApiAuthTokenDraft] = useState("");
  const [pendingEngineAction, setPendingEngineAction] = useState<
    "download" | "import" | "install-mlx" | "activate" | null
  >(null);
  const [engineFeedback, setEngineFeedback] = useState<EngineFeedbackState>(null);
  const [selectedEngineVersionTag, setSelectedEngineVersionTag] = useState<string | null>(null);
  const currentMaxActiveModelsInMemory = runtimeContext?.gateway.maxActiveModelsInMemory;
  const connected = shellState.phase === "connected";
  const llamaSupported = runtimeContext?.llama.supported ?? false;
  const llamaUpdateAvailable = runtimeContext?.llama.updateAvailable ?? false;
  const llamaActiveSource = runtimeContext?.llama.activeSource;
  const latestLlamaReleaseTag = runtimeContext?.llama.latestReleaseTag ?? null;
  const mlxSupported = runtimeContext?.mlx.supported ?? false;
  const mlxInstalled = runtimeContext?.mlx.installed ?? false;
  const mlxUpdateAvailable = runtimeContext?.mlx.updateAvailable ?? false;
  const latestMlxVersionTag = runtimeContext?.mlx.latestVersionTag;
  const latestMlxRuntimeLabel =
    runtimeContext?.mlx.latestMlxVersion && runtimeContext?.mlx.latestMlxLmVersion
      ? `mlx ${runtimeContext.mlx.latestMlxVersion} / mlx-lm ${runtimeContext.mlx.latestMlxLmVersion}`
      : null;
  const activeEngineVersionTag =
    engines.find((engine) => engine.active)?.version ?? engines[0]?.version ?? null;
  const selectedEngineVersion =
    selectedEngineVersionTag &&
    engines.some((engine) => engine.version === selectedEngineVersionTag)
      ? (engines.find((engine) => engine.version === selectedEngineVersionTag) ?? null)
      : (engines.find((engine) => engine.version === activeEngineVersionTag) ?? null);

  useEffect(() => {
    const dismissed = window.localStorage.getItem(FIRST_RUN_KEY) === "true";
    setShowOnboarding(!dismissed);
  }, []);

  useEffect(() => {
    if (runtimeContext?.gateway.localModelsDir) {
      setModelsDirDraft(runtimeContext.gateway.localModelsDir);
    }
  }, [runtimeContext?.gateway.localModelsDir]);

  useEffect(() => {
    if (runtimeContext?.gateway.publicHost) {
      setPublicHostDraft(runtimeContext.gateway.publicHost);
      setPublicPortDraft(String(runtimeContext.gateway.publicPort));
    }
  }, [runtimeContext?.gateway.publicHost, runtimeContext?.gateway.publicPort]);

  useEffect(() => {
    if (currentMaxActiveModelsInMemory !== undefined) {
      setMaxActiveModelsDraft(String(currentMaxActiveModelsInMemory));
    }
  }, [currentMaxActiveModelsInMemory]);

  useEffect(() => {
    setApiAuthTokenDraft(
      runtimeContext?.gateway.publicAuthToken ?? runtimeContext?.desktop.controlAuthToken ?? "",
    );
  }, [runtimeContext?.desktop.controlAuthToken, runtimeContext?.gateway.publicAuthToken]);

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

  const dismissOnboarding = () => {
    window.localStorage.setItem(FIRST_RUN_KEY, "true");
    setShowOnboarding(false);
  };

  const runAction = async (action: "restart" | "shutdown") => {
    setBusyAction(action);
    try {
      if (action === "restart") {
        await onRestartGateway();
      } else {
        await onShutdownGateway();
      }
    } finally {
      setBusyAction(null);
    }
  };

  const pickModelsDirectory = async () => {
    setPathFeedback(null);
    const selected = await onPickModelsDirectory();
    if (selected) {
      setModelsDirDraft(selected);
    }
  };

  const saveModelsDirectory = async () => {
    const nextModelsDir = modelsDirDraft.trim();
    if (!nextModelsDir) {
      setPathFeedback({
        tone: "error",
        text: "Choose a local models directory before saving.",
      });
      return;
    }

    setBusyAction("models-dir");
    setPathFeedback(null);

    try {
      await onUpdateModelsDirectory(nextModelsDir);
      setPathFeedback({
        tone: "success",
        text: "Gateway restarted and will scan the new local models directory.",
      });
    } catch (error) {
      setPathFeedback({
        tone: "error",
        text:
          error instanceof Error ? error.message : "Unable to update the local models directory.",
      });
    } finally {
      setBusyAction(null);
    }
  };

  const saveGatewaySettings = async () => {
    const nextPublicHost = publicHostDraft.trim();
    const nextPublicPort = Number.parseInt(publicPortDraft, 10);
    const parsedMaxActiveModels = Number.parseInt(maxActiveModelsDraft.trim(), 10);

    setGatewaySettingsFeedback(null);

    if (!nextPublicHost) {
      setGatewaySettingsFeedback({
        tone: "error",
        text: "Choose a listening address before saving.",
      });
      return;
    }

    if (!Number.isInteger(nextPublicPort) || nextPublicPort < 1 || nextPublicPort > 65535) {
      setGatewaySettingsFeedback({
        tone: "error",
        text: "Choose a port between 1 and 65535.",
      });
      return;
    }

    if (
      maxActiveModelsDraft.trim().length === 0 ||
      !Number.isInteger(parsedMaxActiveModels) ||
      parsedMaxActiveModels < 0
    ) {
      setGatewaySettingsFeedback({
        tone: "error",
        text: "Use 0 for unlimited, or enter a positive whole number.",
      });
      return;
    }

    setBusyAction("gateway-settings");

    try {
      await onUpdateGatewaySettings({
        publicHost: nextPublicHost,
        publicPort: nextPublicPort,
        maxActiveModelsInMemory: parsedMaxActiveModels,
        apiAuthToken: apiAuthTokenDraft,
      });
      setGatewaySettingsFeedback({
        tone: "success",
        text: "Gateway settings were saved and restarted.",
      });
    } catch (error) {
      setGatewaySettingsFeedback({
        tone: "error",
        text: error instanceof Error ? error.message : "Unable to update gateway settings.",
      });
    } finally {
      setBusyAction(null);
    }
  };

  const handleDownloadMetalBinary = async () => {
    setEngineFeedback(null);
    setPendingEngineAction("download");
    const actionLabel =
      llamaActiveSource === "release"
        ? llamaUpdateAvailable
          ? "Updated"
          : "Reinstalled"
        : "Downloaded";

    try {
      const result = await onInstallEngineBinary({
        action: "download-latest-metal",
      });

      setSelectedEngineVersionTag(result.engine.version);
      setEngineFeedback({
        tone: "success",
        title: llamaUpdateAvailable ? "Runtime updated" : "Runtime ready",
        text: `${actionLabel} llama.cpp Metal build ${result.engine.version}.`,
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
    if (
      !selectedEngineVersion ||
      (selectedEngineVersion.engineType !== "llama.cpp" &&
        selectedEngineVersion.engineType !== "mlx")
    ) {
      return;
    }

    setEngineFeedback(null);
    setPendingEngineAction("activate");

    try {
      const result = await onActivateEngineVersion({
        engineType: selectedEngineVersion.engineType,
        versionTag: selectedEngineVersion.version,
      });

      setSelectedEngineVersionTag(result.engine.version);
      setEngineFeedback({
        tone: "success",
        title: "Version activated",
        text: `Activated ${result.engine.version}. Future launches will use that ${result.engine.engineType} runtime.`,
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

  const handleInstallMlxRuntime = async () => {
    setEngineFeedback(null);
    setPendingEngineAction("install-mlx");
    const actionLabel = !mlxInstalled
      ? "Downloaded"
      : mlxUpdateAvailable
        ? "Updated"
        : "Reinstalled";

    try {
      const result = await onInstallEngineBinary({
        engineType: "mlx",
        action: "install-managed-runtime",
        ...(latestMlxVersionTag ? { versionTag: latestMlxVersionTag } : {}),
        ...(mlxInstalled && !mlxUpdateAvailable ? { forceReinstall: true } : {}),
      });

      setSelectedEngineVersionTag(result.engine.version);
      setEngineFeedback({
        tone: "success",
        title: mlxUpdateAvailable ? "Runtime updated" : "Runtime ready",
        text: `${actionLabel} managed MLX runtime ${result.engine.version}.`,
      });
    } catch (error) {
      setEngineFeedback({
        tone: "error",
        title: "Install blocked",
        text: error instanceof Error ? error.message : "Unable to install the MLX runtime.",
      });
    } finally {
      setPendingEngineAction(null);
    }
  };

  const canSaveModelsDir =
    runtimeContext !== null &&
    busyAction === null &&
    modelsDirDraft.trim().length > 0 &&
    modelsDirDraft.trim() !== runtimeContext.gateway.localModelsDir;

  const normalizedPublicHost = publicHostDraft.trim();
  const parsedPublicPort = Number.parseInt(publicPortDraft, 10);
  const publicListenerIsLoopback = runtimeContext
    ? isLoopbackHost(runtimeContext.gateway.publicHost)
    : true;
  const publicListenerExposed = runtimeContext ? !publicListenerIsLoopback : false;
  const parsedMaxActiveModels = Number.parseInt(maxActiveModelsDraft.trim(), 10);
  const maxActiveModelsValid =
    maxActiveModelsDraft.trim().length > 0 &&
    Number.isInteger(parsedMaxActiveModels) &&
    parsedMaxActiveModels >= 0;
  const canSaveGatewaySettings =
    runtimeContext !== null &&
    busyAction === null &&
    normalizedPublicHost.length > 0 &&
    Number.isInteger(parsedPublicPort) &&
    parsedPublicPort >= 1 &&
    parsedPublicPort <= 65535 &&
    maxActiveModelsValid &&
    (normalizedPublicHost !== runtimeContext.gateway.publicHost ||
      parsedPublicPort !== runtimeContext.gateway.publicPort ||
      parsedMaxActiveModels !== runtimeContext.gateway.maxActiveModelsInMemory ||
      "api-key" !== runtimeContext.desktop.controlAuthHeaderName ||
      apiAuthTokenDraft !==
        (runtimeContext.gateway.publicAuthToken ?? runtimeContext.desktop.controlAuthToken ?? ""));

  const exposureRisk =
    runtimeContext === null
      ? "Loading gateway exposure settings."
      : publicListenerIsLoopback
        ? runtimeContext.gateway.enableLan
          ? "LAN mode is enabled in config, but the public listener is still loopback-only."
          : "Public listener is loopback-only. The gateway is not exposed beyond this machine."
        : runtimeContext.gateway.authRequired
          ? "Public listener is exposed beyond loopback. Keep the API auth key private and review your allowlist before sharing access."
          : "Public listener is exposed beyond loopback without API auth. Treat this as unsafe outside a trusted network.";

  return (
    <section className="screen-stack">
      <article className="hero-card compact-hero">
        <div>
          <span className="section-label">Release hardening</span>
          <h3>Desktop ownership boundaries</h3>
          <p>Stage 4 focuses on safe recovery, explicit shutdown, and honest security messaging.</p>
        </div>
        <span className="status-pill">{shellState.phase}</span>
      </article>

      {showOnboarding ? (
        <article className="wide-card feedback-card">
          <strong>First run checklist</strong>
          <p>
            1. Import a local model or queue a download. 2. Preload only the models you need. 3.
            Review LAN and auth settings before exposing the gateway beyond this machine.
          </p>
          <div className="button-row">
            <button className="secondary-button" onClick={dismissOnboarding} type="button">
              Dismiss onboarding
            </button>
          </div>
        </article>
      ) : null}

      <article
        className={
          runtimeContext !== null && publicListenerExposed && !runtimeContext.gateway.authRequired
            ? "wide-card feedback-card feedback-card-error"
            : runtimeContext !== null && publicListenerExposed
              ? "wide-card feedback-card"
              : "wide-card"
        }
      >
        <span className="section-label">Runtime info</span>
        <h3>Gateway and desktop state</h3>
        <p>{exposureRisk}</p>
        <dl className="settings-grid runtime-status-grid">
          <div>
            <dt>LAN enabled</dt>
            <dd>{runtimeContext?.gateway.enableLan ? "Yes" : "No"}</dd>
          </div>
          <div>
            <dt>Public listener</dt>
            <dd>{publicListenerIsLoopback ? "Loopback-only" : "LAN-exposed"}</dd>
          </div>
          <div>
            <dt>Public auth</dt>
            <dd>{runtimeContext?.gateway.authRequired ? "Enabled" : "Disabled"}</dd>
          </div>
          <div>
            <dt>CORS allowlist</dt>
            <dd>{runtimeContext?.gateway.corsAllowlist.join(", ") ?? "Loading"}</dd>
          </div>
          <div>
            <dt>Close to tray</dt>
            <dd>{runtimeContext?.desktop.closeToTray ? "Enabled" : "Disabled"}</dd>
          </div>
          <div>
            <dt>Auto launch gateway</dt>
            <dd>{runtimeContext?.desktop.autoLaunchGateway ? "Enabled" : "Disabled"}</dd>
          </div>
          <div>
            <dt>Theme</dt>
            <dd>{runtimeContext?.desktop.theme ?? "Loading"}</dd>
          </div>
          <div>
            <dt>Default model TTL</dt>
            <dd>
              {runtimeContext
                ? `${Math.round(runtimeContext.gateway.defaultModelTtlMs / 60_000)} min`
                : "Loading"}
            </dd>
          </div>
          <div>
            <dt>Active model cap</dt>
            <dd>
              {runtimeContext
                ? runtimeContext.gateway.maxActiveModelsInMemory === 0
                  ? "Unlimited"
                  : `${runtimeContext.gateway.maxActiveModelsInMemory} model${runtimeContext.gateway.maxActiveModelsInMemory === 1 ? "" : "s"}`
                : "Loading"}
            </dd>
          </div>
        </dl>
      </article>

      <article className="wide-card">
        <span className="section-label">Engine versions</span>
        <h3>Resolved runtimes</h3>
        <p>
          The gateway records the engine version that actually served the worker so the desktop
          detail view can show what is running across both `llama.cpp` and MLX.
        </p>

        <div className="button-row">
          <button
            className="primary-button"
            disabled={!connected || !llamaSupported || pendingEngineAction !== null}
            onClick={() => void handleDownloadMetalBinary()}
            type="button"
          >
            {pendingEngineAction === "download"
              ? llamaUpdateAvailable
                ? "Updating..."
                : "Downloading..."
              : llamaActiveSource === "release"
                ? llamaUpdateAvailable
                  ? "Update Metal build"
                  : "Reinstall latest Metal build"
                : "Download latest Metal build"}
          </button>
          {mlxSupported ? (
            <button
              className="secondary-button"
              disabled={!connected || pendingEngineAction !== null}
              onClick={() => void handleInstallMlxRuntime()}
              type="button"
            >
              {pendingEngineAction === "install-mlx"
                ? mlxUpdateAvailable
                  ? "Updating..."
                  : "Downloading..."
                : !mlxInstalled
                  ? "Download latest MLX runtime"
                  : mlxUpdateAvailable
                    ? "Update MLX runtime"
                    : "Reinstall latest MLX runtime"}
            </button>
          ) : null}
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
          Downloaded Metal builds and managed MLX runtimes are copied into the app support engines
          directory. Local binary imports are packaged the same way so the app owns the installed
          executable. Use the picker below to switch the active version for future launches.
        </p>
        {mlxSupported && latestMlxRuntimeLabel ? (
          <p className="search-detail-note">
            Latest managed MLX runtime: {latestMlxRuntimeLabel}
            {runtimeContext?.mlx.activeMlxVersion && runtimeContext?.mlx.activeMlxLmVersion
              ? ` · active stack: mlx ${runtimeContext.mlx.activeMlxVersion} / mlx-lm ${runtimeContext.mlx.activeMlxLmVersion}`
              : ""}
            {runtimeContext?.mlx.updateAvailable ? " · update available" : ""}
          </p>
        ) : null}
        {latestLlamaReleaseTag ? (
          <p className="search-detail-note">
            Latest llama.cpp release: {latestLlamaReleaseTag}
            {runtimeContext?.llama.activeReleaseTag
              ? ` · active release: ${runtimeContext.llama.activeReleaseTag}`
              : runtimeContext?.llama.activeVersion
                ? ` · active runtime: ${runtimeContext.llama.activeVersion}`
                : ""}
            {runtimeContext?.llama.activeSource === "manual" ? " · active source: imported binary" : ""}
            {runtimeContext?.llama.updateAvailable ? " · update available" : ""}
          </p>
        ) : runtimeContext?.llama.statusMessage ? (
          <p className="search-detail-note">{runtimeContext.llama.statusMessage}</p>
        ) : null}

        {engines.length > 0 ? (
          <>
            <label className="field-stack">
              <span className="section-label">Active engine version</span>
              <select
                className="text-input"
                disabled={!connected || pendingEngineAction !== null}
                onChange={(event) => setSelectedEngineVersionTag(event.target.value)}
                value={selectedEngineVersion?.version ?? ""}
              >
                {engines.map((engine) => (
                  <option key={engine.id} value={engine.version}>
                    {engine.engineType} / {engine.version}
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
                {pendingEngineAction === "activate"
                  ? "Activating..."
                  : "Activate selected version"}
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
            <p>The first preload or runtime install will materialize the resolved engine here.</p>
          </div>
        ) : (
          <div className="engine-list">
            {engines.map((engine) => (
              <div
                className={engine.active ? "engine-card engine-card-active" : "engine-card"}
                key={engine.id}
              >
                <div className="model-card-head">
                  <div>
                    <span className="section-label">{engine.engineType}</span>
                    <h4>{engine.version}</h4>
                  </div>
                  <span
                    className={
                      engine.active
                        ? "status-pill status-pill-positive"
                        : "status-pill status-pill-neutral"
                    }
                  >
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

      <article className="wide-card">
        <span className="section-label">Gateway</span>
        <h3>Runtime</h3>
        <div className="runtime-envelope-fields">
          <label className="field-stack">
            <span className="section-label">Listening address</span>
            <input
              className="text-input"
              onChange={(event) => setPublicHostDraft(event.target.value)}
              placeholder="127.0.0.1"
              type="text"
              value={publicHostDraft}
            />
          </label>
          <label className="field-stack">
            <span className="section-label">Listening port</span>
            <input
              className="text-input"
              min={1}
              max={65535}
              onChange={(event) => setPublicPortDraft(event.target.value)}
              placeholder="1337"
              step={1}
              type="number"
              value={publicPortDraft}
            />
          </label>
          <label className="field-stack">
            <span className="section-label">Active model cap</span>
            <input
              className="text-input"
              min={0}
              onChange={(event) => setMaxActiveModelsDraft(event.target.value)}
              placeholder="0"
              step={1}
              type="number"
              value={maxActiveModelsDraft}
            />
          </label>
          <label className="field-stack">
            <span className="section-label">API auth key</span>
            <input
              autoComplete="off"
              className="text-input"
              onChange={(event) => setApiAuthTokenDraft(event.target.value)}
              placeholder="Paste your api-key here"
              type="password"
              value={apiAuthTokenDraft}
            />
          </label>
        </div>
        {gatewaySettingsFeedback ? (
          <div
            className={
              gatewaySettingsFeedback.tone === "success"
                ? "detail-alert detail-alert-success"
                : "detail-alert"
            }
          >
            <strong>
              {gatewaySettingsFeedback.tone === "success" ? "Saved" : "Unable to save"}
            </strong>
            <p>{gatewaySettingsFeedback.text}</p>
          </div>
        ) : null}
        <div className="button-row gateway-runtime-actions">
          <button
            className="primary-button"
            disabled={!canSaveGatewaySettings}
            onClick={() => void saveGatewaySettings()}
            type="button"
          >
            {busyAction === "gateway-settings" ? "Saving..." : "Save and restart"}
          </button>
        </div>
      </article>

      <article className="wide-card">
        <span className="section-label">Runtime controls</span>
        <h3>Recovery and shutdown</h3>
        <p>
          Closing the window can keep the daemon alive in the tray. These controls are for explicit
          recovery and deliberate shutdown only.
        </p>
        <div className="button-row">
          <button
            className="primary-button"
            disabled={busyAction !== null}
            onClick={() => void runAction("restart")}
            type="button"
          >
            {busyAction === "restart" ? "Restarting..." : "Restart gateway"}
          </button>
          <button
            className="secondary-button"
            disabled={busyAction !== null}
            onClick={() => void runAction("shutdown")}
            type="button"
          >
            {busyAction === "shutdown" ? "Shutting down..." : "Shutdown gateway"}
          </button>
        </div>
      </article>

      <article className="wide-card">
        <span className="section-label">App support paths</span>
        <div className="settings-grid">
          <div>
            <dt>Workspace root</dt>
            <dd>{paths?.workspaceRoot ?? "Loading"}</dd>
          </div>
          <div>
            <dt>Support directory</dt>
            <dd>{paths?.supportDir ?? "Loading"}</dd>
          </div>
          <div>
            <dt>Discovery file</dt>
            <dd>{paths?.discoveryFile ?? "Loading"}</dd>
          </div>
          <div>
            <dt>Control URL</dt>
            <dd>{shellState.discovery?.controlBaseUrl ?? "Waiting for gateway"}</dd>
          </div>
          <div>
            <dt>Desktop config</dt>
            <dd>{runtimeContext?.files.desktopConfigFile ?? "Loading"}</dd>
          </div>
          <div>
            <dt>Gateway config</dt>
            <dd>{runtimeContext?.files.gatewayConfigFile ?? "Loading"}</dd>
          </div>
        </div>
      </article>

      <article className="wide-card">
        <span className="section-label">Local models</span>
        <h3>Auto-discovered GGUF directory</h3>
        <p>
          The gateway scans this directory at startup and registers any GGUF files it finds. Use the
          folder picker or type an absolute path, then save to restart the gateway.
        </p>
        <div className="settings-grid">
          <label className="field-stack">
            <span className="section-label">Local models directory</span>
            <input
              className="text-input"
              onChange={(event) => setModelsDirDraft(event.target.value)}
              placeholder="/Users/you/.llm_hub/models"
              type="text"
              value={modelsDirDraft}
            />
          </label>
        </div>
        {pathFeedback ? (
          <div
            className={
              pathFeedback.tone === "success" ? "detail-alert detail-alert-success" : "detail-alert"
            }
          >
            <strong>{pathFeedback.tone === "success" ? "Saved" : "Unable to save"}</strong>
            <p>{pathFeedback.text}</p>
          </div>
        ) : null}
        <div className="button-row">
          <button
            className="secondary-button"
            disabled={busyAction !== null}
            onClick={() => void pickModelsDirectory()}
            type="button"
          >
            Browse folder
          </button>
          <button
            className="primary-button"
            disabled={!canSaveModelsDir}
            onClick={() => void saveModelsDirectory()}
            type="button"
          >
            {busyAction === "models-dir" ? "Saving..." : "Save and restart"}
          </button>
        </div>
      </article>

    </section>
  );
}
