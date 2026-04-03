import type {
  ModelProvider,
  ProviderDownloadPlan,
  ProviderDownloadRequest,
  ProviderId,
  ProviderModelSummary,
  ProviderSearchQuery,
  ProviderSearchResult,
} from "@localhub/shared-contracts/foundation-providers";

export interface ProviderSearchServiceOptions {
  fetch?: typeof fetch;
  huggingFaceBaseUrl?: string;
  modelScopeBaseUrl?: string;
}

interface JsonResponse {
  [key: string]: unknown;
}

const DEFAULT_HUGGINGFACE_BASE_URL = "https://huggingface.co";
const DEFAULT_MODELSCOPE_BASE_URL = "https://www.modelscope.cn";

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function toOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function toOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function toOptionalTimestamp(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const epochMs = value > 1_000_000_000_000 ? value : value * 1_000;
    return new Date(epochMs).toISOString();
  }

  if (typeof value === "string" && value.length > 0) {
    const numericValue = Number(value);
    if (Number.isFinite(numericValue) && numericValue > 0) {
      const epochMs = numericValue > 1_000_000_000_000 ? numericValue : numericValue * 1_000;
      return new Date(epochMs).toISOString();
    }

    return value;
  }

  return undefined;
}

function toArtifactId(fileName: string): string {
  return fileName
    .replace(/\.[^.]+$/, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .toLowerCase();
}

function mapFormat(fileName: string): "gguf" | undefined {
  return fileName.toLowerCase().endsWith(".gguf") ? "gguf" : undefined;
}

function encodeProviderModelId(providerModelId: string): string {
  return providerModelId
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function toModelScopeProviderModelId(item: JsonResponse): string {
  const modelId = toOptionalString(item.ModelId);
  if (modelId) {
    return modelId;
  }

  const path = toOptionalString(item.Path);
  const name = toOptionalString(item.Name);
  if (path && name) {
    return path.endsWith(`/${name}`) ? path : `${path}/${name}`;
  }

  return path ?? "unknown/model";
}

async function readJson(
  fetchImpl: typeof fetch,
  url: string,
  init?: RequestInit,
): Promise<JsonResponse | JsonResponse[]> {
  const response = await fetchImpl(url, init);
  if (!response.ok) {
    throw new Error(`Provider request failed with status ${response.status} for ${url}`);
  }

  return (await response.json()) as JsonResponse | JsonResponse[];
}

function normalizeHuggingFaceItem(baseUrl: string, item: JsonResponse): ProviderModelSummary {
  const providerModelId = toOptionalString(item.id) ?? "unknown/model";
  const files = Array.isArray(item.siblings) ? item.siblings : [];
  const artifacts = files
    .map((entry) => (entry && typeof entry === "object" ? (entry as JsonResponse) : undefined))
    .filter((entry): entry is JsonResponse => Boolean(entry))
    .map((entry) => {
      const fileName = toOptionalString(entry.rfilename) ?? toOptionalString(entry.path);
      if (!fileName) {
        return undefined;
      }

      const format = mapFormat(fileName);
      if (!format) {
        return undefined;
      }

      const artifact: ProviderModelSummary["artifacts"][number] = {
        artifactId: toArtifactId(fileName),
        fileName,
        format,
        downloadUrl: `${normalizeBaseUrl(baseUrl)}/${providerModelId}/resolve/main/${fileName}`,
      };

      const lfs =
        entry.lfs && typeof entry.lfs === "object" ? (entry.lfs as JsonResponse) : undefined;
      const sizeBytes = toOptionalNumber(entry.size) ?? toOptionalNumber(lfs?.size);
      if (sizeBytes !== undefined) {
        artifact.sizeBytes = sizeBytes;
      }

      const sha256 = toOptionalString(lfs?.sha256);
      if (sha256) {
        artifact.checksum = {
          algorithm: "sha256",
          value: sha256,
          source: "provider",
          status: "verified",
        };
      }

      return artifact;
    })
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

  const summary: ProviderModelSummary = {
    provider: "huggingface",
    providerModelId,
    title: toOptionalString(item.id)?.split("/").at(-1) ?? providerModelId,
    repositoryUrl: `${normalizeBaseUrl(baseUrl)}/${providerModelId}`,
    tags: toStringArray(item.tags),
    formats: artifacts.map((artifact) => artifact.format),
    artifacts,
  };

  const author = toOptionalString(item.author);
  const license = toOptionalString(item.license);
  const downloads = toOptionalNumber(item.downloads);
  const likes = toOptionalNumber(item.likes);
  const updatedAt = toOptionalString(item.lastModified);
  const description = toOptionalString(item.description);

  if (author) {
    summary.author = author;
  }
  if (license) {
    summary.license = license;
  }
  if (downloads !== undefined) {
    summary.downloads = downloads;
  }
  if (likes !== undefined) {
    summary.likes = likes;
  }
  if (updatedAt) {
    summary.updatedAt = updatedAt;
  }
  if (description) {
    summary.description = description;
  }

  return summary;
}

function normalizeModelScopeArtifacts(
  baseUrl: string,
  providerModelId: string,
  files: JsonResponse[],
): ProviderModelSummary["artifacts"] {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);

  return files
    .map((entry) => (entry && typeof entry === "object" ? (entry as JsonResponse) : undefined))
    .filter((entry): entry is JsonResponse => Boolean(entry))
    .map((entry) => {
      const fileName = toOptionalString(entry.Path) ?? toOptionalString(entry.Name);
      if (!fileName) {
        return undefined;
      }

      const format = mapFormat(fileName);
      if (!format) {
        return undefined;
      }

      const artifact: ProviderModelSummary["artifacts"][number] = {
        artifactId: toArtifactId(fileName),
        fileName,
        format,
        downloadUrl: `${normalizedBaseUrl}/api/v1/models/${encodeProviderModelId(providerModelId)}/repo?Revision=${encodeURIComponent(toOptionalString(entry.Revision) ?? "master")}&FilePath=${encodeURIComponent(fileName)}`,
      };

      const sizeBytes = toOptionalNumber(entry.Size);
      if (sizeBytes !== undefined) {
        artifact.sizeBytes = sizeBytes;
      }

      const sha256 = toOptionalString(entry.Sha256);
      if (sha256) {
        artifact.checksum = {
          algorithm: "sha256",
          value: sha256,
          source: "provider",
          status: "verified",
        };
      }

      return artifact;
    })
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
}

function normalizeModelScopeItem(
  baseUrl: string,
  item: JsonResponse,
  files: JsonResponse[] = [],
): ProviderModelSummary {
  const providerModelId = toModelScopeProviderModelId(item);
  const path = toOptionalString(item.Path);
  const name = toOptionalString(item.Name);
  const author =
    path && name && !path.endsWith(`/${name}`)
      ? path
      : providerModelId.split("/").slice(0, -1).join("/") || undefined;
  const artifacts =
    files.length > 0 ? normalizeModelScopeArtifacts(baseUrl, providerModelId, files) : [];

  const summary: ProviderModelSummary = {
    provider: "modelscope",
    providerModelId,
    title: name ?? providerModelId.split("/").at(-1) ?? providerModelId,
    repositoryUrl: `${normalizeBaseUrl(baseUrl)}/models/${providerModelId}`,
    tags: toStringArray(item.Tags),
    formats: artifacts.map((artifact) => artifact.format),
    artifacts,
  };

  const license = toOptionalString(item.License);
  const downloads = toOptionalNumber(item.Downloads) ?? toOptionalNumber(item.DownloadCount);
  const likes = toOptionalNumber(item.LikeCount);
  const updatedAt =
    toOptionalTimestamp(item.LastUpdatedTime) ?? toOptionalTimestamp(item.UpdatedAt);
  const description = toOptionalString(item.Description);

  if (author) {
    summary.author = author;
  }
  if (license) {
    summary.license = license;
  }
  if (downloads !== undefined) {
    summary.downloads = downloads;
  }
  if (likes !== undefined) {
    summary.likes = likes;
  }
  if (updatedAt) {
    summary.updatedAt = updatedAt;
  }
  if (description) {
    summary.description = description;
  }

  return summary;
}

export class HuggingFaceProvider implements ModelProvider {
  readonly id = "huggingface" as const;
  readonly #fetch: typeof fetch;
  readonly #baseUrl: string;

  constructor(options: ProviderSearchServiceOptions = {}) {
    this.#fetch = options.fetch ?? fetch;
    this.#baseUrl = normalizeBaseUrl(options.huggingFaceBaseUrl ?? DEFAULT_HUGGINGFACE_BASE_URL);
  }

  async search(query: ProviderSearchQuery): Promise<ProviderSearchResult> {
    const url = new URL(`${this.#baseUrl}/api/models`);
    url.searchParams.set("search", query.text);
    url.searchParams.set("limit", String(query.limit));
    url.searchParams.set("full", "true");

    const startedAt = Date.now();
    const payload = await readJson(this.#fetch, url.toString());
    const items = Array.isArray(payload)
      ? await Promise.all(
          payload.map(async (item) => {
            const providerModelId = toOptionalString(item.id);
            if (!providerModelId) {
              return normalizeHuggingFaceItem(this.#baseUrl, item);
            }

            try {
              const detailUrl = new URL(
                `${this.#baseUrl}/api/models/${encodeProviderModelId(providerModelId)}`,
              );
              detailUrl.searchParams.set("blobs", "true");
              const detail = (await readJson(this.#fetch, detailUrl.toString())) as JsonResponse;
              return normalizeHuggingFaceItem(this.#baseUrl, detail);
            } catch {
              return normalizeHuggingFaceItem(this.#baseUrl, item);
            }
          }),
        )
      : [];

    return {
      items: items.filter((item) => item.artifacts.length > 0),
      warnings: [],
      sourceLatencyMs: Date.now() - startedAt,
    };
  }

  async resolveDownload(request: ProviderDownloadRequest): Promise<ProviderDownloadPlan> {
    const detailUrl = new URL(
      `${this.#baseUrl}/api/models/${encodeProviderModelId(request.providerModelId)}`,
    );
    detailUrl.searchParams.set("blobs", "true");
    const detail = (await readJson(this.#fetch, detailUrl.toString())) as JsonResponse;
    const model = normalizeHuggingFaceItem(this.#baseUrl, detail);
    const artifact = model.artifacts.find((item) => item.artifactId === request.artifactId);
    if (!artifact || !artifact.downloadUrl) {
      throw new Error(
        `Unable to resolve HuggingFace artifact ${request.providerModelId}:${request.artifactId}.`,
      );
    }

    const head = await this.#fetch(artifact.downloadUrl, { method: "HEAD" });
    const totalBytes = toOptionalNumber(Number(head.headers.get("content-length")));
    const acceptsRanges = head.headers.get("accept-ranges")?.includes("bytes") ?? false;

    return {
      provider: this.id,
      artifactId: request.artifactId,
      url: artifact.downloadUrl,
      headers: {},
      fileName: artifact.fileName,
      supportsRange: acceptsRanges,
      ...(totalBytes !== undefined ? { estimatedSizeBytes: totalBytes } : {}),
      ...(artifact.checksum ? { checksum: artifact.checksum } : {}),
    };
  }
}

export class ModelScopeProvider implements ModelProvider {
  readonly id = "modelscope" as const;
  readonly #fetch: typeof fetch;
  readonly #baseUrl: string;

  constructor(options: ProviderSearchServiceOptions = {}) {
    this.#fetch = options.fetch ?? fetch;
    this.#baseUrl = normalizeBaseUrl(options.modelScopeBaseUrl ?? DEFAULT_MODELSCOPE_BASE_URL);
  }

  async search(query: ProviderSearchQuery): Promise<ProviderSearchResult> {
    const pageSize = Math.min(Math.max(query.limit * 3, query.limit), 60);

    const startedAt = Date.now();
    const payload = (await readJson(this.#fetch, `${this.#baseUrl}/api/v1/models`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        PageSize: pageSize,
        PageNumber: 1,
        Target: query.text,
        Sort: {
          SortBy: "Default",
        },
        Criterion: [],
      }),
    })) as JsonResponse;
    const data =
      payload.Data && typeof payload.Data === "object" ? (payload.Data as JsonResponse) : {};
    const models = Array.isArray(data.Models) ? data.Models : [];
    const items = await Promise.all(
      models.map(async (item) => {
        const candidate = item as JsonResponse;
        const providerModelId = toModelScopeProviderModelId(candidate);

        try {
          const filesUrl = new URL(
            `${this.#baseUrl}/api/v1/models/${encodeProviderModelId(providerModelId)}/repo/files`,
          );
          filesUrl.searchParams.set("Recursive", "True");
          const filesPayload = (await readJson(this.#fetch, filesUrl.toString())) as JsonResponse;
          const filesData =
            filesPayload.Data && typeof filesPayload.Data === "object"
              ? (filesPayload.Data as JsonResponse)
              : {};
          const files = Array.isArray(filesData.Files)
            ? filesData.Files.map((entry) =>
                entry && typeof entry === "object" ? (entry as JsonResponse) : undefined,
              ).filter((entry): entry is JsonResponse => Boolean(entry))
            : [];

          return normalizeModelScopeItem(this.#baseUrl, candidate, files);
        } catch {
          return normalizeModelScopeItem(this.#baseUrl, candidate);
        }
      }),
    );

    return {
      items: items.filter((item) => item.artifacts.length > 0).slice(0, query.limit),
      warnings: [],
      sourceLatencyMs: Date.now() - startedAt,
    };
  }

  async resolveDownload(request: ProviderDownloadRequest): Promise<ProviderDownloadPlan> {
    const filesUrl = new URL(
      `${this.#baseUrl}/api/v1/models/${encodeProviderModelId(request.providerModelId)}/repo/files`,
    );
    filesUrl.searchParams.set("Recursive", "True");
    const filesPayload = (await readJson(this.#fetch, filesUrl.toString())) as JsonResponse;
    const filesData =
      filesPayload.Data && typeof filesPayload.Data === "object"
        ? (filesPayload.Data as JsonResponse)
        : {};
    const files = Array.isArray(filesData.Files)
      ? filesData.Files.map((entry) =>
          entry && typeof entry === "object" ? (entry as JsonResponse) : undefined,
        ).filter((entry): entry is JsonResponse => Boolean(entry))
      : [];
    const artifact = normalizeModelScopeArtifacts(
      this.#baseUrl,
      request.providerModelId,
      files,
    ).find((item) => item.artifactId === request.artifactId);
    if (!artifact || !artifact.downloadUrl) {
      throw new Error(
        `Unable to resolve ModelScope artifact ${request.providerModelId}:${request.artifactId}.`,
      );
    }

    const head = await this.#fetch(artifact.downloadUrl, { method: "HEAD" });
    const totalBytes = toOptionalNumber(Number(head.headers.get("content-length")));
    const acceptsRanges = head.headers.get("accept-ranges")?.includes("bytes") ?? false;

    return {
      provider: this.id,
      artifactId: request.artifactId,
      url: artifact.downloadUrl,
      headers: {},
      fileName: artifact.fileName,
      supportsRange: acceptsRanges,
      ...(totalBytes !== undefined ? { estimatedSizeBytes: totalBytes } : {}),
      ...(artifact.checksum ? { checksum: artifact.checksum } : {}),
    };
  }
}

export class ProviderSearchService {
  readonly #providers: Map<ProviderId, ModelProvider>;

  constructor(providers: ModelProvider[]) {
    this.#providers = new Map(providers.map((provider) => [provider.id, provider]));
  }

  listProviders(): ProviderId[] {
    return Array.from(this.#providers.keys());
  }

  getProvider(providerId: ProviderId): ModelProvider {
    const provider = this.#providers.get(providerId);
    if (!provider) {
      throw new Error(`Unknown model provider: ${providerId}`);
    }

    return provider;
  }

  async search(
    query: ProviderSearchQuery,
    providerIds: ProviderId[] = this.listProviders(),
  ): Promise<ProviderSearchResult> {
    const startedAt = Date.now();
    const settled = await Promise.allSettled(
      providerIds.map(async (providerId) => this.getProvider(providerId).search(query)),
    );
    const warnings: string[] = [];
    const items: ProviderModelSummary[] = [];

    for (const [index, result] of settled.entries()) {
      if (result.status === "fulfilled") {
        items.push(...result.value.items);
        warnings.push(...result.value.warnings);
      } else {
        warnings.push(
          `${providerIds[index]} search failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
        );
      }
    }

    items.sort((left, right) => (right.downloads ?? 0) - (left.downloads ?? 0));

    return {
      items: items.slice(0, query.limit),
      warnings,
      sourceLatencyMs: Date.now() - startedAt,
    };
  }
}

export function createDefaultProviderSearchService(
  options: ProviderSearchServiceOptions = {},
): ProviderSearchService {
  return new ProviderSearchService([
    new HuggingFaceProvider(options),
    new ModelScopeProvider(options),
  ]);
}
