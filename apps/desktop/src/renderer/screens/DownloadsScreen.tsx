import type {
  DesktopDownloadTask,
  DesktopProviderCatalogDetail,
  DesktopProviderCatalogFile,
  DesktopProviderCatalogVariant,
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

const formatByteRatio = (downloadedBytes: number, totalBytes: number | undefined): string =>
  totalBytes && totalBytes > 0
    ? `${formatBytes(downloadedBytes)} / ${formatBytes(totalBytes)}`
    : `${formatBytes(downloadedBytes)} downloaded`;

const getVariantSelectionKey = (detailId: string, variantId: string): string =>
  `${detailId}:${variantId}`;

const getMmprojFiles = (
  variant: DesktopProviderCatalogVariant | undefined,
): DesktopProviderCatalogFile[] =>
  variant?.files.filter((file) => file.auxiliary && file.auxiliaryKind === "mmproj") ?? [];

const getSelectedVariantFiles = (
  variant: DesktopProviderCatalogVariant | undefined,
  selectedMmprojId: string | undefined,
): DesktopProviderCatalogFile[] => {
  if (!variant) {
    return [];
  }

  const modelFiles = variant.files.filter((file) => !file.auxiliary);
  const mmprojFiles = getMmprojFiles(variant);
  const otherAuxiliaryFiles = variant.files.filter(
    (file) => file.auxiliary && file.auxiliaryKind !== "mmproj",
  );

  if (mmprojFiles.length <= 1) {
    return [...modelFiles, ...otherAuxiliaryFiles, ...mmprojFiles];
  }

  const selectedMmproj =
    mmprojFiles.find((file) => file.id === selectedMmprojId) ?? mmprojFiles[0] ?? null;

  return [...modelFiles, ...otherAuxiliaryFiles, ...(selectedMmproj ? [selectedMmproj] : [])];
};

const getVariantDownloadLabel = (isMlx: boolean, fileCount: number): string => {
  if (isMlx) {
    return fileCount > 1 ? "Download MLX bundle" : "Download MLX file";
  }

  return fileCount > 1 ? "Download GGUF bundle" : "Download GGUF";
};

function buildDownloadTitle(
  detail: DesktopProviderCatalogDetail,
  variant: DesktopProviderCatalogVariant,
) {
  return variant.label === "Default" ? detail.title : `${detail.title} (${variant.label})`;
}

export function DownloadsScreen({ shellState }: DownloadsScreenProps) {
  const [query, setQuery] = useState("qwen");
  const [results, setResults] = useState<DesktopProviderSearchItem[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [downloads, setDownloads] = useState<DesktopDownloadTask[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [catalogDetails, setCatalogDetails] = useState<Record<string, CatalogDetailState>>({});
  const [selectedVariants, setSelectedVariants] = useState<Record<string, string>>({});
  const [selectedMmprojFiles, setSelectedMmprojFiles] = useState<Record<string, string>>({});
  const [selectedDownloadTask, setSelectedDownloadTask] = useState<DesktopDownloadTask | null>(
    null,
  );
  const [deleteFilesByTaskId, setDeleteFilesByTaskId] = useState<Record<string, boolean>>({});

  const refreshDownloads = async () => {
    try {
      const response = await window.desktopApi.gateway.listDownloads();
      setDownloads(response.data);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to load downloads.");
    }
  };

  useEffect(() => {
    if (shellState.phase !== "connected") {
      return;
    }

    let cancelled = false;
    const refresh = async () => {
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

    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, BACKGROUND_REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [shellState.phase]);

  useEffect(() => {
    if (!selectedDownloadTask) {
      return;
    }

    const updatedTask = downloads.find((task) => task.id === selectedDownloadTask.id);
    setSelectedDownloadTask(updatedTask ?? null);
  }, [downloads, selectedDownloadTask]);

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
      setSelectedMmprojFiles({});
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

      const initialVariant = response.data.variants[0];
      setSelectedVariants((current) =>
        current[item.id]
          ? current
          : {
              ...current,
              ...(initialVariant ? { [item.id]: initialVariant.id } : {}),
            },
      );

      if (initialVariant) {
        const initialMmprojFiles = getMmprojFiles(initialVariant);
        if (initialMmprojFiles.length > 1) {
          const selectionKey = getVariantSelectionKey(item.id, initialVariant.id);
          setSelectedMmprojFiles((current) =>
            current[selectionKey]
              ? current
              : {
                  ...current,
                  [selectionKey]: initialMmprojFiles[0]!.id,
                },
          );
        }
      }
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

  const handleVariantChange = (
    itemId: string,
    detail: DesktopProviderCatalogDetail,
    variantId: string,
  ) => {
    setSelectedVariants((current) => ({
      ...current,
      [itemId]: variantId,
    }));

    const variant = detail.variants.find((entry) => entry.id === variantId);
    if (!variant) {
      return;
    }

    const mmprojFiles = getMmprojFiles(variant);
    const selectionKey = getVariantSelectionKey(itemId, variant.id);
    setSelectedMmprojFiles((current) => {
      if (mmprojFiles.length <= 1) {
        if (!(selectionKey in current)) {
          return current;
        }

        const nextSelections = { ...current };
        delete nextSelections[selectionKey];
        return nextSelections;
      }

      if (current[selectionKey] && mmprojFiles.some((file) => file.id === current[selectionKey])) {
        return current;
      }

      return {
        ...current,
        [selectionKey]: mmprojFiles[0]!.id,
      };
    });
  };

  const createDownload = async (detail: DesktopProviderCatalogDetail) => {
    const selectedVariant =
      detail.variants.find((variant) => variant.id === selectedVariants[detail.id]) ??
      detail.variants[0];
    if (!selectedVariant) {
      return;
    }

    const selectedFiles = getSelectedVariantFiles(
      selectedVariant,
      selectedMmprojFiles[getVariantSelectionKey(detail.id, selectedVariant.id)],
    );
    if (selectedFiles.length === 0) {
      return;
    }

    const taskGroupId =
      globalThis.crypto?.randomUUID?.() ??
      `download-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const displayTitle = buildDownloadTitle(detail, selectedVariant);
    const bundleFiles = selectedFiles.map((file) => ({
      artifactId: file.artifactId,
      artifactName: file.artifactName,
      ...(file.downloadUrl ? { downloadUrl: file.downloadUrl } : {}),
      ...(file.checksumSha256 ? { checksumSha256: file.checksumSha256 } : {}),
      ...(file.sizeBytes !== undefined ? { sizeBytes: file.sizeBytes } : {}),
      auxiliary: file.auxiliary,
      ...(file.auxiliaryKind ? { auxiliaryKind: file.auxiliaryKind } : {}),
      metadata: {
        ...file.metadata,
        autoRegister: file.artifactId === selectedVariant.primaryArtifactId,
        bundleId: taskGroupId,
        bundlePrimaryArtifactId: selectedVariant.primaryArtifactId,
        auxiliary: file.auxiliary,
        ...(file.auxiliaryKind ? { auxiliaryKind: file.auxiliaryKind } : {}),
      },
    }));
    const primaryBundleFile = bundleFiles[0];
    if (!primaryBundleFile) {
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await window.desktopApi.gateway.createDownload({
        provider: detail.provider,
        providerModelId: detail.providerModelId,
        artifactId: primaryBundleFile.artifactId,
        title: displayTitle,
        artifactName: primaryBundleFile.artifactName,
        taskGroupId,
        ...(primaryBundleFile.downloadUrl ? { downloadUrl: primaryBundleFile.downloadUrl } : {}),
        ...(primaryBundleFile.checksumSha256
          ? { checksumSha256: primaryBundleFile.checksumSha256 }
          : {}),
        ...(primaryBundleFile.sizeBytes !== undefined
          ? { sizeBytes: primaryBundleFile.sizeBytes }
          : {}),
        metadata: primaryBundleFile.metadata,
        files: bundleFiles,
      });

      await refreshDownloads();
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
      if (task.status === "error") {
        await window.desktopApi.gateway.retryDownload(task.id);
      } else if (task.status === "paused") {
        await window.desktopApi.gateway.resumeDownload(task.id);
      } else if (task.status === "downloading" || task.status === "pending") {
        await window.desktopApi.gateway.pauseDownload(task.id);
      }
      await refreshDownloads();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to update download state.");
    } finally {
      setBusy(false);
    }
  };

  const deleteDownload = async (task: DesktopDownloadTask) => {
    setBusy(true);
    setError(null);
    try {
      await window.desktopApi.gateway.deleteDownload(task.id, {
        deleteFiles: deleteFilesByTaskId[task.id] === true,
      });
      setSelectedDownloadTask((current) => (current?.id === task.id ? null : current));
      await refreshDownloads();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to delete download task.");
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
            Search providers, pick a variant, and queue a single grouped task per model request.
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
              const selectedDownloadFiles = getSelectedVariantFiles(
                selectedVariant,
                selectedMmprojFiles[
                  selectedVariant ? getVariantSelectionKey(item.id, selectedVariant.id) : ""
                ],
              );
              const mmprojOptions = getMmprojFiles(selectedVariant);
              const selectedVariantLabel = selectedVariantIsMlx ? "MLX bundle" : "GGUF";

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
                    {selectedVariant ? (
                      <div className="pill-row search-result-pill-row">
                        <span
                          className={
                            selectedVariantIsMlx
                              ? "meta-pill meta-pill-mlx"
                              : "meta-pill meta-pill-muted"
                          }
                        >
                          {selectedVariantLabel}
                        </span>
                        {mmprojOptions.length > 1 ? (
                          <span className="meta-pill meta-pill-muted">
                            Pick one mmproj sidecar for vision support
                          </span>
                        ) : null}
                        {selectedVariantIsMlx ? (
                          <span className="meta-pill meta-pill-muted">
                            Use this to run the MLX backend
                          </span>
                        ) : null}
                      </div>
                    ) : null}
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
                            handleVariantChange(item.id, detail, event.target.value)
                          }
                          value={selectedVariant?.id ?? ""}
                        >
                          {detail.variants.map((variant) => (
                            <option key={variant.id} value={variant.id}>
                              {`${variant.label} / ${getSelectedVariantFiles(variant, selectedMmprojFiles[getVariantSelectionKey(item.id, variant.id)]).length} selected / ${formatSize(variant.totalSizeBytes)}`}
                            </option>
                          ))}
                        </select>
                      </div>
                    ) : null}

                    {mmprojOptions.length > 1 && selectedVariant ? (
                      <div className="field-stack search-result-selector">
                        <label htmlFor={`mmproj-${item.id}`}>Vision projector</label>
                        <select
                          id={`mmproj-${item.id}`}
                          onChange={(event) =>
                            setSelectedMmprojFiles((current) => ({
                              ...current,
                              [getVariantSelectionKey(item.id, selectedVariant.id)]:
                                event.target.value,
                            }))
                          }
                          value={
                            selectedMmprojFiles[
                              getVariantSelectionKey(item.id, selectedVariant.id)
                            ] ?? mmprojOptions[0]?.id
                          }
                        >
                          {mmprojOptions.map((file) => (
                            <option key={file.id} value={file.id}>
                              {file.artifactName}
                            </option>
                          ))}
                        </select>
                        <p className="search-detail-note">
                          Multimodal downloads only need one `mmproj` GGUF. Pick the one you want to
                          keep with the model.
                        </p>
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
                            <dt>Selected files</dt>
                            <dd>{selectedDownloadFiles.length}</dd>
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
                          {selectedVariant
                            ? getVariantDownloadLabel(
                                selectedVariantIsMlx,
                                selectedDownloadFiles.length,
                              )
                            : "Download"}
                        </button>
                      ) : (
                        <span className="status-pill status-pill-neutral">
                          No supported variants
                        </span>
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
              <strong>No downloads yet.</strong>
              <p>Each model request appears here as a single grouped task card.</p>
            </div>
          ) : (
            downloads.map((task) => (
              <article
                className={`model-card download-task-card${task.status === "error" ? " download-task-card-error" : ""}`}
                key={task.id}
                onClick={() => setSelectedDownloadTask(task)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setSelectedDownloadTask(task);
                  }
                }}
                role="button"
                tabIndex={0}
              >
                <div className="model-card-head">
                  <div>
                    <h4>{task.title}</h4>
                    <p className="download-task-subtitle">{task.providerModelId}</p>
                  </div>
                  <span className="status-pill status-pill-neutral">{task.status}</span>
                </div>
                <p>
                  {task.completedFileCount}/{task.fileCount} files •{" "}
                  {formatByteRatio(task.downloadedBytes, task.totalBytes)}
                </p>
                <div className="progress-track">
                  <div className="progress-fill" style={{ width: `${task.progress}%` }} />
                </div>
                <p>
                  {task.progress}% downloaded
                  {task.errorFileCount > 0 ? ` • ${task.errorFileCount} file error` : ""}
                </p>
                {task.errorMessage ? (
                  <p className="download-task-error-text">{task.errorMessage}</p>
                ) : null}
                <div
                  className="button-row download-task-actions"
                  onClick={(event) => event.stopPropagation()}
                >
                  {(task.status === "pending" ||
                    task.status === "downloading" ||
                    task.status === "paused" ||
                    task.status === "error") && (
                    <button
                      className="secondary-button"
                      disabled={busy}
                      onClick={() => void toggleDownload(task)}
                      type="button"
                    >
                      {task.status === "paused"
                        ? "Resume"
                        : task.status === "error"
                          ? "Retry"
                          : "Pause"}
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
                      {task.modelId ? "Indexed in Model Library" : "Download complete"}
                    </span>
                  ) : null}
                </div>
                <div
                  className="download-task-delete-row"
                  onClick={(event) => event.stopPropagation()}
                >
                  <label className="checkbox-row">
                    <input
                      checked={deleteFilesByTaskId[task.id] === true}
                      onChange={(event) =>
                        setDeleteFilesByTaskId((current) => ({
                          ...current,
                          [task.id]: event.target.checked,
                        }))
                      }
                      type="checkbox"
                    />
                    Delete downloaded files too
                  </label>
                  <button
                    className="secondary-button danger-button"
                    disabled={busy}
                    onClick={() => void deleteDownload(task)}
                    type="button"
                  >
                    Delete task
                  </button>
                </div>
              </article>
            ))
          )}
        </div>
      </article>

      {selectedDownloadTask ? (
        <div
          className="model-detail-modal-backdrop download-detail-backdrop"
          onClick={() => setSelectedDownloadTask(null)}
        >
          <section
            aria-labelledby="download-detail-modal-title"
            aria-modal="true"
            className="model-detail-modal download-detail-modal"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
          >
            <div className="modal-shell-header">
              <div>
                <span className="section-label">Download details</span>
                <h3 id="download-detail-modal-title">{selectedDownloadTask.title}</h3>
                <p>{selectedDownloadTask.providerModelId}</p>
              </div>
              <div className="modal-shell-actions">
                <span className="status-pill status-pill-neutral">
                  {selectedDownloadTask.status}
                </span>
                <button
                  className="secondary-button"
                  onClick={() => setSelectedDownloadTask(null)}
                  type="button"
                >
                  Close
                </button>
              </div>
            </div>

            <div className="modal-panel">
              {selectedDownloadTask.errorMessage ? (
                <article className="info-card feedback-card feedback-card-error">
                  <strong>Latest error</strong>
                  <p>{selectedDownloadTask.errorMessage}</p>
                </article>
              ) : null}

              <dl className="meta-grid modal-meta-grid">
                <div>
                  <dt>Files</dt>
                  <dd>
                    {selectedDownloadTask.completedFileCount}/{selectedDownloadTask.fileCount}
                  </dd>
                </div>
                <div>
                  <dt>Downloaded</dt>
                  <dd>
                    {formatByteRatio(
                      selectedDownloadTask.downloadedBytes,
                      selectedDownloadTask.totalBytes,
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Progress</dt>
                  <dd>{selectedDownloadTask.progress}%</dd>
                </div>
                <div>
                  <dt>Updated</dt>
                  <dd>{new Date(selectedDownloadTask.updatedAt).toLocaleString()}</dd>
                </div>
              </dl>

              <div className="download-detail-file-list">
                {selectedDownloadTask.files.map((file) => (
                  <article className="modal-section-card download-detail-file-card" key={file.id}>
                    <div className="model-card-head">
                      <div>
                        <h4>{file.artifactName}</h4>
                        <p>{formatByteRatio(file.downloadedBytes, file.totalBytes)}</p>
                      </div>
                      <div className="download-detail-file-badges">
                        {file.auxiliary ? (
                          <span className="meta-pill meta-pill-muted">
                            {file.auxiliaryKind ?? "auxiliary"}
                          </span>
                        ) : null}
                        <span className="status-pill status-pill-neutral">{file.status}</span>
                      </div>
                    </div>
                    <div className="progress-track">
                      <div className="progress-fill" style={{ width: `${file.progress}%` }} />
                    </div>
                    <p>{file.progress}% downloaded</p>
                    <p className="download-detail-path">{file.destinationPath}</p>
                    {file.errorMessage ? (
                      <p className="download-task-error-text">{file.errorMessage}</p>
                    ) : null}
                  </article>
                ))}
              </div>
            </div>
          </section>
        </div>
      ) : null}
    </section>
  );
}
