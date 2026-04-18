import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  type EngineActivationResult,
  type EngineAdapter,
  type EngineHealthCheck,
  type EngineInstallResult,
  type EngineProbeResult,
  type EngineVersionRecord,
  type ResolveCommandInput,
  type ResolvedCommand,
  activateEngineVersion,
  createEmptyEngineVersionRegistry,
  ensureEngineSupportPaths,
  getActiveEngineVersion,
  readEngineVersionRegistry,
  resolveEngineSupportPaths,
  runtimeKeyToString,
  upsertEngineVersionRecord,
  writeEngineVersionRegistry,
} from "@localhub/engine-core";
import type {
  CapabilitySet,
  FlashAttentionType,
  ModelArtifact,
  ModelProfile,
  PoolingMethod,
} from "@localhub/shared-contracts/foundation-models";
import type { RuntimeKey } from "@localhub/shared-contracts/foundation-runtime";

import {
  getInstalledPackagedLlamaCppBinary,
  restorePackagedLlamaCppBinary,
} from "./binary-installer.js";
import { buildFakeLlamaCppWorkerProgram, createLlamaCppHarness } from "./fake-worker.js";

export * from "./fixtures.js";
export * from "./download-manager.js";
export * from "./gguf.js";
export * from "./binary-installer.js";
export * from "./model-manager.js";
export * from "./providers.js";
export * from "./session.js";

const LLAMA_CPP_ENGINE_TYPE = "llama.cpp";
const LLAMA_CPP_BINARY_CANDIDATES = ["llama-server", "server"] as const;
const DEFAULT_FAKE_VERSION_TAG = "stage1-fixture";
const DEFAULT_FAKE_BASE_PORT = 46_000;
const DEFAULT_UBATCH_SIZE = 512;
const DEFAULT_BATCH_SIZE = 3_072;
const PROMPT_CACHE_DIRNAME = "prompt-caches";

function isPooledRuntimeRole(role: RuntimeKey["role"]): boolean {
  return role === "embeddings" || role === "rerank";
}

interface RuntimePlan {
  command: ResolvedCommand;
  versionTag: string;
}

export interface LlamaCppAdapterOptions {
  supportRoot?: string;
  env?: NodeJS.ProcessEnv;
  preferFakeWorker?: boolean;
  fakeWorkerBasePort?: number;
  fakeWorkerStartupDelayMs?: number;
  defaultHost?: string;
}

interface LlamaCppInstallManifest {
  engineType: typeof LLAMA_CPP_ENGINE_TYPE;
  versionTag: string;
  installPath: string;
  binaryPath: string;
  managedBy: "binary" | "fake-worker";
  createdAt: string;
  notes: string[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function sanitizeVersionTag(versionTag: string): string {
  return versionTag.replace(/[^A-Za-z0-9._-]+/g, "-");
}

function isFinitePositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function getContextLength(artifact: ModelArtifact, profile: ModelProfile): number {
  const overrideValue = profile.parameterOverrides.contextLength;
  if (isFinitePositiveNumber(overrideValue)) {
    return Math.floor(overrideValue);
  }

  if (isFinitePositiveNumber(artifact.metadata.contextLength)) {
    return artifact.metadata.contextLength;
  }

  return 4096;
}

function getGpuLayers(profile: ModelProfile): number | undefined {
  const overrideValue = profile.parameterOverrides.gpuLayers;
  if (isFinitePositiveNumber(overrideValue)) {
    return Math.floor(overrideValue);
  }

  return undefined;
}

function getBatchSize(profile: ModelProfile, role: RuntimeKey["role"]): number {
  const overrideValue = profile.parameterOverrides.batchSize;
  if (isFinitePositiveNumber(overrideValue)) {
    return Math.floor(overrideValue);
  }

  if (isPooledRuntimeRole(role)) {
    return getUBatchSize(profile);
  }

  return DEFAULT_BATCH_SIZE;
}

function getUBatchSize(profile: ModelProfile): number {
  const overrideValue = profile.parameterOverrides.ubatchSize;
  if (isFinitePositiveNumber(overrideValue)) {
    return Math.floor(overrideValue);
  }

  return DEFAULT_UBATCH_SIZE;
}

function getFlashAttentionType(profile: ModelProfile): FlashAttentionType {
  const overrideValue = profile.parameterOverrides.flashAttentionType;
  if (overrideValue === "enabled" || overrideValue === "disabled" || overrideValue === "auto") {
    return overrideValue;
  }

  return "auto";
}

function getPoolingMethod(
  profile: ModelProfile,
  role: RuntimeKey["role"],
): PoolingMethod | undefined {
  if (role === "rerank") {
    return "rank";
  }

  const overrideValue = profile.parameterOverrides.poolingMethod;
  if (
    overrideValue === "none" ||
    overrideValue === "mean" ||
    overrideValue === "cls" ||
    overrideValue === "last" ||
    overrideValue === "rank"
  ) {
    return overrideValue;
  }

  return undefined;
}

function getParallelSlots(profile: ModelProfile, role: RuntimeKey["role"]): number | undefined {
  if (role === "rerank") {
    return 1;
  }

  const overrideValue = profile.parameterOverrides.parallelSlots;
  if (isFinitePositiveNumber(overrideValue)) {
    return Math.floor(overrideValue);
  }

  return undefined;
}

function deriveCapabilities(artifact: ModelArtifact): CapabilitySet {
  return {
    ...artifact.capabilities,
  };
}

function splitPathEntries(rawPath: string | undefined): string[] {
  if (!rawPath) {
    return [];
  }

  return rawPath.split(path.delimiter).filter(Boolean);
}

function findExecutableOnPath(
  candidateNames: readonly string[],
  env: NodeJS.ProcessEnv,
): string | undefined {
  const pathEntries = splitPathEntries(env.PATH);
  const executableSuffixes = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];

  for (const entry of pathEntries) {
    for (const name of candidateNames) {
      for (const suffix of executableSuffixes) {
        const candidatePath = path.join(entry, `${name}${suffix}`);
        if (existsSync(candidatePath)) {
          return candidatePath;
        }
      }
    }
  }

  return undefined;
}

function hashPortSeed(value: string): number {
  let hash = 0;
  for (const character of value) {
    hash = (hash * 31 + character.charCodeAt(0)) % 10_000;
  }
  return hash;
}

function derivePort(runtimeKey: RuntimeKey, basePort: number): number {
  return basePort + (hashPortSeed(runtimeKeyToString(runtimeKey)) % 2_000);
}

function getMmprojPath(artifact: ModelArtifact): string | undefined {
  const mmprojPath = artifact.metadata.metadata.mmprojPath;
  return typeof mmprojPath === "string" && mmprojPath.length > 0 ? mmprojPath : undefined;
}

function hasMetadataKey(artifact: ModelArtifact, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(artifact.metadata.metadata, key);
}

function getRerankPoolingOverride(artifact: ModelArtifact): string | undefined {
  const architecture = artifact.metadata.architecture ?? artifact.architecture;
  if (!architecture) {
    return undefined;
  }

  if (
    hasMetadataKey(artifact, "general.pooling_type") ||
    hasMetadataKey(artifact, `${architecture}.pooling_type`)
  ) {
    return undefined;
  }

  return `${architecture}.pooling_type=int:4`;
}

function buildBinaryArgs(input: ResolveCommandInput, host: string, port: number): string[] {
  const args = [
    "--model",
    input.artifact.localPath,
    "--host",
    host,
    "--port",
    String(port),
    "--ctx-size",
    String(getContextLength(input.artifact, input.profile)),
    "--batch-size",
    String(getBatchSize(input.profile, input.runtimeKey.role)),
    "--ubatch-size",
    String(getUBatchSize(input.profile)),
  ];

  const gpuLayers = getGpuLayers(input.profile);
  if (gpuLayers !== undefined) {
    args.push("--n-gpu-layers", String(gpuLayers));
  }

  const parallelSlots = getParallelSlots(input.profile, input.runtimeKey.role);
  if (parallelSlots !== undefined) {
    args.push("--parallel", String(parallelSlots));
  }

  const flashAttentionType = getFlashAttentionType(input.profile);
  args.push(
    "--flash-attn",
    flashAttentionType === "enabled" ? "on" : flashAttentionType === "disabled" ? "off" : "auto",
  );

  if (input.runtimeKey.role === "embeddings") {
    args.push("--embedding");
  }

  if (input.runtimeKey.role === "rerank") {
    args.push("--rerank");

    const poolingOverride = getRerankPoolingOverride(input.artifact);
    if (poolingOverride) {
      args.push("--override-kv", poolingOverride);
    }
  }

  const poolingMethod = getPoolingMethod(input.profile, input.runtimeKey.role);
  if (poolingMethod) {
    args.push("--pooling", poolingMethod);
  }

  const mmprojPath = getMmprojPath(input.artifact);
  if (input.artifact.capabilities.vision && mmprojPath && existsSync(mmprojPath)) {
    args.push("--mmproj", mmprojPath);
  }

  if (input.profile.promptCacheKey) {
    args.push(
      "--prompt-cache",
      path.join(input.supportRoot, PROMPT_CACHE_DIRNAME, `${input.profile.promptCacheKey}.bin`),
    );
  }

  return args;
}

function toVersionRecord(
  versionTag: string,
  installPath: string,
  binaryPath: string,
  managedBy: "binary" | "fake-worker",
  notes: string[],
): EngineVersionRecord {
  return {
    versionTag,
    installPath,
    binaryPath,
    source: managedBy === "binary" ? "system-path" : "fixture",
    channel: "stable",
    managedBy,
    installedAt: nowIso(),
    notes,
  };
}

function writeManifest(manifestPath: string, manifest: LlamaCppInstallManifest): void {
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function writeRuntimePlan(runtimePlanPath: string, command: ResolvedCommand): void {
  writeFileSync(runtimePlanPath, `${JSON.stringify(command, null, 2)}\n`, "utf8");
}

async function probeHttpWorker(baseUrl: string): Promise<Response> {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
  const candidates = ["/health", "/healthz", "/"];

  for (const candidate of candidates) {
    try {
      const response = await fetch(`${normalizedBaseUrl}${candidate}`, {
        signal: AbortSignal.timeout(750),
      });

      if (response.ok || response.status === 503) {
        return response;
      }
    } catch {}
  }

  throw new Error(`Unable to reach llama.cpp worker at ${baseUrl}.`);
}

export function createLlamaCppAdapter(options: LlamaCppAdapterOptions = {}): EngineAdapter {
  const env = options.env ?? process.env;
  const runtimePlans = new Map<string, RuntimePlan>();

  function resolvePaths(supportRootOverride?: string) {
    const supportRoot = supportRootOverride ?? options.supportRoot ?? process.cwd();
    return ensureEngineSupportPaths(resolveEngineSupportPaths(supportRoot, LLAMA_CPP_ENGINE_TYPE));
  }

  function loadRegistry(supportRootOverride?: string) {
    const paths = resolvePaths(supportRootOverride);
    const registry = readEngineVersionRegistry(paths.registryFile, LLAMA_CPP_ENGINE_TYPE);
    return { paths, registry };
  }

  async function ensureInstalledVersion(
    versionTag: string,
    supportRootOverride?: string,
  ): Promise<EngineInstallResult> {
    const { paths, registry } = loadRegistry(supportRootOverride);
    const supportRoot = supportRootOverride ?? options.supportRoot ?? process.cwd();
    const sanitizedVersionTag = sanitizeVersionTag(versionTag);
    const installPath = path.join(paths.versionsRoot, sanitizedVersionTag);
    const manifestPath = path.join(installPath, "manifest.json");

    const installedBinary = await getInstalledPackagedLlamaCppBinary(
      paths.supportRoot,
      sanitizedVersionTag,
    );
    if (installedBinary) {
      return installedBinary;
    }

    const restoredBinary = await restorePackagedLlamaCppBinary({
      supportRoot,
      versionTag: sanitizedVersionTag,
      platform: process.platform,
      arch: process.arch,
    }).catch(() => undefined);
    if (restoredBinary) {
      return restoredBinary;
    }

    const registeredVersion = registry.versions.find(
      (candidate) => candidate.versionTag === sanitizedVersionTag,
    );
    if (registeredVersion) {
      throw new Error(
        `Registered llama.cpp version ${sanitizedVersionTag} is missing and could not be restored.`,
      );
    }

    const systemBinaryPath = findExecutableOnPath(LLAMA_CPP_BINARY_CANDIDATES, env);
    const useSystemBinary = Boolean(systemBinaryPath) && options.preferFakeWorker !== true;
    const managedBy = useSystemBinary ? "binary" : "fake-worker";
    const binaryPath = useSystemBinary ? (systemBinaryPath ?? process.execPath) : process.execPath;
    const notes = useSystemBinary
      ? [`Registered system llama.cpp binary at ${systemBinaryPath}.`]
      : systemBinaryPath
        ? [
            `Detected system llama.cpp binary at ${systemBinaryPath}, but fake worker mode is preferred.`,
            "Stage 1 will use the fake llama.cpp worker harness backed by Node.js.",
          ]
        : [
            "No llama.cpp binary was detected on PATH.",
            "Stage 1 will use the fake llama.cpp worker harness backed by Node.js.",
          ];

    mkdirSync(installPath, { recursive: true });
    writeManifest(manifestPath, {
      engineType: LLAMA_CPP_ENGINE_TYPE,
      versionTag: sanitizedVersionTag,
      installPath,
      binaryPath,
      managedBy,
      createdAt: nowIso(),
      notes,
    });

    const nextRegistry = writeEngineVersionRegistry(
      paths.registryFile,
      activateEngineVersion(
        upsertEngineVersionRecord(
          registry.engineType ? registry : createEmptyEngineVersionRegistry(LLAMA_CPP_ENGINE_TYPE),
          toVersionRecord(sanitizedVersionTag, installPath, binaryPath, managedBy, notes),
        ),
        sanitizedVersionTag,
      ),
    );

    return {
      success: true,
      versionTag: sanitizedVersionTag,
      installPath,
      binaryPath,
      registryFile: paths.registryFile,
      activated: nextRegistry.activeVersionTag === sanitizedVersionTag,
      notes,
    };
  }

  async function ensureActiveVersion(
    input: ResolveCommandInput,
  ): Promise<{ versionTag: string; managedBy: "binary" | "fake-worker"; binaryPath: string }> {
    const { registry } = loadRegistry(input.supportRoot);
    const requestedVersion =
      input.versionTag ?? registry.activeVersionTag ?? DEFAULT_FAKE_VERSION_TAG;

    if (!registry.activeVersionTag || !getActiveEngineVersion(registry)) {
      const installResult = await ensureInstalledVersion(requestedVersion, input.supportRoot);
      return {
        versionTag: installResult.versionTag,
        managedBy: installResult.binaryPath === process.execPath ? "fake-worker" : "binary",
        binaryPath: installResult.binaryPath ?? process.execPath,
      };
    }

    const activeVersion =
      registry.versions.find((candidate) => candidate.versionTag === requestedVersion) ??
      getActiveEngineVersion(registry);

    if (!activeVersion) {
      const installResult = await ensureInstalledVersion(requestedVersion, input.supportRoot);
      return {
        versionTag: installResult.versionTag,
        managedBy: installResult.binaryPath === process.execPath ? "fake-worker" : "binary",
        binaryPath: installResult.binaryPath ?? process.execPath,
      };
    }

    if (!existsSync(activeVersion.binaryPath)) {
      const installResult = await ensureInstalledVersion(
        activeVersion.versionTag,
        input.supportRoot,
      );
      return {
        versionTag: installResult.versionTag,
        managedBy: installResult.binaryPath === process.execPath ? "fake-worker" : "binary",
        binaryPath: installResult.binaryPath ?? process.execPath,
      };
    }

    return {
      versionTag: activeVersion.versionTag,
      managedBy: activeVersion.managedBy,
      binaryPath: activeVersion.binaryPath,
    };
  }

  return {
    engineType: LLAMA_CPP_ENGINE_TYPE,
    async probe(): Promise<EngineProbeResult> {
      const { registry } = loadRegistry();
      const activeVersion = getActiveEngineVersion(registry);
      const systemBinaryPath = findExecutableOnPath(LLAMA_CPP_BINARY_CANDIDATES, env);

      if (
        activeVersion &&
        activeVersion.managedBy === "binary" &&
        existsSync(activeVersion.binaryPath)
      ) {
        return {
          available: true,
          detectedVersion: activeVersion.versionTag,
          executablePath: activeVersion.binaryPath,
          resolvedVia: "registry",
          registry,
          notes: [...activeVersion.notes],
        };
      }

      if (systemBinaryPath) {
        return {
          available: true,
          detectedVersion: activeVersion?.versionTag ?? "system-path",
          executablePath: systemBinaryPath,
          resolvedVia: "system-path",
          registry,
          notes: ["A system llama.cpp binary was found on PATH."],
        };
      }

      if (activeVersion?.managedBy === "fake-worker") {
        return {
          available: true,
          detectedVersion: activeVersion.versionTag,
          executablePath: process.execPath,
          resolvedVia: "fake-worker",
          registry,
          notes: [...activeVersion.notes],
        };
      }

      if (options.preferFakeWorker !== false) {
        return {
          available: true,
          detectedVersion: activeVersion?.versionTag ?? DEFAULT_FAKE_VERSION_TAG,
          executablePath: process.execPath,
          resolvedVia: "fake-worker",
          registry,
          notes: [
            "Falling back to the Stage 1 fake llama.cpp worker harness.",
            "Run install() to materialize a registry entry and make the fallback explicit.",
          ],
        };
      }

      const unavailableResult: EngineProbeResult = {
        available: false,
        resolvedVia: "unavailable",
        registry,
        notes: ["No registered llama.cpp version or system binary could be resolved."],
      };

      if (activeVersion?.versionTag) {
        unavailableResult.detectedVersion = activeVersion.versionTag;
      }

      return unavailableResult;
    },
    async install(
      versionTag: string,
      _options?: {
        force?: boolean;
      },
    ): Promise<EngineInstallResult> {
      return ensureInstalledVersion(versionTag);
    },
    async activate(
      versionTag: string,
      supportRootOverride?: string,
    ): Promise<EngineActivationResult> {
      const { paths, registry } = loadRegistry(supportRootOverride);
      const existingVersion = registry.versions.find(
        (candidate) => candidate.versionTag === versionTag,
      );

      if (!existingVersion) {
        const installResult = await ensureInstalledVersion(versionTag, supportRootOverride);
        return {
          success: installResult.success,
          versionTag: installResult.versionTag,
          registryFile: installResult.registryFile,
          ...(installResult.binaryPath ? { binaryPath: installResult.binaryPath } : {}),
          notes: installResult.notes,
        };
      }

      if (!existsSync(existingVersion.binaryPath)) {
        const installResult = await ensureInstalledVersion(versionTag, supportRootOverride);
        return {
          success: installResult.success,
          versionTag: installResult.versionTag,
          registryFile: installResult.registryFile,
          ...(installResult.binaryPath ? { binaryPath: installResult.binaryPath } : {}),
          notes: installResult.notes,
        };
      }

      const nextRegistry = writeEngineVersionRegistry(
        paths.registryFile,
        activateEngineVersion(registry, versionTag),
      );

      return {
        success: nextRegistry.activeVersionTag === versionTag,
        versionTag,
        registryFile: paths.registryFile,
        binaryPath: existingVersion.binaryPath,
        notes: [`Activated installed llama.cpp version ${versionTag}.`, ...existingVersion.notes],
      };
    },
    async resolveCommand(input: ResolveCommandInput): Promise<ResolvedCommand> {
      const { paths } = loadRegistry(input.supportRoot);
      const host = input.host ?? options.defaultHost ?? "127.0.0.1";
      const port =
        input.port ??
        derivePort(input.runtimeKey, options.fakeWorkerBasePort ?? DEFAULT_FAKE_BASE_PORT);
      const runtimeKeyString = runtimeKeyToString(input.runtimeKey);
      const runtimeDir = path.join(paths.runtimeRoot, runtimeKeyString);
      const runtimePlanPath = path.join(runtimeDir, "launch-plan.json");
      const healthFile = path.join(runtimeDir, "health.json");
      const fakeWorkerHealthUrl = `file://${healthFile}`;
      const binaryHealthUrl = `http://${host}:${port}`;
      const activeVersion = await ensureActiveVersion(input);

      mkdirSync(runtimeDir, { recursive: true });

      const systemBinaryPath = findExecutableOnPath(LLAMA_CPP_BINARY_CANDIDATES, env);
      const shouldUseBinary =
        options.preferFakeWorker !== true &&
        activeVersion.managedBy === "binary" &&
        existsSync(activeVersion.binaryPath);

      const command: ResolvedCommand = shouldUseBinary
        ? {
            command: activeVersion.binaryPath,
            args: buildBinaryArgs(input, host, port),
            cwd: runtimeDir,
            env: {},
            healthUrl: binaryHealthUrl,
            managedBy: "binary",
            runtimeDir,
            transport: "http",
            versionTag: activeVersion.versionTag,
            notes: [
              `Using registered llama.cpp binary ${activeVersion.binaryPath}.`,
              ...(systemBinaryPath
                ? [`System binary candidate detected at ${systemBinaryPath}.`]
                : []),
            ],
          }
        : {
            command: process.execPath,
            args: ["--input-type=module", "--eval", buildFakeLlamaCppWorkerProgram()],
            cwd: runtimeDir,
            env: {
              LOCALHUB_RUNTIME_KEY: runtimeKeyString,
              LOCALHUB_MODEL_ID: input.artifact.id,
              LOCALHUB_MODEL_PATH: input.artifact.localPath,
              LOCALHUB_HEALTH_FILE: healthFile,
              LOCALHUB_FAKE_STARTUP_DELAY_MS: String(options.fakeWorkerStartupDelayMs ?? 60),
            },
            healthUrl: fakeWorkerHealthUrl,
            managedBy: "fake-worker",
            runtimeDir,
            transport: "filesystem",
            versionTag: activeVersion.versionTag,
            notes: [
              "Using the Stage 1 fake llama.cpp worker harness.",
              `The harness writes readiness state to ${healthFile}.`,
            ],
          };

      writeRuntimePlan(runtimePlanPath, command);
      runtimePlans.set(runtimeKeyString, {
        command,
        versionTag: activeVersion.versionTag,
      });

      return command;
    },
    async healthCheck(runtimeKey: RuntimeKey): Promise<EngineHealthCheck> {
      const runtimeKeyString = runtimeKeyToString(runtimeKey);
      const plan = runtimePlans.get(runtimeKeyString);

      if (!plan || !plan.command.healthUrl) {
        return {
          ok: false,
          snapshot: {
            state: "offline",
            checkedAt: nowIso(),
            notes: ["No resolved runtime plan exists for the requested runtime key."],
          },
          notes: ["Resolve the command before running health checks."],
        };
      }

      if (
        plan.command.managedBy === "fake-worker" &&
        plan.command.healthUrl.startsWith("file://")
      ) {
        const healthFilePath = plan.command.healthUrl.slice("file://".length);
        if (!existsSync(healthFilePath)) {
          return {
            ok: false,
            snapshot: {
              state: "offline",
              checkedAt: nowIso(),
              healthUrl: plan.command.healthUrl,
              notes: ["The fake worker has not written a readiness file yet."],
            },
          };
        }

        try {
          const parsed = JSON.parse(readFileSync(healthFilePath, "utf8")) as {
            state?: string;
            checkedAt?: string;
            pid?: number;
          };
          const isReady = parsed.state === "ready";
          return {
            ok: isReady,
            snapshot: {
              state: isReady ? "ready" : "starting",
              checkedAt: typeof parsed.checkedAt === "string" ? parsed.checkedAt : nowIso(),
              healthUrl: plan.command.healthUrl,
              ...(typeof parsed.pid === "number" ? { pid: parsed.pid } : {}),
              notes: [`Resolved via ${plan.command.managedBy}.`, `Version ${plan.versionTag}.`],
            },
          };
        } catch (error) {
          return {
            ok: false,
            snapshot: {
              state: "degraded",
              checkedAt: nowIso(),
              healthUrl: plan.command.healthUrl,
              notes: [
                error instanceof Error ? error.message : "Failed to parse fake worker health file.",
              ],
            },
          };
        }
      }

      try {
        const response = await probeHttpWorker(plan.command.healthUrl);

        if (response.ok) {
          return {
            ok: true,
            snapshot: {
              state: "ready",
              checkedAt: nowIso(),
              healthUrl: plan.command.healthUrl,
              statusCode: response.status,
              notes: [`Resolved via ${plan.command.managedBy}.`, `Version ${plan.versionTag}.`],
            },
          };
        }

        return {
          ok: false,
          snapshot: {
            state: response.status === 503 ? "starting" : "degraded",
            checkedAt: nowIso(),
            healthUrl: plan.command.healthUrl,
            statusCode: response.status,
            notes: [`Health endpoint returned HTTP ${response.status}.`],
          },
        };
      } catch (error) {
        return {
          ok: false,
          snapshot: {
            state: "offline",
            checkedAt: nowIso(),
            healthUrl: plan.command.healthUrl,
            notes: [error instanceof Error ? error.message : "Health probe failed."],
          },
        };
      }
    },
    normalizeResponse(payload: unknown): unknown {
      return payload;
    },
    capabilities(artifact: ModelArtifact, _profile: ModelProfile): CapabilitySet {
      return deriveCapabilities(artifact);
    },
  };
}

export function createLlamaCppAdapterPlaceholder(
  options: LlamaCppAdapterOptions = {},
): EngineAdapter {
  return createLlamaCppAdapter(options);
}

export { createLlamaCppHarness };
