import type { DesktopShellState, ModelSummary } from "@localhub/shared-contracts";

type ModelsScreenProps = {
  models: ModelSummary[];
  shellState: DesktopShellState;
  pickedFiles: string[];
  onImportModel(): Promise<void>;
};

export function ModelsScreen({
  models,
  shellState,
  pickedFiles,
  onImportModel,
}: ModelsScreenProps) {
  return (
    <section className="screen-stack">
      <article className="hero-card compact-hero">
        <div>
          <span className="section-label">Model library</span>
          <h3>Mocked runtime inventory</h3>
        </div>
        <button className="primary-button" onClick={() => void onImportModel()} type="button">
          Pick local GGUF
        </button>
      </article>

      <div className="model-grid">
        {models.map((model) => (
          <article className="model-card" key={model.id}>
            <div className="model-card-head">
              <div>
                <span className="section-label">{model.engine}</span>
                <h4>{model.name}</h4>
              </div>
              <span className="status-pill">{model.state}</span>
            </div>
            <p>{model.description}</p>
            <dl className="meta-grid">
              <div>
                <dt>Artifact size</dt>
                <dd>{model.sizeLabel}</dd>
              </div>
              <div>
                <dt>Context</dt>
                <dd>{model.contextLength ?? "TBD"}</dd>
              </div>
              <div>
                <dt>Tags</dt>
                <dd>{model.tags.join(", ")}</dd>
              </div>
              <div>
                <dt>Last used</dt>
                <dd>{model.lastUsedAt ? new Date(model.lastUsedAt).toLocaleString() : "Never"}</dd>
              </div>
            </dl>
          </article>
        ))}
      </div>

      <article className="wide-card">
        <span className="section-label">Import scaffold</span>
        <h3>Local registration flow placeholder</h3>
        <p>
          Stage 2 will turn the file picker into a real registration path. For now, the shell proves
          that privileged dialogs stay in the preload/main boundary.
        </p>
        <div className="import-preview">
          <strong>Selected file</strong>
          <span>
            {pickedFiles[0] ??
              (shellState.phase === "connected"
                ? "No local artifact selected yet."
                : "Connect the gateway first to continue.")}
          </span>
        </div>
      </article>
    </section>
  );
}
