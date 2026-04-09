import type {
  DesktopDownloadTask,
  DesktopProviderCatalogDetail,
  DesktopProviderSearchItem,
  DesktopShellState,
} from "@localhub/shared-contracts";
import { useEffect, useState } from "react";
import { BACKGROUND_REFRESH_INTERVAL_MS } from "../constants";

type DownloadsScreenProps = {
  shellState: DesktopShellState;
};

type CatalogDetailState =
  | {
      status: "idle";
      warnings: string[];
    }
  | {
      status: "loading";
      warnings: string[];
    }
  | {
      status: "ready";
      warnings: string[];
      data: DesktopProviderCatalogDetail;
    }
  | {
      status: "error";
      warnings: string[];
      message: string;
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
  const [catalogDetails, setCatalogDetails] = useState<Record<string, CatalogDetailState>>({});
  const [selectedVariants, setSelectedVariants] = useState<Record<string, string>>({});

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
    }, BACKGROUND_REFRESH_INTERVAL_MS);
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
      setCatalogDetails({});
      setSelectedVariants({});
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to search providers.");
    } finally {
      setBusy(false);
    }
  };

  const loadCatalogModel = async (item: DesktopProviderSearchItem) => {
    setCatalogDetails((current) => ({
      ...current,
      [item.id]: {
        status: "loading",
        warnings: current[item.id]?.warnings ?? [],
      },
    }));

    try {
      const response = await window.desktopApi.gateway.getCatalogModel(
        item.provider,
        item.providerModelId,
      );
      setCatalogDetails((current) => ({
        ...current,
        [item.id]: {
          status: "ready",
          warnings: response.warnings,
          data: response.data,
        },
      }));
      setSelectedVariants((current) =>
        current[item.id]
          ? current
          : {
              ...current,
              ...(response.data.variants[0] ? { [item.id]: response.data.variants[0].id } : {}),
            },
      );
    } catch (reason) {
      setCatalogDetails((current) => ({
        ...current,
        [item.id]: {
          status: "error",
          warnings: current[item.id]?.warnings ?? [],
          message: reason instanceof Error ? reason.message : "Unable to load repository manifest.",
        },
      }));
    }
  };

  const createDownload = async (detail: DesktopProviderCatalogDetail) => {
    const selectedVariant =
      detail.variants.find((variant) => variant.id === selectedVariants[detail.id]) ??
      detail.variants[0];
    if (!selectedVariant) {
      return;
    }

    const bundleId = `${detail.id}:${selectedVariant.id}`;
    const displayTitle =
      selectedVariant.label === "Default"
        ? detail.providerModelId
        : `${detail.providerModelId} (${selectedVariant.label})`;

    setBusy(true);
    setError(null);
    try {
      for (const file of selectedVariant.files) {
        await window.desktopApi.gateway.createDownload({
          provider: detail.provider,
          providerModelId: detail.providerModelId,
          artifactId: file.artifactId,
          title: displayTitle,
          artifactName: file.artifactName,
          ...(file.checksumSha256 ? { checksumSha256: file.checksumSha256 } : {}),
          ...(file.sizeBytes !== undefined ? { sizeBytes: file.sizeBytes } : {}),
          metadata: {
            ...file.metadata,
            autoRegister: file.artifactId === selectedVariant.primaryArtifactId,
            bundleId,
            bundlePrimaryArtifactId: selectedVariant.primaryArtifactId,
          },
        });
      }
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
          <h3>Model catalog</h3>
          <p className="compact-hero-copy">
            Search providers and model families, then open a result to choose a build.
          </p>
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
              <p>Run a search to discover downloadable repositories.</p>
            </div>
          ) : (
            results.map((item) => {
              const detailState: CatalogDetailState = catalogDetails[item.id] ?? {
                status: "idle",
                warnings: [],
              };
              const detail = detailState.status === "ready" ? detailState.data : undefined;
              const selectedVariant =
                detail?.variants.find((variant) => variant.id === selectedVariants[item.id]) ??
                detail?.variants[0];
              const selectedVariantIsMlx =
                selectedVariant?.files.some(
                  (file) => (file.metadata?.engineType as string | undefined) === "mlx",
                ) ?? false;

              return (
                <article className="search-result-item" key={item.id}>
                  <div className="search-result-primary">
                    <div className="model-card-head search-result-head">
                      <div>
                        <span className="section-label">Repository</span>
                        <h4 className="search-result-title">{item.providerModelId}</h4>
                        {item.title !== item.providerModelId ? (
                          <p className="search-result-subtitle">{item.title}</p>
                        ) : null}
                      </div>
                      <span className="status-pill status-pill-neutral">{item.provider}</span>
                    </div>
                    <p>{item.summary ?? item.description ?? "Provider repository result."}</p>

                    {detailState.warnings.length > 0 ? (
                      <p className="search-detail-note">{detailState.warnings.join(" ")}</p>
                    ) : null}
                    {detailState.status === "error" ? (
                      <p className="search-detail-note search-detail-note-error">
                        {detailState.message}
                      </p>
                    ) : null}

                    {detail && detail.variants.length > 0 ? (
                      <div className="field-stack search-result-selector">
                        <label htmlFor={`variant-${item.id}`}>Variant</label>
                        <select
                          id={`variant-${item.id}`}
                          onChange={(event) =>
                            setSelectedVariants((current) => ({
                              ...current,
                              [item.id]: event.target.value,
                            }))
                          }
                          value={selectedVariant?.id ?? ""}
                        >
                          {detail.variants.map((variant) => (
                            <option key={variant.id} value={variant.id}>
                              {`${variant.label} / ${variant.files.length} file${variant.files.length === 1 ? "" : "s"} / ${formatSize(variant.totalSizeBytes)}`}
                            </option>
                          ))}
                        </select>
                      </div>
                    ) : null}
                  </div>

                  <div className="search-result-secondary">
                    <dl className="meta-grid compact-meta-grid search-result-meta">
                      <div>
                        <dt>Formats</dt>
                        <dd>{item.formats.join(", ") || "Unknown"}</dd>
                      </div>
                      <div>
                        <dt>Downloads</dt>
                        <dd>{formatCount(item.downloads)}</dd>
                      </div>
                      <div>
                        <dt>Updated</dt>
                        <dd>{formatUpdatedAt(item.updatedAt)}</dd>
                      </div>
                      <div>
                        <dt>Variants</dt>
                        <dd>
                          {detail
                            ? detail.variants.length
                            : detailState.status === "loading"
                              ? "Loading"
                              : "Not loaded"}
                        </dd>
                      </div>
                      {selectedVariant ? (
                        <>
                          <div>
                            <dt>Files</dt>
                            <dd>
                              {selectedVariant.files.length}{" "}
                              {selectedVariantIsMlx ? "bundle file" : "GGUF file"}
                              {selectedVariant.files.length === 1 ? "" : "s"}
                            </dd>
                          </div>
                          <div>
                            <dt>Size</dt>
                            <dd>{formatSize(selectedVariant.totalSizeBytes)}</dd>
                          </div>
                        </>
                      ) : null}
                    </dl>
                    <div className="button-row search-result-actions">
                      {detailState.status !== "ready" ? (
                        <button
                          className="secondary-button"
                          disabled={detailState.status === "loading"}
                          onClick={() => void loadCatalogModel(item)}
                          type="button"
                        >
                          {detailState.status === "loading"
                            ? "Loading variants..."
                            : "Show variants"}
                        </button>
                      ) : detail && detail.variants.length > 0 ? (
                        <button
                          className="secondary-button"
                          disabled={busy}
                          onClick={() => void createDownload(detail)}
                          type="button"
                        >
                          {selectedVariant && selectedVariant.files.length > 1
                            ? "Download all files"
                            : "Download"}
                        </button>
                      ) : (
                        <span className="status-pill status-pill-neutral">No supported variants</span>
                      )}
                    </div>
                  </div>
                </article>
              );
            })
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
                    <span
                      className={
                        task.modelId
                          ? "status-pill status-pill-positive"
                          : "status-pill status-pill-neutral"
                      }
                    >
                      {task.modelId ? "Ready to register in Model Library" : "Bundle file complete"}
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
