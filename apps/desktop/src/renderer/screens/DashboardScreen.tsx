import type { ApiLogRecord, DesktopShellState } from "@localhub/shared-contracts";
import { useEffect, useState } from "react";
import { BACKGROUND_REFRESH_INTERVAL_MS } from "../constants";

type DashboardScreenProps = {
  shellState: DesktopShellState;
};

const formatRate = (value: number | undefined, estimated: boolean): string => {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "Pending";
  }

  return `${estimated ? "~" : ""}${value.toFixed(2)} tok/s`;
};

const formatRateLabel = (estimated: boolean): string =>
  estimated ? "Tokens/s (est.)" : "Tokens/s";

export function DashboardScreen({ shellState }: DashboardScreenProps) {
  const [apiLogs, setApiLogs] = useState<ApiLogRecord[]>([]);
  const latestApiLog = apiLogs[0];

  useEffect(() => {
    if (shellState.phase !== "connected") {
      return;
    }

    let cancelled = false;
    const refreshLogs = async () => {
      const response = await window.desktopApi.gateway.listApiLogs(30);
      if (!cancelled) {
        setApiLogs(response.data);
      }
    };

    void refreshLogs();
    const timer = window.setInterval(() => {
      void refreshLogs();
    }, BACKGROUND_REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [shellState.phase]);

  return (
    <section className="screen-stack">
      <article className="hero-card">
        <span className="section-label">Runtime overview</span>
        <h3>Live gateway observability</h3>
        <p>
          Track completion stats here while Observability handles lifecycle updates, logs, and
          request traces.
        </p>
      </article>

      <article className="wide-card">
        <span className="section-label">API performance</span>
        <h3>Recent completion stats</h3>
        {latestApiLog ? (
          <dl className="meta-grid">
            <div>
              <dt>Endpoint</dt>
              <dd>{latestApiLog.endpoint}</dd>
            </div>
            <div>
              <dt>TTFT</dt>
              <dd>{latestApiLog.ttftMs !== undefined ? `${latestApiLog.ttftMs} ms` : "Pending"}</dd>
            </div>
            <div>
              <dt>{formatRateLabel(latestApiLog.ttftMs !== undefined)}</dt>
              <dd>{formatRate(latestApiLog.tokensPerSecond, latestApiLog.ttftMs !== undefined)}</dd>
            </div>
            <div>
              <dt>Total duration</dt>
              <dd>
                {latestApiLog.totalDurationMs !== undefined
                  ? `${latestApiLog.totalDurationMs} ms`
                  : "Pending"}
              </dd>
            </div>
          </dl>
        ) : (
          <p>No API logs yet. Run chat requests to populate this panel.</p>
        )}
      </article>
    </section>
  );
}
