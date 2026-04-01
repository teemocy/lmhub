import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  activateEngineVersion,
  createEmptyEngineVersionRegistry,
  ensureEngineSupportPaths,
  getActiveEngineVersion,
  readEngineVersionRegistry,
  resolveEngineSupportPaths,
  runtimeKeyToString,
  type EngineAdapter,
  type EngineHealthCheck,
  type EngineInstallResult,
  type EngineProbeResult,
  type EngineVersionRecord,
  type ResolveCommandInput,
  type ResolvedCommand,
  upsertEngineVersionRecord,
  writeEngineVersionRegistry,
} from "@localhub/engine-core";
import type {
  CapabilitySet,
  ModelArtifact,
  ModelProfile,
} from "@localhub/shared-contracts/foundation-models";
import type { RuntimeKey } from "@localhub/shared-contracts/foundation-runtime";

import { buildFakeLlamaCppWorkerProgram, createLlamaCppHarness } from "./fake-worker.js";

export * from "./fixtures.js";
export * from "./gguf.js";
export * from "./model-manager.js";
export * from "./session.js";

const LLAMA_CPP_ENGINE_TYPE = "llama.cpp";
const LLAMA_CPP_BINARY_CANDIDATES = ["llama-server", "server"] as const;
const DEFAULT_FAKE_VERSION_TAG = "stage1-fixture";
const DEFAULT_FAKE_BASE_PORT = 46_000;
const PROMPT_CACHE_DIRNAME = "prompt-caches";

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
  const executableSuffixes =
    process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];

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

function buildBinaryArgs(
  input: ResolveCommandInput,
  host: string,
  port: number,
): string[] {
  const args = [
    "--model",
    input.artifact.localPath,
    "--host",
    host,
    "--port",
    String(port),
    "--ctx-size",
    String(getContextLength(input.artifact, input.profile)),
  ];

  const gpuLayers = getGpuLayers(input.profile);
  if (gpuLayers !== undefined) {
    args.push("--n-gpu-layers", String(gpuLayers));
  }

  if (input.runtimeKey.role === "embeddings") {
    args.push("--embedding");
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
    const installPath = path.join(paths.versionsRoot, sanitizeVersionTag(versionTag));
    const manifestPath = path.join(installPath, "manifest.json");
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
      versionTag,
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
          toVersionRecord(versionTag, installPath, binaryPath, managedBy, notes),
        ),
        versionTag,
      ),
    );

    return {
      success: true,
      versionTag,
      installPath,
      binaryPath,
      registryFile: paths.registryFile,
      activated: nextRegistry.activeVersionTag === versionTag,
      notes,
    };
  }

  async function ensureActiveVersion(
    input: ResolveCommandInput,
  ): Promise<{ versionTag: string; managedBy: "binary" | "fake-worker"; binaryPath: string }> {
    const { registry } = loadRegistry(input.supportRoot);
    const requestedVersion = input.versionTag ?? registry.activeVersionTag ?? DEFAULT_FAKE_VERSION_TAG;

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

      if (activeVersion && activeVersion.managedBy === "binary" && existsSync(activeVersion.binaryPath)) {
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
    async install(versionTag: string): Promise<EngineInstallResult> {
      return ensureInstalledVersion(versionTag);
    },
    async resolveCommand(input: ResolveCommandInput): Promise<ResolvedCommand> {
      const { paths } = loadRegistry(input.supportRoot);
      const host = input.host ?? options.defaultHost ?? "127.0.0.1";
      const port = input.port ?? derivePort(input.runtimeKey, options.fakeWorkerBasePort ?? DEFAULT_FAKE_BASE_PORT);
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
              ...(systemBinaryPath ? [`System binary candidate detected at ${systemBinaryPath}.`] : []),
            ],
          }
        : {
            command: process.execPath,
            args: ["--input-type=module", "--eval", buildFakeLlamaCppWorkerProgram()],
            cwd: runtimeDir,
            env: {
              LOCALHUB_FAKE_HOST: host,
              LOCALHUB_FAKE_PORT: String(port),
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

      if (plan.command.managedBy === "fake-worker" && plan.command.healthUrl.startsWith("file://")) {
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
              notes: [error instanceof Error ? error.message : "Failed to parse fake worker health file."],
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
