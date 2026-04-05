import type {
  DesktopShellState,
  GatewayEvent,
  GatewayHealthSnapshot,
} from "@localhub/shared-contracts";
import { useEffect, useState } from "react";
import {
  formatActivityRailMessage,
  formatLiveConsoleEntry,
  selectActivityRailEvents,
  selectLiveConsoleEvents,
} from "../telemetry";

type DesktopSystemPaths = {
  workspaceRoot: string;
  supportDir: string;
  logsDir: string;
  sessionLogFile: string;
  discoveryFile: string;
};

type ObservabilityScreenProps = {
  shellState: DesktopShellState;
  health: GatewayHealthSnapshot | null;
  paths: DesktopSystemPaths | null;
  events: GatewayEvent[];
  onCopySessionLogFile(filePath: string): Promise<void>;
  onRevealSessionLogFile(filePath: string): Promise<void>;
};

const formatClock = (value?: string | null): string => {
  if (!value) {
    return "Pending";
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

const findMetricValue = (events: GatewayEvent[], key: string): number | null => {
  const event = events.find((entry) => entry.type === "METRICS_TICK");
  const payload = event?.payload as Record<string, unknown> | undefined;
  const value = payload?.[key];
  return typeof value === "number" ? value : null;
};

const findLatestTraceRoute = (events: GatewayEvent[]): string | null => {
  const event = events.find((entry) => entry.type === "REQUEST_TRACE");
  const payload = event?.payload as Record<string, unknown> | undefined;
  return typeof payload?.route === "string" ? payload.route : null;
};

export function ObservabilityScreen({
  events,
  health,
  onCopySessionLogFile,
  onRevealSessionLogFile,
  paths,
  shellState,
}: ObservabilityScreenProps) {
  const [copyToast, setCopyToast] = useState<{
    tone: "success" | "error";
    text: string;
  } | null>(null);
  const activityEvents = selectActivityRailEvents(events);
  const liveConsoleEvents = selectLiveConsoleEvents(events);
  const residentMemoryBytes = findMetricValue(events, "residentMemoryBytes");
  const gpuMemoryBytes = findMetricValue(events, "gpuMemoryBytes");
  const latestTraceRoute = findLatestTraceRoute(events);

  useEffect(() => {
    if (!copyToast) {
      return;
    }

    const timeout = window.setTimeout(() => {
      setCopyToast(null);
    }, 1800);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [copyToast]);

  const copySessionLogPath = async () => {
    if (!paths?.sessionLogFile) {
      return;
    }

    try {
      await onCopySessionLogFile(paths.sessionLogFile);
      setCopyToast({
        tone: "success",
        text: "Session log path copied.",
      });
    } catch (error) {
      setCopyToast({
        tone: "error",
        text:
          error instanceof Error
            ? `Unable to copy session log path. ${error.message}`
            : "Unable to copy session log path.",
      });
    }
  };

  return (
    <section className="screen-stack">
      <article className="hero-card compact-hero">
        <div>
          <span className="section-label">Observability</span>
          <h3>Runtime pulse, logs, and traces</h3>
          <p>Monitor lifecycle changes, streaming logs, and request traces from one place.</p>
        </div>
        <span className="status-pill">{shellState.phase}</span>
      </article>

      <article className="wide-card observability-card">
        <span className="section-label">Runtime pulse</span>
        <h3>Operational snapshot</h3>
        <p>
          {shellState.phase === "connected"
            ? "Lifecycle updates, traces, and logs are collected on this page."
            : shellState.message}
        </p>
        <dl className="meta-grid">
          <div>
            <dt>Active workers</dt>
            <dd>{health ? health.activeWorkers : "Pending"}</dd>
          </div>
          <div>
            <dt>Queued requests</dt>
            <dd>{health ? health.queuedRequests : "Pending"}</dd>
          </div>
          <div>
            <dt>Resident memory</dt>
            <dd>{residentMemoryBytes !== null ? formatBytes(residentMemoryBytes) : "Pending"}</dd>
          </div>
          <div>
            <dt>GPU memory</dt>
            <dd>{gpuMemoryBytes !== null ? formatBytes(gpuMemoryBytes) : "Pending"}</dd>
          </div>
        </dl>
        <p className="rail-note">Latest trace: {latestTraceRoute ?? "Waiting for requests"}</p>
      </article>

      <article className="wide-card observability-card">
        <span className="section-label">Live log console</span>
        <h3>Gateway log and trace stream</h3>
        <div className="detail-meta-note">
          <strong>Current session log</strong>
          <p className="session-log-path">
            {paths?.sessionLogFile ?? "Waiting for the gateway to create a session log file."}
          </p>
          <div className="button-row">
            <button
              className="secondary-button"
              disabled={!paths?.sessionLogFile}
              onClick={() => {
                void copySessionLogPath();
              }}
              type="button"
            >
              Copy path
            </button>
            <button
              className="secondary-button"
              disabled={!paths?.sessionLogFile}
              onClick={() => {
                if (paths?.sessionLogFile) {
                  void onRevealSessionLogFile(paths.sessionLogFile);
                }
              }}
              type="button"
            >
              Reveal in folder
            </button>
          </div>
          <p
            className={
              copyToast
                ? `session-log-toast session-log-toast-${copyToast.tone} session-log-toast-visible`
                : "session-log-toast"
            }
            aria-live="polite"
            role="status"
          >
            {copyToast?.text ?? " "}
          </p>
        </div>
        <div className="log-console">
          {liveConsoleEvents.length === 0 ? (
            <p>Waiting for gateway logs or request traces.</p>
          ) : (
            liveConsoleEvents.map((event) => {
              const entry = formatLiveConsoleEntry(event);

              return (
                <div className="log-line" key={`${event.type}-${event.traceId}-${event.ts}`}>
                  <span className={`log-badge log-badge-${entry.tone}`}>{entry.label}</span>
                  <p>
                    <span className="log-timestamp">
                      [{new Date(event.ts).toLocaleTimeString()}]
                    </span>{" "}
                    {entry.message}
                  </p>
                </div>
              );
            })
          )}
        </div>
      </article>

      <article className="wide-card observability-card">
        <span className="section-label">Activity feed</span>
        <h3>Operational activity</h3>
        <p>
          Lifecycle and download milestones stay here. Streaming logs and request traces live above.
        </p>
        <div className="event-list">
          {activityEvents.length === 0 ? (
            <div className="event-card event-card-empty">
              No lifecycle changes yet. Open Overview to watch the live log and trace console.
            </div>
          ) : (
            activityEvents.map((event) => (
              <article className="event-card" key={`${event.traceId}-${event.ts}`}>
                <div className="event-head">
                  <strong>{event.type}</strong>
                  <span>{formatClock(event.ts)}</span>
                </div>
                <p>{formatActivityRailMessage(event)}</p>
              </article>
            ))
          )}
        </div>
      </article>
    </section>
  );
}
