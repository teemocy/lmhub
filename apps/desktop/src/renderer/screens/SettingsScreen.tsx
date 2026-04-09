import type { ControlAuthHeaderName, DesktopShellState } from "@localhub/shared-contracts";
import { useEffect, useState } from "react";

type DesktopSystemPaths = {
  workspaceRoot: string;
  supportDir: string;
  logsDir: string;
  sessionLogFile: string;
  discoveryFile: string;
};

type DesktopRuntimeContext = {
  desktop: {
    closeToTray: boolean;
    autoLaunchGateway: boolean;
    theme: "system" | "light" | "dark";
    controlAuthHeaderName: ControlAuthHeaderName;
    controlAuthToken?: string;
  };
  gateway: {
    enableLan: boolean;
    authRequired: boolean;
    publicHost: string;
    publicPort: number;
    controlHost: string;
    corsAllowlist: string[];
    defaultModelTtlMs: number;
    maxActiveModelsInMemory: number;
    localModelsDir: string;
    publicAuthToken?: string;
  };
  files: {
    desktopConfigFile: string;
    gatewayConfigFile: string;
  };
};

type SettingsScreenProps = {
  shellState: DesktopShellState;
  paths: DesktopSystemPaths | null;
  runtimeContext: DesktopRuntimeContext | null;
  onPickModelsDirectory(): Promise<string | null>;
  onRestartGateway(): Promise<void>;
  onShutdownGateway(): Promise<void>;
  onUpdateGatewaySettings(payload: {
    publicHost: string;
    publicPort: number;
    maxActiveModelsInMemory: number;
    apiAuthToken: string;
  }): Promise<void>;
  onUpdateModelsDirectory(modelsDir: string): Promise<void>;
};

const FIRST_RUN_KEY = "localhub.desktop.stage4.firstRunDismissed";

const isLoopbackHost = (host: string): boolean => {
  const normalized = host.trim().toLowerCase();
  return normalized === "localhost" || normalized === "::1" || normalized.startsWith("127.");
};

export function SettingsScreen({
  shellState,
  paths,
  runtimeContext,
  onPickModelsDirectory,
  onRestartGateway,
  onShutdownGateway,
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
  const currentMaxActiveModelsInMemory = runtimeContext?.gateway.maxActiveModelsInMemory;

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
