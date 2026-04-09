import { createHash, randomUUID } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { finished } from "node:stream/promises";

import type { DownloadTasksRepository } from "@localhub/db";
import type { GatewayEvent } from "@localhub/shared-contracts/foundation-events";
import type { DownloadTask } from "@localhub/shared-contracts/foundation-persistence";
import type {
  ProviderDownloadRequest,
  ProviderId,
  ProviderModelSummary,
  ProviderSearchQuery,
  ProviderSearchResult,
} from "@localhub/shared-contracts/foundation-providers";

import type { ProviderSearchService } from "./providers.js";

const DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024;

interface DownloadTaskMetadata {
  providerModelId: string;
  artifactId: string;
  fileName: string;
  destinationPath: string;
  partialPath: string;
  requestHeaders?: Record<string, string>;
  displayName?: string;
  remoteUrl?: string;
  supportsRange?: boolean;
  autoRegister?: boolean;
  bundleId?: string;
  bundlePrimaryArtifactId?: string;
  engineType?: string;
  registrationPath?: string;
}

export interface Stage3DownloadRecord {
  id: string;
  provider: ProviderId;
  providerModelId: string;
  artifactId: string;
  fileName: string;
  modelId?: string;
  status: DownloadTask["status"];
  progress: number;
  downloadedBytes: number;
  totalBytes?: number;
  checksumSha256?: string;
  errorMessage?: string;
  destinationPath: string;
  updatedAt: string;
}

export interface Stage3DownloadRequest {
  provider: ProviderId;
  providerModelId: string;
  artifactId: string;
  displayName?: string;
  autoRegister?: boolean;
  bundleId?: string;
  bundlePrimaryArtifactId?: string;
  engineType?: string;
  registrationPath?: string;
}

export interface LocalModelRegistrar {
  registerLocalModel(options: {
    filePath: string;
    displayName?: string;
    expectedChecksumSha256?: string;
    sourceKind?: "local" | "huggingface" | "modelscope" | "manual" | "unknown";
    remoteUrl?: string;
  }): Promise<{ artifact: { id: string; sizeBytes: number }; profile: { displayName: string } }>;
}

export interface LlamaCppDownloadManagerOptions {
  supportRoot: string;
  downloadsRepository: DownloadTasksRepository;
  modelRegistrars: Record<string, LocalModelRegistrar>;
  providerSearch: ProviderSearchService;
  emitEvent?: (event: GatewayEvent) => void;
  fetch?: typeof fetch;
  now?: () => string;
  traceIdFactory?: () => string;
  chunkBytes?: number;
}

function sanitizePathPart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function toOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function toOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function sanitizeRelativeSegments(fileName: string): string[] {
  return fileName
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => sanitizePathPart(segment))
    .filter((segment) => segment.length > 0);
}

function ensureDirectory(directory: string): string {
  mkdirSync(directory, { recursive: true });
  return directory;
}

function buildDestinationPath(
  supportRoot: string,
  providerModelId: string,
  fileName: string,
): string {
  const modelDirectory = path.join(supportRoot, "models", sanitizePathPart(providerModelId));
  const segments = sanitizeRelativeSegments(fileName);
  return path.join(modelDirectory, ...(segments.length > 0 ? segments : ["artifact.bin"]));
}

function toTaskMetadata(task: DownloadTask): DownloadTaskMetadata {
  const metadata = task.metadata as Partial<DownloadTaskMetadata>;
  if (
    typeof metadata.providerModelId !== "string" ||
    typeof metadata.artifactId !== "string" ||
    typeof metadata.fileName !== "string" ||
    typeof metadata.destinationPath !== "string" ||
    typeof metadata.partialPath !== "string"
  ) {
    throw new Error(`Download task ${task.id} is missing required metadata.`);
  }

  const autoRegister = toOptionalBoolean(metadata.autoRegister);
  const bundleId = toOptionalString(metadata.bundleId);
  const bundlePrimaryArtifactId = toOptionalString(metadata.bundlePrimaryArtifactId);
  const engineType = toOptionalString(metadata.engineType);
  const registrationPath = toOptionalString(metadata.registrationPath);

  return {
    providerModelId: metadata.providerModelId,
    artifactId: metadata.artifactId,
    fileName: metadata.fileName,
    destinationPath: metadata.destinationPath,
    partialPath: metadata.partialPath,
    ...(metadata.requestHeaders &&
    typeof metadata.requestHeaders === "object" &&
    !Array.isArray(metadata.requestHeaders)
      ? {
          requestHeaders: Object.fromEntries(
            Object.entries(metadata.requestHeaders).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          ),
        }
      : {}),
    ...(typeof metadata.displayName === "string" ? { displayName: metadata.displayName } : {}),
    ...(typeof metadata.remoteUrl === "string" ? { remoteUrl: metadata.remoteUrl } : {}),
    ...(typeof metadata.supportsRange === "boolean"
      ? { supportsRange: metadata.supportsRange }
      : {}),
    ...(autoRegister !== undefined ? { autoRegister } : {}),
    ...(bundleId ? { bundleId } : {}),
    ...(bundlePrimaryArtifactId ? { bundlePrimaryArtifactId } : {}),
    ...(engineType ? { engineType } : {}),
    ...(registrationPath ? { registrationPath } : {}),
  };
}

function computeProgress(task: DownloadTask): number {
  if (!task.totalBytes || task.totalBytes <= 0) {
    return task.status === "completed" ? 100 : 0;
  }

  return Math.min(100, Math.round((task.downloadedBytes / task.totalBytes) * 100));
}

async function computeFileSha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const file = await import("node:fs").then((fs) => fs.createReadStream(filePath));
  return await new Promise<string>((resolve, reject) => {
    file.on("data", (chunk) => hash.update(chunk));
    file.on("end", () => resolve(hash.digest("hex")));
    file.on("error", reject);
  });
}

export class LlamaCppDownloadManager {
  readonly #supportRoot: string;
  readonly #downloadsRepository: DownloadTasksRepository;
  readonly #modelRegistrars: Map<string, LocalModelRegistrar>;
  readonly #providerSearch: ProviderSearchService;
  readonly #emitEvent: ((event: GatewayEvent) => void) | undefined;
  readonly #fetch: typeof fetch;
  readonly #now: () => string;
  readonly #traceIdFactory: () => string;
  readonly #chunkBytes: number;
  readonly #downloadsRoot: string;
  readonly #partialsRoot: string;
  readonly #activeControllers = new Map<string, AbortController>();
  readonly #activeRuns = new Map<string, Promise<Stage3DownloadRecord>>();

  constructor(options: LlamaCppDownloadManagerOptions) {
    this.#supportRoot = options.supportRoot;
    this.#downloadsRepository = options.downloadsRepository;
    this.#modelRegistrars = new Map(Object.entries(options.modelRegistrars));
    this.#providerSearch = options.providerSearch;
    this.#emitEvent = options.emitEvent;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#traceIdFactory = options.traceIdFactory ?? randomUUID;
    this.#chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
    this.#downloadsRoot = ensureDirectory(path.join(this.#supportRoot, "downloads"));
    this.#partialsRoot = ensureDirectory(path.join(this.#downloadsRoot, "partials"));
    ensureDirectory(path.join(this.#supportRoot, "models"));
  }

  async search(
    query: ProviderSearchQuery,
    providerIds?: ProviderId[],
  ): Promise<ProviderSearchResult> {
    return this.#providerSearch.search(query, providerIds);
  }

  async getCatalogModel(
    provider: ProviderId,
    providerModelId: string,
  ): Promise<ProviderModelSummary> {
    return await this.#providerSearch.getModel(provider, providerModelId);
  }

  listDownloads(): Stage3DownloadRecord[] {
    return this.#downloadsRepository.list().map((task) => this.toRecord(task));
  }

  async startDownload(request: Stage3DownloadRequest): Promise<Stage3DownloadRecord> {
    const provider = this.#providerSearch.getProvider(request.provider);
    const now = this.#now();
    const taskId = randomUUID();
    const plan = await provider.resolveDownload({
      provider: request.provider,
      providerModelId: request.providerModelId,
      artifactId: request.artifactId,
      destinationPath: path.join(
        this.#supportRoot,
        "models",
        sanitizePathPart(request.providerModelId),
      ),
    } satisfies ProviderDownloadRequest);
    const fileName = path.basename(plan.fileName);
    const partialPath = path.join(this.#partialsRoot, `${taskId}.part`);
    const destinationPath = buildDestinationPath(
      this.#supportRoot,
      request.providerModelId,
      plan.fileName,
    );

    const task: DownloadTask = {
      id: taskId,
      provider: request.provider,
      url: plan.url,
      totalBytes: plan.estimatedSizeBytes,
      downloadedBytes: 0,
      status: "pending",
      ...(plan.checksum?.algorithm === "sha256" ? { checksumSha256: plan.checksum.value } : {}),
      metadata: {
        providerModelId: request.providerModelId,
        artifactId: request.artifactId,
        fileName,
        destinationPath,
        partialPath,
        ...(Object.keys(plan.headers).length > 0 ? { requestHeaders: plan.headers } : {}),
        ...(request.displayName ? { displayName: request.displayName } : {}),
        remoteUrl: plan.url,
        supportsRange: plan.supportsRange,
        ...(request.autoRegister !== undefined ? { autoRegister: request.autoRegister } : {}),
        ...(request.bundleId ? { bundleId: request.bundleId } : {}),
        ...(request.bundlePrimaryArtifactId
          ? { bundlePrimaryArtifactId: request.bundlePrimaryArtifactId }
          : {}),
        ...(request.engineType ? { engineType: request.engineType } : {}),
        ...(request.registrationPath ? { registrationPath: request.registrationPath } : {}),
      },
      createdAt: now,
      updatedAt: now,
    };

    this.#downloadsRepository.upsert(task);
    this.publishProgress(task, "Queued download.");
    void this.resumeDownload(task.id);

    return this.toRecord(task);
  }

  async pauseDownload(taskId: string): Promise<Stage3DownloadRecord> {
    const task = this.#downloadsRepository.findById(taskId);
    if (!task) {
      throw new Error(`Unknown download task: ${taskId}`);
    }

    this.#activeControllers.get(taskId)?.abort("paused");
    const nextTask: DownloadTask = {
      ...task,
      status: "paused",
      updatedAt: this.#now(),
    };
    this.#downloadsRepository.upsert(nextTask);
    this.publishProgress(nextTask, "Download paused.");
    return this.toRecord(nextTask);
  }

  async resumeDownload(taskId: string): Promise<Stage3DownloadRecord> {
    const running = this.#activeRuns.get(taskId);
    const currentTask = this.#downloadsRepository.findById(taskId);

    if (running && currentTask?.status !== "paused") {
      return running;
    }
    if (running) {
      await running.catch(() => undefined);
    }

    const run = this.runDownload(taskId).finally(() => {
      this.#activeRuns.delete(taskId);
      this.#activeControllers.delete(taskId);
    });
    this.#activeRuns.set(taskId, run);
    return run;
  }

  private async runDownload(taskId: string): Promise<Stage3DownloadRecord> {
    const originalTask = this.#downloadsRepository.findById(taskId);
    if (!originalTask) {
      throw new Error(`Unknown download task: ${taskId}`);
    }

    const metadata = toTaskMetadata(originalTask);
    await mkdir(path.dirname(metadata.partialPath), { recursive: true });
    await mkdir(path.dirname(metadata.destinationPath), { recursive: true });

    const controller = new AbortController();
    this.#activeControllers.set(taskId, controller);

    let task: DownloadTask = {
      ...originalTask,
      status: "downloading",
      errorMessage: undefined,
      updatedAt: this.#now(),
    };
    this.#downloadsRepository.upsert(task);
    this.publishProgress(task, "Download started.");

    const supportsRange = metadata.supportsRange ?? false;
    const partialSize = existsSync(metadata.partialPath) ? statSync(metadata.partialPath).size : 0;

    try {
      if (partialSize > 0 && !supportsRange) {
        unlinkSync(metadata.partialPath);
      }

      let offset =
        existsSync(metadata.partialPath) && supportsRange ? statSync(metadata.partialPath).size : 0;
      if (offset > 0) {
        task = {
          ...task,
          downloadedBytes: offset,
          updatedAt: this.#now(),
        };
        this.#downloadsRepository.upsert(task);
        this.publishProgress(task, "Resuming partial download.");
      }

      const totalBytes = task.totalBytes;
      while (true) {
        if (controller.signal.aborted) {
          throw new Error("paused");
        }

        const rangeEnd =
          totalBytes !== undefined
            ? Math.min(totalBytes - 1, offset + this.#chunkBytes - 1)
            : undefined;
        const requestInit: RequestInit = {
          signal: controller.signal,
        };
        const requestHeaders = {
          ...(metadata.requestHeaders ?? {}),
        };
        if (supportsRange && (offset > 0 || rangeEnd !== undefined)) {
          requestHeaders.Range = `bytes=${offset}-${rangeEnd ?? ""}`;
        }
        if (Object.keys(requestHeaders).length > 0) {
          requestInit.headers = {
            ...requestHeaders,
          };
        }
        const response = await this.#fetch(task.url, {
          ...requestInit,
        });

        if (!(response.ok || response.status === 206)) {
          throw new Error(`Download failed with status ${response.status}.`);
        }

        const contentLengthHeader = response.headers.get("content-length");
        const contentLength =
          typeof contentLengthHeader === "string" ? Number(contentLengthHeader) : undefined;
        const nextTotal =
          task.totalBytes ??
          (typeof contentLength === "number" && Number.isFinite(contentLength)
            ? supportsRange && offset > 0
              ? offset + contentLength
              : contentLength
            : undefined);

        if (nextTotal !== undefined && nextTotal !== task.totalBytes) {
          task = {
            ...task,
            totalBytes: nextTotal,
            updatedAt: this.#now(),
          };
          this.#downloadsRepository.upsert(task);
        }

        if (!response.body) {
          throw new Error("Download response did not include a body.");
        }

        const output = createWriteStream(metadata.partialPath, {
          flags: offset > 0 && supportsRange ? "a" : "w",
        });
        const reader = response.body.getReader();
        let chunkBytes = 0;

        while (true) {
          if (controller.signal.aborted) {
            await reader.cancel();
            throw new Error("paused");
          }

          const next = await reader.read();
          if (next.done) {
            break;
          }

          const buffer = Buffer.from(next.value);
          chunkBytes += buffer.length;
          output.write(buffer);
          task = {
            ...task,
            downloadedBytes: offset + chunkBytes,
            status: "downloading",
            updatedAt: this.#now(),
          };
          this.#downloadsRepository.upsert(task);
          this.publishProgress(task);
        }

        output.end();
        await finished(output);
        offset = task.downloadedBytes;

        if (!supportsRange || task.totalBytes === undefined || offset >= task.totalBytes) {
          break;
        }
      }

      renameSync(metadata.partialPath, metadata.destinationPath);
      const checksumSha256 = await computeFileSha256(metadata.destinationPath);
      if (task.checksumSha256 && checksumSha256 !== task.checksumSha256) {
        await rm(metadata.destinationPath, { force: true });
        throw new Error("Downloaded file checksum did not match provider metadata.");
      }

      const completedTask: DownloadTask = {
        ...task,
        downloadedBytes: task.totalBytes ?? task.downloadedBytes,
        totalBytes: task.totalBytes ?? task.downloadedBytes,
        status: "completed",
        checksumSha256,
        updatedAt: this.#now(),
      };
      if (!metadata.bundleId && metadata.autoRegister !== false) {
        return await this.registerCompletedTask(completedTask, metadata);
      }

      this.#downloadsRepository.upsert(completedTask);

      if (metadata.bundleId) {
        const registered = await this.maybeRegisterBundle(metadata.bundleId);
        const latestTask = this.#downloadsRepository.findById(taskId) ?? completedTask;
        if (registered && registered.id === latestTask.id) {
          return registered;
        }

        this.publishProgress(
          latestTask,
          metadata.autoRegister === false
            ? "Download completed."
            : "Waiting for remaining bundle files.",
        );
        return this.toRecord(latestTask);
      }

      this.publishProgress(completedTask, "Download completed.");
      return this.toRecord(completedTask);
    } catch (error) {
      if ((error instanceof Error ? error.message : String(error)) === "paused") {
        const pausedTask: DownloadTask = {
          ...task,
          status: "paused",
          updatedAt: this.#now(),
        };
        this.#downloadsRepository.upsert(pausedTask);
        this.publishProgress(pausedTask, "Download paused.");
        return this.toRecord(pausedTask);
      }

      const failedTask: DownloadTask = {
        ...task,
        status: "error",
        errorMessage: error instanceof Error ? error.message : "Download failed.",
        updatedAt: this.#now(),
      };
      this.#downloadsRepository.upsert(failedTask);
      this.publishProgress(failedTask, failedTask.errorMessage);
      return this.toRecord(failedTask);
    }
  }

  private toRecord(task: DownloadTask): Stage3DownloadRecord {
    const metadata = toTaskMetadata(task);
    return {
      id: task.id,
      provider: task.provider as ProviderId,
      providerModelId: metadata.providerModelId,
      artifactId: metadata.artifactId,
      fileName: metadata.fileName,
      ...(task.modelId ? { modelId: task.modelId } : {}),
      status: task.status,
      progress: computeProgress(task),
      downloadedBytes: task.downloadedBytes,
      ...(task.totalBytes !== undefined ? { totalBytes: task.totalBytes } : {}),
      ...(task.checksumSha256 ? { checksumSha256: task.checksumSha256 } : {}),
      ...(task.errorMessage ? { errorMessage: task.errorMessage } : {}),
      destinationPath: metadata.destinationPath,
      updatedAt: task.updatedAt,
    };
  }

  private publishProgress(task: DownloadTask, message?: string): void {
    if (!this.#emitEvent) {
      return;
    }

    this.#emitEvent({
      type: "DOWNLOAD_PROGRESS",
      ts: this.#now(),
      traceId: this.#traceIdFactory(),
      payload: {
        taskId: task.id,
        ...(task.modelId ? { modelId: task.modelId } : {}),
        downloadedBytes: task.downloadedBytes,
        ...(task.totalBytes !== undefined ? { totalBytes: task.totalBytes } : {}),
        status: task.status,
        ...(message ? { message } : {}),
      },
    });
  }

  private async registerCompletedTask(
    task: DownloadTask,
    metadata: DownloadTaskMetadata,
  ): Promise<Stage3DownloadRecord> {
    const engineType = metadata.engineType ?? "llama.cpp";
    const registrar = this.#modelRegistrars.get(engineType);
    if (!registrar) {
      throw new Error(`No local model registrar is available for engine ${engineType}.`);
    }

    const registrationPath =
      metadata.registrationPath === undefined
        ? engineType === "mlx"
          ? path.dirname(metadata.destinationPath)
          : metadata.destinationPath
        : path.isAbsolute(metadata.registrationPath)
          ? metadata.registrationPath
          : path.join(
              this.#supportRoot,
              "models",
              sanitizePathPart(metadata.providerModelId),
              metadata.registrationPath,
            );
    const registered = await registrar.registerLocalModel({
      filePath: registrationPath,
      ...(metadata.displayName ? { displayName: metadata.displayName } : {}),
      ...(task.checksumSha256 ? { expectedChecksumSha256: task.checksumSha256 } : {}),
      sourceKind: task.provider,
      remoteUrl: metadata.remoteUrl ?? task.url,
    });

    const registeredTask: DownloadTask = {
      ...task,
      modelId: registered.artifact.id,
      downloadedBytes: registered.artifact.sizeBytes,
      totalBytes: registered.artifact.sizeBytes,
      updatedAt: this.#now(),
    };
    this.#downloadsRepository.upsert(registeredTask);
    this.publishProgress(registeredTask, `Indexed ${registered.profile.displayName}.`);
    return this.toRecord(registeredTask);
  }

  private async maybeRegisterBundle(bundleId: string): Promise<Stage3DownloadRecord | undefined> {
    const bundleTasks = this.#downloadsRepository.list().filter((task) => {
      const metadata = toTaskMetadata(task);
      return metadata.bundleId === bundleId;
    });
    if (bundleTasks.length === 0 || bundleTasks.some((task) => task.status !== "completed")) {
      return undefined;
    }

    const primaryArtifactId = bundleTasks
      .map((task) => toTaskMetadata(task).bundlePrimaryArtifactId)
      .find((value): value is string => typeof value === "string" && value.length > 0);
    const primaryTask =
      bundleTasks.find((task) => {
        const metadata = toTaskMetadata(task);
        return primaryArtifactId
          ? metadata.artifactId === primaryArtifactId
          : metadata.autoRegister;
      }) ?? bundleTasks[0];
    if (!primaryTask) {
      return undefined;
    }
    if (primaryTask.modelId) {
      return this.toRecord(primaryTask);
    }

    return await this.registerCompletedTask(primaryTask, toTaskMetadata(primaryTask));
  }
}
