import type {
  DesktopShellState,
  GatewayEvent,
  GatewayHealthSnapshot,
  ModelSummary,
} from "@localhub/shared-contracts";
import { startTransition, useEffect, useState } from "react";
import { HashRouter, NavLink, Route, Routes } from "react-router-dom";
import { ChatScreen } from "./screens/ChatScreen";
import { DashboardScreen } from "./screens/DashboardScreen";
import { ModelsScreen } from "./screens/ModelsScreen";
import { SettingsScreen } from "./screens/SettingsScreen";

type DesktopSystemPaths = {
  workspaceRoot: string;
  supportDir: string;
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

const formatClock = (value?: string | null): string => {
  if (!value) {
    return "Not yet";
  }

  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
};

const navItems = [
  { to: "/", label: "Overview" },
  { to: "/models", label: "Model Library" },
  { to: "/chat", label: "Chat Sandbox" },
  { to: "/settings", label: "Settings" },
] as const;

export function App() {
  const [shellState, setShellState] = useState(initialShellState);
  const [models, setModels] = useState<ModelSummary[]>([]);
  const [health, setHealth] = useState<GatewayHealthSnapshot | null>(null);
  const [paths, setPaths] = useState<DesktopSystemPaths | null>(null);
  const [events, setEvents] = useState<GatewayEvent[]>([]);
  const [pickedFiles, setPickedFiles] = useState<string[]>([]);

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

    const unsubscribeState = window.desktopApi.shell.onStateChange((state) => {
      startTransition(() => {
        setShellState(state);
      });
    });

    const unsubscribeEvents = window.desktopApi.gateway.subscribeEvents((event) => {
      startTransition(() => {
        setEvents((current) => [event, ...current].slice(0, 14));
      });
    });

    return () => {
      disposed = true;
      unsubscribeState();
      unsubscribeEvents();
    };
  }, []);

  useEffect(() => {
    if (shellState.phase !== "connected") {
      return;
    }

    let cancelled = false;

    const refresh = async () => {
      const [modelList, healthSnapshot] = await Promise.all([
        window.desktopApi.gateway.listModels(),
        window.desktopApi.gateway.getHealth(),
      ]);

      if (!cancelled) {
        setModels(modelList.data);
        setHealth(healthSnapshot);
      }
    };

    void refresh();

    const interval = window.setInterval(() => {
      void refresh();
    }, 7_500);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [shellState.phase]);

  const latestMetrics = events.find((event) => event.type === "METRICS_TICK");
  const latestTrace = events.find((event) => event.type === "REQUEST_TRACE");
  const latestMetricsPayload = latestMetrics?.payload as Record<string, unknown> | undefined;
  const latestTracePayload = latestTrace?.payload as Record<string, unknown> | undefined;

  const pickLocalModel = async () => {
    const result = await window.desktopApi.gateway.openModelFileDialog();

    if (!result.canceled) {
      setPickedFiles(result.filePaths);
    }
  };

  return (
    <HashRouter>
      <div className="app-shell">
        <aside className="sidebar">
          <div className="brand-card">
            <span className="brand-eyebrow">Stage 1 Shell</span>
            <h1>Local LLM Hub</h1>
            <p>Electron tray shell, mocked gateway transport, and the first renderer scaffold.</p>
          </div>

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
            <span className="section-label">Gateway</span>
            <div className="status-chip">{shellState.phase.replaceAll("_", " ")}</div>
            <p>{shellState.message}</p>
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${shellState.progress}%` }} />
            </div>
            <small>Last event: {formatClock(shellState.lastEventAt)}</small>
          </section>

          <section className="side-panel">
            <span className="section-label">Metrics pulse</span>
            <strong>
              {typeof latestMetricsPayload?.activeWorkers === "number"
                ? `${latestMetricsPayload.activeWorkers} active worker slots`
                : "Waiting for telemetry"}
            </strong>
            <p>
              {typeof latestTracePayload?.route === "string"
                ? `Latest traced route: ${latestTracePayload.route}.`
                : "Telemetry will begin once the control stream is attached."}
            </p>
          </section>
        </aside>

        <main className="content-shell">
          <header className="topbar">
            <div>
              <span className="section-label">Connection</span>
              <h2>{shellState.discovery?.publicBaseUrl ?? "Waiting for discovery"}</h2>
            </div>
            <div className="topbar-meta">
              <div>
                <span className="section-label">Started</span>
                <strong>{formatClock(shellState.startedAt)}</strong>
              </div>
              <div>
                <span className="section-label">Tray mode</span>
                <strong>Close hides to tray</strong>
              </div>
            </div>
          </header>

          <Routes>
            <Route
              path="/"
              element={<DashboardScreen events={events} health={health} shellState={shellState} />}
            />
            <Route
              path="/models"
              element={
                <ModelsScreen
                  models={models}
                  onImportModel={pickLocalModel}
                  pickedFiles={pickedFiles}
                  shellState={shellState}
                />
              }
            />
            <Route path="/chat" element={<ChatScreen models={models} shellState={shellState} />} />
            <Route
              path="/settings"
              element={<SettingsScreen paths={paths} shellState={shellState} />}
            />
          </Routes>
        </main>

        <aside className="activity-rail">
          <div className="rail-card">
            <span className="section-label">Event feed</span>
            <h3>Shared envelope</h3>
            <p>
              The renderer is already consuming the stage event taxonomy without reaching into
              gateway internals.
            </p>
          </div>

          <div className="event-list">
            {events.length === 0 ? (
              <div className="event-card event-card-empty">
                Waiting for gateway telemetry to populate the feed.
              </div>
            ) : (
              events.map((event) => (
                <article className="event-card" key={`${event.traceId}-${event.ts}`}>
                  <div className="event-head">
                    <strong>{event.type}</strong>
                    <span>{formatClock(event.ts)}</span>
                  </div>
                  <p>
                    {event.type === "LOG_STREAM"
                      ? ((event.payload as { message?: string }).message ?? "Gateway log")
                      : (JSON.stringify(event.payload) ?? "")}
                  </p>
                </article>
              ))
            )}
          </div>
        </aside>
      </div>
    </HashRouter>
  );
}
