import type {
  DesktopDownloadTask,
  DesktopProviderSearchItem,
  DesktopShellState,
} from "@localhub/shared-contracts";
import { useEffect, useState } from "react";

type DownloadsScreenProps = {
  shellState: DesktopShellState;
};

const formatBytes = (value: number | undefined): string => {
  if (!value || value <= 0) {
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

const formatSize = (value: number | undefined): string =>
  value && value > 0 ? formatBytes(value) : "Unknown size";

const formatCount = (value: number | undefined): string =>
  value !== undefined ? value.toLocaleString() : "Unknown";

const formatUpdatedAt = (value: string | undefined): string =>
  value ? new Date(value).toLocaleDateString() : "Unknown";

export function DownloadsScreen({ shellState }: DownloadsScreenProps) {
  const [query, setQuery] = useState("qwen");
  const [results, setResults] = useState<DesktopProviderSearchItem[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [downloads, setDownloads] = useState<DesktopDownloadTask[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (shellState.phase !== "connected") {
      return;
    }

    let cancelled = false;
    const refreshDownloads = async () => {
      try {
        const response = await window.desktopApi.gateway.listDownloads();
        if (!cancelled) {
          setDownloads(response.data);
        }
      } catch (reason) {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : "Unable to load downloads.");
        }
      }
    };

    void refreshDownloads();
    const timer = window.setInterval(() => {
      void refreshDownloads();
    }, 2_500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [shellState.phase]);

  const search = async () => {
    if (query.trim().length < 2) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await window.desktopApi.gateway.searchCatalog(query);
      setResults(response.data);
      setWarnings(response.warnings);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to search providers.");
    } finally {
      setBusy(false);
    }
  };

  const createDownload = async (item: DesktopProviderSearchItem) => {
    setBusy(true);
    setError(null);
    try {
      await window.desktopApi.gateway.createDownload({
        provider: item.provider,
        providerModelId: item.providerModelId,
        artifactId: item.artifactId,
        title: item.providerModelId,
        artifactName: item.artifactName,
        downloadUrl: item.downloadUrl,
        ...(item.checksumSha256 ? { checksumSha256: item.checksumSha256 } : {}),
        ...(item.sizeBytes !== undefined ? { sizeBytes: item.sizeBytes } : {}),
        metadata: item.metadata,
      });
      const updated = await window.desktopApi.gateway.listDownloads();
      setDownloads(updated.data);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to enqueue download.");
    } finally {
      setBusy(false);
    }
  };

  const toggleDownload = async (task: DesktopDownloadTask) => {
    setBusy(true);
    setError(null);
    try {
      if (task.status === "paused") {
        await window.desktopApi.gateway.resumeDownload(task.id);
      } else if (task.status === "downloading" || task.status === "pending") {
        await window.desktopApi.gateway.pauseDownload(task.id);
      }
      const updated = await window.desktopApi.gateway.listDownloads();
      setDownloads(updated.data);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to update download state.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="screen-stack">
      <article className="hero-card compact-hero">
        <div>
          <span className="section-label">Discovery & downloads</span>
          <h3>Provider catalog</h3>
          <p>Search remote catalog results and queue model artifacts from the desktop shell.</p>
        </div>
        <div className="button-row">
          <input
            className="text-input"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search model providers"
            value={query}
          />
          <button
            className="primary-button"
            disabled={busy}
            onClick={() => void search()}
            type="button"
          >
            Search
          </button>
        </div>
      </article>

      {warnings.length > 0 ? (
        <article className="info-card feedback-card">
          <strong>Provider warning</strong>
          <p>{warnings.join(" ")}</p>
        </article>
      ) : null}

      {error ? (
        <article className="info-card feedback-card feedback-card-error">
          <strong>Download error</strong>
          <p>{error}</p>
        </article>
      ) : null}

      <article className="wide-card">
        <span className="section-label">Search results</span>
        <div className="search-result-strip">
          {results.length === 0 ? (
            <div className="empty-panel compact-empty">
              <strong>No results yet.</strong>
              <p>Run a search to discover downloadable artifacts.</p>
            </div>
          ) : (
            results.map((item) => (
              <article className="model-card" key={item.id}>
                <div className="model-card-head">
                  <h4>{item.title}</h4>
                  <span className="status-pill status-pill-neutral">{item.provider}</span>
                </div>
                <p>{item.summary ?? item.description ?? "Provider model result."}</p>
                <dl className="meta-grid compact-meta-grid">
                  <div>
                    <dt>Artifact</dt>
                    <dd>{item.artifactName}</dd>
                  </div>
                  <div>
                    <dt>Size</dt>
                    <dd>{formatBytes(item.sizeBytes)}</dd>
                  </div>
                </dl>
                <div className="button-row">
                  <button
                    className="secondary-button"
                    disabled={busy}
                    onClick={() => void createDownload(item)}
                    type="button"
                  >
                    Download
                  </button>
                </div>
              </article>
            ))
          )}
        </div>
      </article>

      <article className="wide-card">
        <span className="section-label">Download tasks</span>
        <div className="model-grid">
          {downloads.length === 0 ? (
            <div className="empty-panel compact-empty">
              <strong>No active downloads.</strong>
              <p>Queued tasks appear here with pause/resume controls.</p>
            </div>
          ) : (
            downloads.map((task) => (
              <article className="model-card" key={task.id}>
                <div className="model-card-head">
                  <h4>{task.title}</h4>
                  <span className="status-pill status-pill-neutral">{task.status}</span>
                </div>
                <p>{task.artifactName}</p>
                <div className="progress-track">
                  <div className="progress-fill" style={{ width: `${task.progress}%` }} />
                </div>
                <p>
                  {task.progress}% • {formatBytes(task.downloadedBytes)} /{" "}
                  {formatBytes(task.totalBytes)}
                </p>
                <div className="button-row">
                  {(task.status === "pending" ||
                    task.status === "downloading" ||
                    task.status === "paused") && (
                    <button
                      className="secondary-button"
                      disabled={busy}
                      onClick={() => void toggleDownload(task)}
                      type="button"
                    >
                      {task.status === "paused" ? "Resume" : "Pause"}
                    </button>
                  )}
                  {task.status === "completed" ? (
                    <span className="status-pill status-pill-positive">
                      Ready to register in Model Library
                    </span>
                  ) : null}
                </div>
              </article>
            ))
          )}
        </div>
      </article>
    </section>
  );
}
