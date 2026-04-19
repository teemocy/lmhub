import type {
  DesktopEngineInstallRequest,
  DesktopEngineInstallResponse,
  DesktopEngineRecord,
  DesktopLocalModelImportRequest,
  DesktopLocalModelImportResponse,
  DesktopModelConfigUpdateRequest,
  DesktopModelConfigUpdateResponse,
  DesktopModelDeleteResponse,
  DesktopModelRecord,
  DesktopRuntimeContext,
  DesktopShellState,
  GatewayEvent,
  GatewayHealthSnapshot,
  ModelSummary,
} from "@localhub/shared-contracts";
import { startTransition, useEffect, useState } from "react";
import { HashRouter, NavLink, Route, Routes } from "react-router-dom";
import { BACKGROUND_REFRESH_INTERVAL_MS } from "./constants";
import { ChatScreen } from "./screens/ChatScreen";
import { DashboardScreen } from "./screens/DashboardScreen";
import { DownloadsScreen } from "./screens/DownloadsScreen";
import { ModelsScreen } from "./screens/ModelsScreen";
import { ObservabilityScreen } from "./screens/ObservabilityScreen";
import { SettingsScreen } from "./screens/SettingsScreen";

type DesktopSystemPaths = {
  workspaceRoot: string;
  supportDir: string;
  logsDir: string;
  sessionLogFile: string;
  discoveryFile: string;
};

const initialShellState: DesktopShellState = {
  phase: "idle",
  progress: 0,
  message: "Renderer waiting for preload bridge.",
  discovery: null,
  lastError: null,
  startedAt: null,
  lastEventAt: null,
};

const navItems = [
  { to: "/", label: "Overview" },
  { to: "/models", label: "Model Library" },
  { to: "/downloads", label: "Downloads" },
  { to: "/chat", label: "Chat Sandbox" },
  { to: "/observability", label: "Observability" },
  { to: "/settings", label: "Settings" },
] as const;

const formatClock = (value?: string | null): string => {
  if (!value) {
    return "Not yet";
  }

  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
};

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

const describeModel = (model: DesktopModelRecord): string => {
  const facets = [model.role, model.format, model.architecture, model.quantization]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.replace(/-/g, " "));

  return facets.length > 0 ? facets.join(" • ") : "Registered local model.";
};

const toModelSummary = (model: DesktopModelRecord): ModelSummary => ({
  id: model.id,
  name: model.displayName,
  engine: model.engineType,
  state: model.state,
  sizeLabel: formatBytes(model.sizeBytes),
  tags: model.tags,
  capabilities: model.capabilities,
  ...(model.contextLength !== undefined ? { contextLength: model.contextLength } : {}),
  description: describeModel(model),
  ...(model.lastUsedAt ? { lastUsedAt: model.lastUsedAt } : {}),
});

export function App() {
  const [shellState, setShellState] = useState(initialShellState);
  const [modelLibrary, setModelLibrary] = useState<DesktopModelRecord[]>([]);
  const [engines, setEngines] = useState<DesktopEngineRecord[]>([]);
  const [health, setHealth] = useState<GatewayHealthSnapshot | null>(null);
  const [paths, setPaths] = useState<DesktopSystemPaths | null>(null);
  const [runtimeContext, setRuntimeContext] = useState<DesktopRuntimeContext | null>(null);
  const [events, setEvents] = useState<GatewayEvent[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const [recoveryBusy, setRecoveryBusy] = useState<"restart" | "shutdown" | null>(null);

  useEffect(() => {
    let disposed = false;

    void window.desktopApi.shell.getState().then((state) => {
      if (!disposed) {
        setShellState(state);
      }
    });

    void window.desktopApi.system.getPaths().then((value) => {
      if (!disposed) {
        setPaths(value);
      }
    });
    void window.desktopApi.system.getRuntimeContext().then((value) => {
      if (!disposed) {
        setRuntimeContext(value);
      }
    });

    const unsubscribeState = window.desktopApi.shell.onStateChange((state) => {
      startTransition(() => {
        setShellState(state);
      });
    });

    const unsubscribeEvents = window.desktopApi.gateway.subscribeEvents((event) => {
      startTransition(() => {
        setEvents((current) => [event, ...current].slice(0, 100));
      });

      if (event.type === "MODEL_STATE_CHANGED") {
        startTransition(() => {
          setRefreshKey((current) => current + 1);
        });
      }
    });

    return () => {
      disposed = true;
      unsubscribeState();
      unsubscribeEvents();
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey intentionally retriggers this polling effect.
  useEffect(() => {
    if (shellState.phase !== "connected") {
      return;
    }

    let cancelled = false;

    const refresh = async () => {
      const [library, engineList, healthSnapshot, context] = await Promise.all([
        window.desktopApi.gateway.listModelLibrary(),
        window.desktopApi.gateway.listEngines(),
        window.desktopApi.gateway.getHealth(),
        window.desktopApi.system.getRuntimeContext(),
      ]);

      if (!cancelled) {
        setModelLibrary(library.data);
        setEngines(engineList.data);
        setHealth(healthSnapshot);
        setRuntimeContext(context);
      }
    };

    void refresh();

    const interval = window.setInterval(() => {
      void refresh();
    }, BACKGROUND_REFRESH_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [refreshKey, shellState.phase]);

  useEffect(() => {
    if (modelLibrary.length === 0) {
      setSelectedModelId(null);
      return;
    }

    const firstModelId = modelLibrary[0]?.id;
    if (!firstModelId) {
      setSelectedModelId(null);
      return;
    }

    setSelectedModelId((current) =>
      current && modelLibrary.some((model) => model.id === current) ? current : firstModelId,
    );
  }, [modelLibrary]);

  const modelSummaries = modelLibrary.map((model) => toModelSummary(model));
  const chatModelSummaries = modelSummaries.filter((model) => model.capabilities.includes("chat"));
  const activeEngineCount = engines.filter((engine) => engine.active).length;
  const registeredModelCount = modelLibrary.length;
  const readyModelCount = modelLibrary.filter((model) => model.state === "ready").length;

  const requestRefresh = () => {
    startTransition(() => {
      setRefreshKey((current) => current + 1);
    });
  };

  const refreshRuntimeContext = async (): Promise<void> => {
    const context = await window.desktopApi.system.getRuntimeContext();
    startTransition(() => {
      setRuntimeContext(context);
    });
  };

  const pickLocalModel = async (): Promise<string | null> => {
    const result = await window.desktopApi.gateway.openModelFileDialog();
    if (result.canceled) {
      return null;
    }

    return result.filePaths[0] ?? null;
  };

  const pickEngineBinary = async (): Promise<string | null> => {
    const result = await window.desktopApi.gateway.openEngineBinaryDialog();
    if (result.canceled) {
      return null;
    }

    return result.filePaths[0] ?? null;
  };

  const pickModelsDirectory = async (): Promise<string | null> => {
    const result = await window.desktopApi.system.pickModelsDirectory();
    if (result.canceled) {
      return null;
    }

    return result.filePaths[0] ?? null;
  };

  const registerLocalModel = async (
    payload: DesktopLocalModelImportRequest,
  ): Promise<DesktopLocalModelImportResponse> => {
    const result = await window.desktopApi.gateway.registerLocalModel(payload);

    setSelectedModelId(result.model.id);
    requestRefresh();

    return result;
  };

  const installEngineBinary = async (
    payload: DesktopEngineInstallRequest,
  ): Promise<DesktopEngineInstallResponse> => {
    const result = await window.desktopApi.gateway.installEngineBinary(payload);
    await refreshRuntimeContext();
    requestRefresh();
    return result;
  };

  const activateEngineVersion = async (payload: {
    engineType: "llama.cpp" | "mlx";
    versionTag: string;
  }): Promise<DesktopEngineInstallResponse> => {
    const result = await window.desktopApi.gateway.installEngineBinary({
      engineType: payload.engineType,
      action: "activate-installed-version",
      versionTag: payload.versionTag,
    });
    await refreshRuntimeContext();
    requestRefresh();
    return result;
  };

  const preloadModel = async (modelId: string): Promise<void> => {
    await window.desktopApi.gateway.preloadModel(modelId);
    requestRefresh();
  };

  const deleteRegisteredModel = async (
    modelId: string,
    options?: { deleteFiles?: boolean },
  ): Promise<DesktopModelDeleteResponse> => {
    const result = await window.desktopApi.gateway.deleteRegisteredModel(modelId, options);
    requestRefresh();
    return result;
  };

  const evictModel = async (modelId: string): Promise<void> => {
    await window.desktopApi.gateway.evictModel(modelId);
    requestRefresh();
  };

  const updateModelConfig = async (
    modelId: string,
    payload: DesktopModelConfigUpdateRequest,
  ): Promise<DesktopModelConfigUpdateResponse> => {
    const result = await window.desktopApi.gateway.updateModelConfig(modelId, payload);
    requestRefresh();
    return result;
  };

  const updateModelsDirectory = async (modelsDir: string): Promise<void> => {
    const updatedContext = await window.desktopApi.system.updateModelsDirectory(modelsDir);
    startTransition(() => {
      setRuntimeContext(updatedContext);
    });
    requestRefresh();
  };

  const updateGatewaySettings = async (payload: {
    publicHost: string;
    publicPort: number;
    maxActiveModelsInMemory: number;
    apiAuthToken: string;
  }): Promise<void> => {
    const updatedContext = await window.desktopApi.system.updateGatewaySettings(payload);
    startTransition(() => {
      setRuntimeContext(updatedContext);
    });
    requestRefresh();
  };

  const revealSessionLogFile = async (filePath: string): Promise<void> => {
    await window.desktopApi.system.revealPath(filePath);
  };

  const copySessionLogFilePath = async (filePath: string): Promise<void> => {
    await window.desktopApi.system.copyPath(filePath);
  };

  const restartGateway = async (): Promise<void> => {
    setRecoveryBusy("restart");
    try {
      await window.desktopApi.gateway.restart();
      await refreshRuntimeContext();
      requestRefresh();
    } finally {
      setRecoveryBusy(null);
    }
  };

  const shutdownGateway = async (): Promise<void> => {
    setRecoveryBusy("shutdown");
    try {
      await window.desktopApi.gateway.shutdown();
      requestRefresh();
    } finally {
      setRecoveryBusy(null);
    }
  };

  return (
    <HashRouter>
      <div className="app-shell">
        <header className="app-header">
          <div className="app-header-brand">
            <h1>LM Hub</h1>
          </div>
          <div className="app-header-aside">
            <p className="app-header-description">
              Operational workspace for local model workflows, downloads, and observability across
              the desktop control plane.
            </p>
            <div className="topbar-meta app-header-stats">
              <div className="app-header-connection">
                <span className="section-label">Connection</span>
                <h2>{shellState.discovery?.publicBaseUrl ?? "Waiting for discovery"}</h2>
              </div>
              <div>
                <span className="section-label">Started</span>
                <strong>{formatClock(shellState.startedAt)}</strong>
              </div>
              <div>
                <span className="section-label">Active engines</span>
                <strong>{activeEngineCount}</strong>
              </div>
            </div>
          </div>
        </header>

        <aside className="sidebar">
          <nav className="nav-stack">
            {navItems.map((item) => (
              <NavLink
                className={({ isActive }) => (isActive ? "nav-link nav-link-active" : "nav-link")}
                end={item.to === "/"}
                key={item.to}
                to={item.to}
              >
                {item.label}
              </NavLink>
            ))}
          </nav>

          <section className="side-panel">
            <div className="gateway-panel-head">
              <span className="section-label">Gateway</span>
              <div className="status-chip">{shellState.phase.replaceAll("_", " ")}</div>
            </div>
            <div className="gateway-panel-stats" aria-label="Gateway summary">
              <div className="side-panel-stat">
                <span className="gateway-stat-label">Registered</span>
                <strong>{registeredModelCount}</strong>
              </div>
              <div className="side-panel-stat">
                <span className="gateway-stat-label">Ready</span>
                <strong>{readyModelCount}</strong>
              </div>
            </div>
            {shellState.message ? <p>{shellState.message}</p> : null}
            <small className="gateway-last-event">
              Last event: {formatClock(shellState.lastEventAt)}
            </small>
          </section>
        </aside>

        <main className="content-shell">
          {shellState.phase === "error" || shellState.phase === "stopped" ? (
            <article className="wide-card feedback-card feedback-card-error">
              <strong>
                {shellState.phase === "error" ? "Gateway recovery required" : "Gateway is stopped"}
              </strong>
              <p>{shellState.lastError ?? shellState.message}</p>
              <div className="button-row">
                <button
                  className="primary-button"
                  disabled={recoveryBusy !== null}
                  onClick={() => void restartGateway()}
                  type="button"
                >
                  {recoveryBusy === "restart" ? "Restarting..." : "Restart gateway"}
                </button>
                <button
                  className="secondary-button"
                  disabled={recoveryBusy !== null}
                  onClick={() => void shutdownGateway()}
                  type="button"
                >
                  {recoveryBusy === "shutdown" ? "Stopping..." : "Shutdown"}
                </button>
              </div>
            </article>
          ) : null}

          <Routes>
            <Route path="/" element={<DashboardScreen shellState={shellState} />} />
            <Route
              path="/models"
              element={
                <ModelsScreen
                  models={modelLibrary}
                  runtimeContext={runtimeContext}
                  onDeleteModel={deleteRegisteredModel}
                  onEvictModel={evictModel}
                  onPickImportFile={pickLocalModel}
                  onPreloadModel={preloadModel}
                  onRegisterModel={registerLocalModel}
                  onUpdateModelConfig={updateModelConfig}
                  onSelectModel={setSelectedModelId}
                  selectedModelId={selectedModelId}
                  shellState={shellState}
                />
              }
            />
            <Route path="/downloads" element={<DownloadsScreen shellState={shellState} />} />
            <Route
              path="/chat"
              element={<ChatScreen models={chatModelSummaries} shellState={shellState} />}
            />
            <Route
              path="/observability"
              element={
                <ObservabilityScreen
                  events={events}
                  health={health}
                  paths={paths}
                  onCopySessionLogFile={copySessionLogFilePath}
                  onRevealSessionLogFile={revealSessionLogFile}
                  shellState={shellState}
                />
              }
            />
            <Route
              path="/settings"
              element={
                <SettingsScreen
                  engines={engines}
                  onActivateEngineVersion={activateEngineVersion}
                  onInstallEngineBinary={installEngineBinary}
                  onPickEngineBinaryFile={pickEngineBinary}
                  onPickModelsDirectory={pickModelsDirectory}
                  onRestartGateway={restartGateway}
                  onShutdownGateway={shutdownGateway}
                  onUpdateGatewaySettings={updateGatewaySettings}
                  onUpdateModelsDirectory={updateModelsDirectory}
                  paths={paths}
                  runtimeContext={runtimeContext}
                  shellState={shellState}
                />
              }
            />
          </Routes>
        </main>
      </div>
    </HashRouter>
  );
}
