import {
  DEFAULT_MLX_LM_VERSION,
  DEFAULT_MLX_PYTHON_VERSION,
  DEFAULT_MLX_VERSION,
  buildMlxVersionTag,
} from "../../../../packages/engine-mlx/src/versioning.js";

const LLAMA_CPP_RELEASES_API = "https://api.github.com/repos/ggml-org/llama.cpp/releases/latest";
const PYPI_JSON_URL = (packageName: string): string => `https://pypi.org/pypi/${packageName}/json`;
const DEFAULT_TIMEOUT_MS = 5_000;

export interface LlamaCppUpdateSnapshot {
  latestReleaseTag?: string;
  statusMessage?: string;
}

export interface MlxUpdateSnapshot {
  latestMlxVersion?: string;
  latestMlxLmVersion?: string;
  latestVersionTag?: string;
  statusMessage?: string;
}

export interface EngineUpdateSnapshot {
  llama: LlamaCppUpdateSnapshot;
  mlx: MlxUpdateSnapshot;
}

interface GitHubReleasePayload {
  tag_name?: unknown;
}

interface PypiProjectPayload {
  info?: {
    version?: unknown;
  };
}

function formatErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return fallback;
}

async function fetchJson<T>(
  url: string,
  fetchImpl: typeof fetch,
  options: {
    headers?: Record<string, string>;
    resourceLabel: string;
    timeoutMs?: number;
  },
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      ...(options.headers ? { headers: options.headers } : {}),
    });

    if (!response.ok) {
      throw new Error(`Unable to load ${options.resourceLabel} (${response.status}).`);
    }

    return (await response.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchLatestLlamaCppReleaseTag(
  fetchImpl: typeof fetch = fetch,
): Promise<LlamaCppUpdateSnapshot> {
  try {
    const payload = await fetchJson<GitHubReleasePayload>(LLAMA_CPP_RELEASES_API, fetchImpl, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "LM Hub",
      },
      resourceLabel: "llama.cpp release metadata",
    });

    return typeof payload.tag_name === "string" && payload.tag_name.trim().length > 0
      ? { latestReleaseTag: payload.tag_name.trim() }
      : { statusMessage: "llama.cpp latest release metadata did not include a tag." };
  } catch (error) {
    return {
      statusMessage: formatErrorMessage(
        error,
        "Unable to check the latest llama.cpp release right now.",
      ),
    };
  }
}

export async function fetchLatestPypiVersion(
  packageName: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ version?: string; statusMessage?: string }> {
  try {
    const payload = await fetchJson<PypiProjectPayload>(PYPI_JSON_URL(packageName), fetchImpl, {
      resourceLabel: `${packageName} package metadata`,
    });
    const version = payload.info?.version;

    return typeof version === "string" && version.trim().length > 0
      ? { version: version.trim() }
      : { statusMessage: `${packageName} metadata did not include a version.` };
  } catch (error) {
    return {
      statusMessage: formatErrorMessage(error, `Unable to check the latest ${packageName} build.`),
    };
  }
}

export async function fetchLatestMlxRuntimeVersions(
  fetchImpl: typeof fetch = fetch,
): Promise<MlxUpdateSnapshot> {
  const [mlxResult, mlxLmResult] = await Promise.all([
    fetchLatestPypiVersion("mlx", fetchImpl),
    fetchLatestPypiVersion("mlx-lm", fetchImpl),
  ]);

  if (mlxResult.version && mlxLmResult.version) {
    return {
      latestMlxVersion: mlxResult.version,
      latestMlxLmVersion: mlxLmResult.version,
      latestVersionTag: buildMlxVersionTag({
        pythonVersion: DEFAULT_MLX_PYTHON_VERSION,
        mlxVersion: mlxResult.version,
        mlxLmVersion: mlxLmResult.version,
      }),
    };
  }

  if (!mlxResult.version && !mlxLmResult.version) {
    return {
      latestMlxVersion: DEFAULT_MLX_VERSION,
      latestMlxLmVersion: DEFAULT_MLX_LM_VERSION,
      latestVersionTag: buildMlxVersionTag({
        pythonVersion: DEFAULT_MLX_PYTHON_VERSION,
        mlxVersion: DEFAULT_MLX_VERSION,
        mlxLmVersion: DEFAULT_MLX_LM_VERSION,
      }),
      statusMessage:
        mlxResult.statusMessage ??
        mlxLmResult.statusMessage ??
        "Unable to check the latest MLX runtime.",
    };
  }

  return {
    ...(mlxResult.version ? { latestMlxVersion: mlxResult.version } : {}),
    ...(mlxLmResult.version ? { latestMlxLmVersion: mlxLmResult.version } : {}),
    statusMessage:
      mlxResult.statusMessage ?? mlxLmResult.statusMessage ?? "MLX runtime metadata is incomplete.",
  };
}

export async function fetchEngineUpdateSnapshot(
  fetchImpl: typeof fetch = fetch,
): Promise<EngineUpdateSnapshot> {
  const [llama, mlx] = await Promise.all([
    fetchLatestLlamaCppReleaseTag(fetchImpl),
    fetchLatestMlxRuntimeVersions(fetchImpl),
  ]);

  return {
    llama,
    mlx,
  };
}
