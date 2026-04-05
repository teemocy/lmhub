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
    controlHost: string;
    corsAllowlist: string[];
    defaultModelTtlMs: number;
    localModelsDir: string;
    authConfigured: boolean;
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
  onUpdateControlAuthSettings(payload: {
    headerName: ControlAuthHeaderName;
    token: string;
  }): Promise<void>;
  onUpdateModelsDirectory(modelsDir: string): Promise<void>;
};

const FIRST_RUN_KEY = "localhub.desktop.stage4.firstRunDismissed";

export function SettingsScreen({
  shellState,
  paths,
  runtimeContext,
  onPickModelsDirectory,
  onRestartGateway,
  onShutdownGateway,
  onUpdateControlAuthSettings,
  onUpdateModelsDirectory,
}: SettingsScreenProps) {
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [busyAction, setBusyAction] = useState<
    "restart" | "shutdown" | "models-dir" | "auth-settings" | null
  >(null);
  const [pathFeedback, setPathFeedback] = useState<{
    tone: "success" | "error";
    text: string;
  } | null>(null);
  const [authHeaderFeedback, setAuthHeaderFeedback] = useState<{
    tone: "success" | "error";
    text: string;
  } | null>(null);
  const [modelsDirDraft, setModelsDirDraft] = useState("");
  const [controlAuthHeaderDraft, setControlAuthHeaderDraft] =
    useState<ControlAuthHeaderName>("authorization");
  const [controlAuthTokenDraft, setControlAuthTokenDraft] = useState("");

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
    if (runtimeContext?.desktop.controlAuthHeaderName) {
      setControlAuthHeaderDraft(runtimeContext.desktop.controlAuthHeaderName);
    }
  }, [runtimeContext?.desktop.controlAuthHeaderName]);

  useEffect(() => {
    setControlAuthTokenDraft(runtimeContext?.desktop.controlAuthToken ?? "");
  }, [runtimeContext?.desktop.controlAuthToken]);

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

  const saveControlAuthSettings = async () => {
    if (!runtimeContext) {
      return;
    }

    setBusyAction("auth-settings");
    setAuthHeaderFeedback(null);

    try {
      await onUpdateControlAuthSettings({
        headerName: controlAuthHeaderDraft,
        token: controlAuthTokenDraft,
      });
      setAuthHeaderFeedback({
        tone: "success",
        text: "Desktop requests now use the selected auth header and token.",
      });
    } catch (error) {
      setAuthHeaderFeedback({
        tone: "error",
        text: error instanceof Error ? error.message : "Unable to update auth settings.",
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

  const canSaveControlAuthHeader =
    runtimeContext !== null &&
    busyAction === null &&
    (controlAuthHeaderDraft !== runtimeContext.desktop.controlAuthHeaderName ||
      controlAuthTokenDraft !== (runtimeContext.desktop.controlAuthToken ?? ""));

  const lanRisk =
    runtimeContext?.gateway.enableLan && !runtimeContext.gateway.authRequired
      ? "LAN exposure is enabled without bearer auth. Treat this as unsafe outside a trusted network."
      : runtimeContext?.gateway.enableLan
        ? "LAN exposure is enabled. Keep the bearer token private and review your allowlist before sharing access."
        : "Gateway access remains loopback-only by default.";

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
          runtimeContext?.gateway.enableLan
            ? "wide-card feedback-card feedback-card-error"
            : "wide-card"
        }
      >
        <span className="section-label">Security posture</span>
        <h3>LAN and bearer auth</h3>
        <p>{lanRisk}</p>
        <dl className="settings-grid">
          <div>
            <dt>LAN enabled</dt>
            <dd>{runtimeContext?.gateway.enableLan ? "Yes" : "No"}</dd>
          </div>
          <div>
            <dt>Auth required</dt>
            <dd>{runtimeContext?.gateway.authRequired ? "Yes" : "No"}</dd>
          </div>
          <div>
            <dt>Token configured</dt>
            <dd>{runtimeContext?.gateway.authConfigured ? "Yes" : "No"}</dd>
          </div>
          <div>
            <dt>CORS allowlist</dt>
            <dd>{runtimeContext?.gateway.corsAllowlist.join(", ") ?? "Loading"}</dd>
          </div>
        </dl>
      </article>

      <article className="wide-card">
        <span className="section-label">Control-plane headers</span>
        <h3>Outbound auth header</h3>
        <p>
          Choose the header name and secret the desktop sends when it talks to the gateway. The
          gateway accepts bearer and API-key style headers either way.
        </p>
        <div className="settings-grid">
          <label className="field-stack">
            <span className="section-label">Header format</span>
            <select
              className="text-input"
              onChange={(event) =>
                setControlAuthHeaderDraft(event.target.value as ControlAuthHeaderName)
              }
              value={controlAuthHeaderDraft}
            >
              <option value="authorization">Authorization: Bearer</option>
              <option value="x-api-key">x-api-key</option>
              <option value="api-key">api-key</option>
            </select>
          </label>
          <label className="field-stack">
            <span className="section-label">API key</span>
            <input
              autoComplete="off"
              className="text-input"
              onChange={(event) => setControlAuthTokenDraft(event.target.value)}
              placeholder="Paste your API key here"
              type="password"
              value={controlAuthTokenDraft}
            />
          </label>
        </div>
        {authHeaderFeedback ? (
          <div
            className={
              authHeaderFeedback.tone === "success"
                ? "detail-alert detail-alert-success"
                : "detail-alert"
            }
          >
            <strong>{authHeaderFeedback.tone === "success" ? "Saved" : "Unable to save"}</strong>
            <p>{authHeaderFeedback.text}</p>
          </div>
        ) : null}
        <div className="button-row">
          <button
            className="primary-button"
            disabled={!canSaveControlAuthHeader}
            onClick={() => void saveControlAuthSettings()}
            type="button"
          >
            {busyAction === "auth-settings" ? "Saving..." : "Save auth settings"}
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

      <article className="wide-card">
        <span className="section-label">Desktop behavior</span>
        <div className="settings-grid">
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
        </div>
      </article>
    </section>
  );
}
