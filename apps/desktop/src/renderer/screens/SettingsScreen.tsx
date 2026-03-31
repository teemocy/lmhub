import type { DesktopShellState } from "@localhub/shared-contracts";

type DesktopSystemPaths = {
  workspaceRoot: string;
  supportDir: string;
  discoveryFile: string;
};

type SettingsScreenProps = {
  shellState: DesktopShellState;
  paths: DesktopSystemPaths | null;
};

export function SettingsScreen({ shellState, paths }: SettingsScreenProps) {
  return (
    <section className="screen-stack">
      <article className="hero-card compact-hero">
        <div>
          <span className="section-label">Settings shell</span>
          <h3>Desktop ownership boundaries</h3>
        </div>
        <span className="status-pill">{shellState.phase}</span>
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
        </div>
      </article>

      <article className="wide-card">
        <span className="section-label">Lifecycle UX</span>
        <h3>Close-to-tray is active</h3>
        <p>
          Closing the window hides it and keeps the mocked daemon alive. Explicit quit still routes
          through a controlled shutdown request.
        </p>
      </article>
    </section>
  );
}
