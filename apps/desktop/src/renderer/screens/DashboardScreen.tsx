import type {
  DesktopShellState,
  GatewayEvent,
  GatewayHealthSnapshot,
} from "@localhub/shared-contracts";

type DashboardScreenProps = {
  shellState: DesktopShellState;
  health: GatewayHealthSnapshot | null;
  events: GatewayEvent[];
};

const findMetric = (events: GatewayEvent[], key: string): string => {
  const event = events.find((entry) => entry.type === "METRICS_TICK");
  const payload = event?.payload as Record<string, unknown> | undefined;
  const value = payload?.[key];
  return typeof value === "number" ? String(value) : "Pending";
};

export function DashboardScreen({ shellState, health, events }: DashboardScreenProps) {
  const latestTrace = events.find((event) => event.type === "REQUEST_TRACE");
  const latestTracePayload = latestTrace?.payload as Record<string, unknown> | undefined;
  const healthRecord = health as Record<string, unknown> | null;
  const healthState =
    typeof healthRecord?.state === "string"
      ? healthRecord.state
      : typeof healthRecord?.status === "string"
        ? healthRecord.status
        : shellState.phase;
  const activeWorkers =
    typeof healthRecord?.activeWorkers === "number"
      ? healthRecord.activeWorkers
      : typeof healthRecord?.loadedModelCount === "number"
        ? healthRecord.loadedModelCount
        : 0;

  return (
    <section className="screen-grid">
      <article className="hero-card">
        <span className="section-label">Runtime overview</span>
        <h3>Bootable shell with mocked lifecycle data</h3>
        <p>
          Stage 1 is focused on proving the desktop contract: window lifecycle, tray behavior,
          preload IPC, and transport wiring against a safe mock.
        </p>
      </article>

      <article className="info-card">
        <span className="section-label">Gateway phase</span>
        <strong>{healthState}</strong>
        <p>{shellState.message}</p>
      </article>

      <article className="info-card">
        <span className="section-label">Active workers</span>
        <strong>{activeWorkers}</strong>
        <p>The shell is consuming adapted control-plane health snapshots.</p>
      </article>

      <article className="info-card">
        <span className="section-label">Resident memory</span>
        <strong>{findMetric(events, "residentMemoryBytes")} bytes</strong>
        <p>Metric cards are already driven by the shared event envelope.</p>
      </article>

      <article className="info-card">
        <span className="section-label">Latest trace</span>
        <strong>
          {typeof latestTracePayload?.route === "string" ? latestTracePayload.route : "Pending"}
        </strong>
        <p>Request traces are already flowing through the same telemetry rail.</p>
      </article>

      <article className="wide-card">
        <span className="section-label">Stage boundary</span>
        <h3>Ready for real feature slices</h3>
        <p>
          Placeholder screens, navigation, and transport hooks are stable enough to receive real
          model-management and chat UX in the next stages.
        </p>
      </article>
    </section>
  );
}
