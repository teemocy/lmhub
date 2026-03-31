import type { DesktopShellState, ModelSummary } from "@localhub/shared-contracts";

type ChatScreenProps = {
  shellState: DesktopShellState;
  models: ModelSummary[];
};

export function ChatScreen({ shellState, models }: ChatScreenProps) {
  return (
    <section className="screen-grid">
      <article className="hero-card">
        <span className="section-label">Chat sandbox</span>
        <h3>Streaming surface reserved for Stage 3</h3>
        <p>
          The route, layout, and status plumbing are already in place so the real SSE client can
          land without rewriting the shell.
        </p>
      </article>

      <article className="info-card">
        <span className="section-label">Selected model slot</span>
        <strong>{models[0]?.name ?? "Awaiting live inventory"}</strong>
        <p>
          Current gateway phase: <strong>{shellState.phase}</strong>
        </p>
      </article>

      <article className="wide-card">
        <span className="section-label">System prompt controls</span>
        <h3>Placeholder settings shell</h3>
        <p>
          Reserve space for model chooser, history controls, and system prompt editing once the
          runtime route and persistence layer arrive.
        </p>
      </article>
    </section>
  );
}
