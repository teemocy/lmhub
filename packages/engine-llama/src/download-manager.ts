import { createHash, randomUUID } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
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
  ProviderDownloadPlan,
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
  taskGroupId?: string;
  requestHeaders?: Record<string, string>;
  displayName?: string;
  remoteUrl?: string;
  supportsRange?: boolean;
  autoRegister?: boolean;
  bundleId?: string;
  bundlePrimaryArtifactId?: string;
  engineType?: string;
  registrationPath?: string;
  auxiliary?: boolean;
  auxiliaryKind?: string;
}

export interface Stage3DownloadFileRecord {
  id: string;
  artifactId: string;
  fileName: string;
  status: DownloadTask["status"];
  progress: number;
  downloadedBytes: number;
  totalBytes?: number;
  errorMessage?: string;
  destinationPath: string;
  updatedAt: string;
  auxiliary: boolean;
  auxiliaryKind?: string;
}

export interface Stage3DownloadRecord {
  id: string;
  provider: ProviderId;
  providerModelId: string;
  title: string;
  fileName: string;
  modelId?: string;
  status: DownloadTask["status"];
  progress: number;
  downloadedBytes: number;
  totalBytes?: number;
  fileCount: number;
  completedFileCount: number;
  errorFileCount: number;
  errorMessage?: string;
  destinationPath: string;
  updatedAt: string;
  files: Stage3DownloadFileRecord[];
}

export interface Stage3DownloadRequest {
  provider: ProviderId;
  providerModelId: string;
  artifactId: string;
  artifactName?: string;
  downloadUrl?: string;
  requestHeaders?: Record<string, string>;
  supportsRange?: boolean;
  checksumSha256?: string;
  sizeBytes?: number;
  taskGroupId?: string;
  displayName?: string;
  autoRegister?: boolean;
  bundleId?: string;
  bundlePrimaryArtifactId?: string;
  engineType?: string;
  registrationPath?: string;
  auxiliary?: boolean;
  auxiliaryKind?: string;
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
  localModelsDir?: string;
  downloadsRepository: DownloadTasksRepository;
  modelRegistrars?: Record<string, LocalModelRegistrar>;
  modelManager?: LocalModelRegistrar;
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

function isMlxSafetensorShard(fileName: string): boolean {
  return /\.safetensors(?:\.index\.json)?$/i.test(fileName);
}

function isMlxTokenizerCoreAsset(fileName: string): boolean {
  return /^tokenizer(?:\.|$)/i.test(fileName) || /\.tiktoken$/i.test(fileName);
}

function hasCompletedMlxTokenizerAssets(tasks: readonly DownloadTask[]): boolean {
  const completedNames = tasks
    .filter((task) => task.status === "completed")
    .map((task) => toTaskMetadata(task).fileName);

  return hasRequiredMlxTokenizerAssets(completedNames);
}

function hasCompletedMlxWeightShards(tasks: readonly DownloadTask[]): boolean {
  const shardTasks = tasks.filter((task) => isMlxSafetensorShard(toTaskMetadata(task).fileName));
  return shardTasks.length > 0 && shardTasks.every((task) => task.status === "completed");
}

function hasRequiredMlxTokenizerAssets(fileNames: Iterable<string>): boolean {
  let hasTokenizerCoreAsset = false;
  let hasVocabJson = false;
  let hasMergesTxt = false;

  for (const fileName of fileNames) {
    if (isMlxTokenizerCoreAsset(fileName)) {
      hasTokenizerCoreAsset = true;
    }
    if (/^vocab\.json$/i.test(fileName)) {
      hasVocabJson = true;
    }
    if (/^merges\.txt$/i.test(fileName)) {
      hasMergesTxt = true;
    }
  }

  return hasTokenizerCoreAsset || (hasVocabJson && hasMergesTxt);
}

function isRepairableMlxBundleDirectory(directory: string): boolean {
  let fileNames: string[];
  try {
    fileNames = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch {
    return false;
  }

  return (
    fileNames.some((fileName) => isMlxSafetensorShard(fileName)) &&
    hasRequiredMlxTokenizerAssets(fileNames)
  );
}

function buildDestinationPath(
  localModelsDir: string,
  providerModelId: string,
  fileName: string,
): string {
  const modelDirectory = path.join(localModelsDir, sanitizePathPart(providerModelId));
  const segments = sanitizeRelativeSegments(fileName);
  return path.join(modelDirectory, ...(segments.length > 0 ? segments : ["artifact.bin"]));
}

function resolveRegistrationPath(localModelsDir: string, metadata: DownloadTaskMetadata): string {
  const engineType = metadata.engineType ?? "llama.cpp";
  if (metadata.registrationPath === undefined) {
    return engineType === "mlx" ? path.dirname(metadata.destinationPath) : metadata.destinationPath;
  }

  return path.isAbsolute(metadata.registrationPath)
    ? metadata.registrationPath
    : path.join(
        localModelsDir,
        sanitizePathPart(metadata.providerModelId),
        metadata.registrationPath,
      );
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
  const taskGroupId = toOptionalString(metadata.taskGroupId);
  const auxiliaryKind = toOptionalString(metadata.auxiliaryKind);

  return {
    providerModelId: metadata.providerModelId,
    artifactId: metadata.artifactId,
    fileName: metadata.fileName,
    destinationPath: metadata.destinationPath,
    partialPath: metadata.partialPath,
    ...(taskGroupId ? { taskGroupId } : {}),
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
    ...(typeof metadata.auxiliary === "boolean" ? { auxiliary: metadata.auxiliary } : {}),
    ...(auxiliaryKind ? { auxiliaryKind } : {}),
  };
}

function computeProgress(task: DownloadTask): number {
  if (!task.totalBytes || task.totalBytes <= 0) {
    return task.status === "completed" ? 100 : 0;
  }

  return Math.min(100, Math.round((task.downloadedBytes / task.totalBytes) * 100));
}

function getTaskGroupId(task: DownloadTask): string {
  const metadata = toTaskMetadata(task);
  return metadata.taskGroupId ?? metadata.bundleId ?? task.id;
}

function computeAggregateProgress(tasks: readonly DownloadTask[]): number {
  if (tasks.length === 0) {
    return 0;
  }

  const totalBytes = tasks.reduce((total, task) => total + (task.totalBytes ?? 0), 0);
  if (totalBytes > 0 && tasks.every((task) => task.totalBytes !== undefined)) {
    const downloadedBytes = tasks.reduce((total, task) => total + task.downloadedBytes, 0);
    return Math.min(100, Math.round((downloadedBytes / totalBytes) * 100));
  }

  const completedFiles = tasks.filter((task) => task.status === "completed").length;
  return Math.min(100, Math.round((completedFiles / tasks.length) * 100));
}

function computeAggregateStatus(tasks: readonly DownloadTask[]): DownloadTask["status"] {
  if (tasks.some((task) => task.status === "error")) {
    return "error";
  }
  if (tasks.some((task) => task.status === "downloading")) {
    return "downloading";
  }
  if (tasks.some((task) => task.status === "pending")) {
    return "pending";
  }
  if (tasks.some((task) => task.status === "paused")) {
    return "paused";
  }

  return "completed";
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

function isDirectoryEmpty(directory: string): boolean {
  try {
    return readdirSync(directory).length === 0;
  } catch {
    return false;
  }
}

function trimEmptyParentDirectories(directory: string, stopAt: string): void {
  let current = directory;
  const resolvedStopAt = path.resolve(stopAt);
  while (
    path.resolve(current).startsWith(resolvedStopAt) &&
    path.resolve(current) !== resolvedStopAt
  ) {
    if (!isDirectoryEmpty(current)) {
      break;
    }

    try {
      rmSync(current, { recursive: false, force: true });
    } catch {
      break;
    }

    current = path.dirname(current);
  }
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
  readonly #localModelsDir: string;
  readonly #partialsRoot: string;
  readonly #activeControllers = new Map<string, AbortController>();
  readonly #activeRuns = new Map<string, Promise<Stage3DownloadRecord>>();
  readonly #deletedTaskIds = new Set<string>();

  constructor(options: LlamaCppDownloadManagerOptions) {
    this.#supportRoot = options.supportRoot;
    this.#downloadsRepository = options.downloadsRepository;
    const modelRegistrars =
      options.modelRegistrars ??
      (options.modelManager ? { "llama.cpp": options.modelManager } : undefined);
    if (!modelRegistrars) {
      throw new Error("At least one local model registrar must be configured.");
    }
    this.#modelRegistrars = new Map(Object.entries(modelRegistrars));
    this.#providerSearch = options.providerSearch;
    this.#emitEvent = options.emitEvent;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#traceIdFactory = options.traceIdFactory ?? randomUUID;
    this.#chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
    this.#localModelsDir = options.localModelsDir ?? path.join(this.#supportRoot, "models");
    this.#downloadsRoot = ensureDirectory(path.join(this.#supportRoot, "downloads"));
    this.#partialsRoot = ensureDirectory(path.join(this.#downloadsRoot, "partials"));
    ensureDirectory(this.#localModelsDir);
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
    this.repairStaleMlxBundleTaskErrors();
    const tasks = this.#downloadsRepository.list();
    const grouped = new Map<string, DownloadTask[]>();
    for (const task of tasks) {
      const groupId = getTaskGroupId(task);
      const current = grouped.get(groupId) ?? [];
      current.push(task);
      grouped.set(groupId, current);
    }

    return [...grouped.values()]
      .map((groupTasks) => this.toRecord(groupTasks))
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  }

  async startDownload(request: Stage3DownloadRequest): Promise<Stage3DownloadRecord> {
    const now = this.#now();
    const taskId = randomUUID();
    const plan: ProviderDownloadPlan =
      request.downloadUrl && request.artifactName
        ? {
            provider: request.provider,
            artifactId: request.artifactId,
            url: request.downloadUrl,
            headers: request.requestHeaders ?? {},
            fileName: request.artifactName,
            supportsRange: request.supportsRange ?? false,
            ...(request.sizeBytes !== undefined ? { estimatedSizeBytes: request.sizeBytes } : {}),
          }
        : await this.#providerSearch.getProvider(request.provider).resolveDownload({
            provider: request.provider,
            providerModelId: request.providerModelId,
            artifactId: request.artifactId,
            destinationPath: path.join(
              this.#localModelsDir,
              sanitizePathPart(request.providerModelId),
            ),
          } satisfies ProviderDownloadRequest);
    const fileName = path.basename(plan.fileName);
    const partialPath = path.join(this.#partialsRoot, `${taskId}.part`);
    const destinationPath = buildDestinationPath(
      this.#localModelsDir,
      request.providerModelId,
      plan.fileName,
    );

    const task: DownloadTask = {
      id: taskId,
      provider: request.provider,
      url: plan.url,
      totalBytes: request.sizeBytes ?? plan.estimatedSizeBytes,
      downloadedBytes: 0,
      status: "pending",
      ...(request.checksumSha256
        ? { checksumSha256: request.checksumSha256 }
        : plan.checksum?.algorithm === "sha256"
          ? { checksumSha256: plan.checksum.value }
          : {}),
      metadata: {
        providerModelId: request.providerModelId,
        artifactId: request.artifactId,
        fileName,
        destinationPath,
        partialPath,
        ...(request.taskGroupId ? { taskGroupId: request.taskGroupId } : {}),
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
        ...(request.auxiliary !== undefined ? { auxiliary: request.auxiliary } : {}),
        ...(request.auxiliaryKind ? { auxiliaryKind: request.auxiliaryKind } : {}),
      },
      createdAt: now,
      updatedAt: now,
    };

    this.#downloadsRepository.upsert(task);
    this.publishProgress(task, "Queued download.");
    void this.resumeTask(task.id);

    return this.getGroupedRecordOrThrow(getTaskGroupId(task));
  }

  async pauseDownload(id: string): Promise<Stage3DownloadRecord> {
    const tasks = this.resolveGroupTasks(id);
    await Promise.all(
      tasks
        .filter((task) => task.status === "pending" || task.status === "downloading")
        .map((task) => this.pauseTask(task.id)),
    );
    return this.getGroupedRecordOrThrow(getTaskGroupId(tasks[0]!));
  }

  async resumeDownload(id: string): Promise<Stage3DownloadRecord> {
    const tasks = this.resolveGroupTasks(id);
    await Promise.all(
      tasks
        .filter((task) => task.status === "paused" || task.status === "pending")
        .map((task) => this.resumeTask(task.id).catch(() => undefined)),
    );
    return this.getGroupedRecordOrThrow(getTaskGroupId(tasks[0]!));
  }

  async deleteDownload(
    id: string,
    options: { deleteFiles?: boolean } = {},
  ): Promise<{ id: string }> {
    const tasks = this.resolveGroupTasks(id);
    for (const task of tasks) {
      this.#deletedTaskIds.add(task.id);
      this.#activeControllers.get(task.id)?.abort("deleted");
    }

    await Promise.all(tasks.map((task) => this.#activeRuns.get(task.id)?.catch(() => undefined)));

    const latestTasks = this.resolveGroupTasks(id);
    for (const task of latestTasks) {
      const metadata = toTaskMetadata(task);
      await rm(metadata.partialPath, { force: true }).catch(() => undefined);
      if (options.deleteFiles ?? false) {
        await rm(metadata.destinationPath, { recursive: true, force: true }).catch(() => undefined);
        trimEmptyParentDirectories(
          path.dirname(metadata.destinationPath),
          path.join(this.#localModelsDir, sanitizePathPart(metadata.providerModelId)),
        );
      }
    }

    this.#downloadsRepository.deleteMany(latestTasks.map((task) => task.id));
    for (const task of latestTasks) {
      this.#deletedTaskIds.delete(task.id);
    }

    return { id: getTaskGroupId(latestTasks[0]!) };
  }

  private async pauseTask(taskId: string): Promise<Stage3DownloadRecord> {
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
    return this.toRecord([nextTask]);
  }

  private async resumeTask(taskId: string): Promise<Stage3DownloadRecord> {
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
      this.#deletedTaskIds.delete(taskId);
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
          throw new Error(String(controller.signal.reason ?? "paused"));
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
            throw new Error(String(controller.signal.reason ?? "paused"));
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
        if (registered && registered.id === getTaskGroupId(latestTask)) {
          return registered;
        }

        this.publishProgress(
          latestTask,
          metadata.autoRegister === false
            ? "Download completed."
            : "Waiting for remaining bundle files.",
        );
        return this.getGroupedRecordOrThrow(getTaskGroupId(latestTask));
      }

      this.publishProgress(completedTask, "Download completed.");
      return this.getGroupedRecordOrThrow(getTaskGroupId(completedTask));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Download failed.";
      if (message === "deleted" || this.#deletedTaskIds.has(taskId)) {
        return this.toRecord([task]);
      }

      const pausedByUser =
        message === "paused" ||
        (controller.signal.aborted && String(controller.signal.reason ?? "") === "paused");

      if (pausedByUser) {
        const pausedTask: DownloadTask = {
          ...task,
          status: "paused",
          updatedAt: this.#now(),
        };
        this.#downloadsRepository.upsert(pausedTask);
        this.publishProgress(pausedTask, "Download paused.");
        return this.getGroupedRecordOrThrow(getTaskGroupId(pausedTask));
      }

      const failedTask: DownloadTask = {
        ...task,
        status: "error",
        errorMessage: message,
        updatedAt: this.#now(),
      };
      this.#downloadsRepository.upsert(failedTask);
      this.publishProgress(failedTask, failedTask.errorMessage);
      return this.getGroupedRecordOrThrow(getTaskGroupId(failedTask));
    }
  }

  private resolveGroupTasks(id: string): DownloadTask[] {
    const tasks = this.#downloadsRepository.list().filter((task) => {
      const groupId = getTaskGroupId(task);
      return task.id === id || groupId === id;
    });

    if (tasks.length === 0) {
      throw new Error(`Unknown download task: ${id}`);
    }

    return tasks;
  }

  private getGroupedRecordOrThrow(id: string): Stage3DownloadRecord {
    return this.toRecord(this.resolveGroupTasks(id));
  }

  private pickPrimaryTask(tasks: readonly DownloadTask[]): DownloadTask {
    const primaryArtifactId = tasks
      .map((task) => toTaskMetadata(task).bundlePrimaryArtifactId)
      .find((value): value is string => typeof value === "string" && value.length > 0);

    return (
      tasks.find((task) => {
        const metadata = toTaskMetadata(task);
        return primaryArtifactId
          ? metadata.artifactId === primaryArtifactId
          : metadata.autoRegister;
      }) ??
      tasks.find((task) => toTaskMetadata(task).autoRegister) ??
      tasks.find((task) => !toTaskMetadata(task).auxiliary) ??
      tasks[0]!
    );
  }

  private toFileRecord(task: DownloadTask): Stage3DownloadFileRecord {
    const metadata = toTaskMetadata(task);
    return {
      id: task.id,
      artifactId: metadata.artifactId,
      fileName: metadata.fileName,
      status: task.status,
      progress: computeProgress(task),
      downloadedBytes: task.downloadedBytes,
      ...(task.totalBytes !== undefined ? { totalBytes: task.totalBytes } : {}),
      ...(task.errorMessage ? { errorMessage: task.errorMessage } : {}),
      destinationPath: metadata.destinationPath,
      updatedAt: task.updatedAt,
      auxiliary: metadata.auxiliary ?? false,
      ...(metadata.auxiliaryKind ? { auxiliaryKind: metadata.auxiliaryKind } : {}),
    };
  }

  private toRecord(tasks: readonly DownloadTask[]): Stage3DownloadRecord {
    const primaryTask = this.pickPrimaryTask(tasks);
    const primaryMetadata = toTaskMetadata(primaryTask);
    const sortedTasks = [...tasks].sort((left, right) => {
      if (left.id === primaryTask.id) {
        return -1;
      }
      if (right.id === primaryTask.id) {
        return 1;
      }

      return toTaskMetadata(left).fileName.localeCompare(toTaskMetadata(right).fileName);
    });
    const totalBytes = sortedTasks.every((task) => task.totalBytes !== undefined)
      ? sortedTasks.reduce((total, task) => total + (task.totalBytes ?? 0), 0)
      : undefined;
    const downloadedBytes = sortedTasks.reduce((total, task) => total + task.downloadedBytes, 0);
    const modelId = sortedTasks.find((task) => task.modelId)?.modelId;
    const errorTask = [...sortedTasks]
      .filter((task) => task.errorMessage)
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
    const updatedAt = [...sortedTasks]
      .map((task) => task.updatedAt)
      .sort((left, right) => Date.parse(right) - Date.parse(left))[0]!;

    return {
      id: getTaskGroupId(primaryTask),
      provider: primaryTask.provider as ProviderId,
      providerModelId: primaryMetadata.providerModelId,
      title:
        primaryMetadata.displayName ??
        primaryMetadata.providerModelId.split("/").at(-1) ??
        primaryMetadata.providerModelId,
      fileName: primaryMetadata.fileName,
      ...(modelId ? { modelId } : {}),
      status: computeAggregateStatus(sortedTasks),
      progress: computeAggregateProgress(sortedTasks),
      downloadedBytes,
      ...(totalBytes !== undefined ? { totalBytes } : {}),
      fileCount: sortedTasks.length,
      completedFileCount: sortedTasks.filter((task) => task.status === "completed").length,
      errorFileCount: sortedTasks.filter((task) => task.status === "error").length,
      ...(errorTask?.errorMessage ? { errorMessage: errorTask.errorMessage } : {}),
      destinationPath: primaryMetadata.destinationPath,
      updatedAt,
      files: sortedTasks.map((task) => this.toFileRecord(task)),
    };
  }

  private repairStaleMlxBundleTaskErrors(): void {
    const tasks = this.#downloadsRepository.list();
    for (const task of tasks) {
      if (task.status !== "error") {
        continue;
      }

      const metadata = toTaskMetadata(task);
      if (metadata.engineType !== "mlx" || !metadata.bundleId) {
        continue;
      }
      if (!existsSync(metadata.destinationPath)) {
        continue;
      }

      const registrationPath = resolveRegistrationPath(this.#localModelsDir, metadata);
      if (!isRepairableMlxBundleDirectory(registrationPath)) {
        continue;
      }

      const fileSize = statSync(metadata.destinationPath).size;
      this.#downloadsRepository.upsert({
        ...task,
        status: "completed",
        errorMessage: undefined,
        downloadedBytes: fileSize,
        totalBytes: task.totalBytes ?? fileSize,
        updatedAt: this.#now(),
      });
    }
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

    const registrationPath = resolveRegistrationPath(this.#localModelsDir, metadata);
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
    return this.getGroupedRecordOrThrow(getTaskGroupId(registeredTask));
  }

  private async maybeRegisterBundle(bundleId: string): Promise<Stage3DownloadRecord | undefined> {
    const bundleTasks = this.#downloadsRepository.list().filter((task) => {
      const metadata = toTaskMetadata(task);
      return metadata.bundleId === bundleId;
    });
    if (bundleTasks.length === 0) {
      return undefined;
    }

    const engineType = bundleTasks
      .map((task) => toTaskMetadata(task).engineType)
      .find((value): value is string => typeof value === "string" && value.length > 0);
    const completedTasks = bundleTasks.filter((task) => task.status === "completed");

    if (engineType === "mlx") {
      if (
        !hasCompletedMlxWeightShards(bundleTasks) ||
        !hasCompletedMlxTokenizerAssets(bundleTasks) ||
        completedTasks.length === 0
      ) {
        return undefined;
      }
    } else if (bundleTasks.some((task) => task.status !== "completed")) {
      return undefined;
    }

    const primaryArtifactId = bundleTasks
      .map((task) => toTaskMetadata(task).bundlePrimaryArtifactId)
      .find((value): value is string => typeof value === "string" && value.length > 0);
    const primaryTask =
      completedTasks.find((task) => {
        const metadata = toTaskMetadata(task);
        return primaryArtifactId
          ? metadata.artifactId === primaryArtifactId
          : metadata.autoRegister;
      }) ??
      completedTasks.find((task) => toTaskMetadata(task).autoRegister) ??
      completedTasks[0];
    if (!primaryTask) {
      return undefined;
    }
    if (primaryTask.modelId) {
      return this.getGroupedRecordOrThrow(getTaskGroupId(primaryTask));
    }

    return await this.registerCompletedTask(primaryTask, toTaskMetadata(primaryTask));
  }
}
