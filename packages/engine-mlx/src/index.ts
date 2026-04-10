import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
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
  ModelArtifact,
  ModelProfile,
} from "@localhub/shared-contracts/foundation-models";
import type { RuntimeKey } from "@localhub/shared-contracts/foundation-runtime";

import { buildFakeMlxWorkerProgram, derivePort } from "./runtime.js";
import {
  DEFAULT_MLX_LM_VERSION,
  DEFAULT_MLX_PYTHON_VERSION,
  DEFAULT_MLX_VERSION,
  buildMlxVersionTag,
} from "./versioning.js";

export * from "./model-manager.js";
export * from "./runtime.js";
export * from "./session.js";
export * from "./versioning.js";

const MLX_ENGINE_TYPE = "mlx";
const DEFAULT_VERSION_TAG = buildMlxVersionTag({
  pythonVersion: DEFAULT_MLX_PYTHON_VERSION,
  mlxVersion: DEFAULT_MLX_VERSION,
  mlxLmVersion: DEFAULT_MLX_LM_VERSION,
});
const DEFAULT_FAKE_BASE_PORT = 47_500;

const PYTHON_CANDIDATES = ["python3", "python"] as const;
const ABSOLUTE_PYTHON_CANDIDATES = [
  "/opt/homebrew/bin/python3",
  "/usr/local/bin/python3",
  "/usr/bin/python3",
] as const;

interface RuntimePlan {
  command: ResolvedCommand;
  versionTag: string;
}

export interface MlxAdapterOptions {
  supportRoot?: string;
  env?: NodeJS.ProcessEnv;
  preferFakeWorker?: boolean;
  fakeWorkerBasePort?: number;
  fakeWorkerStartupDelayMs?: number;
  defaultHost?: string;
  pythonExecutable?: string;
  pythonVersion?: string;
  mlxVersion?: string;
  mlxLmVersion?: string;
  pipIndexUrl?: string;
}

interface MlxInstallManifest {
  engineType: typeof MLX_ENGINE_TYPE;
  versionTag: string;
  installPath: string;
  executablePath: string;
  pythonVersion: string;
  mlxVersion: string;
  mlxLmVersion: string;
  managedBy: "python-venv" | "fake-worker";
  createdAt: string;
  notes: string[];
}

interface SpawnResult {
  stdout: string;
  stderr: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function sanitizeVersionTag(versionTag: string): string {
  return versionTag.replace(/[^A-Za-z0-9._-]+/g, "-");
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

function readInstallManifest(manifestPath: string): MlxInstallManifest | undefined {
  if (!existsSync(manifestPath)) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as Partial<MlxInstallManifest>;
    if (
      parsed.engineType !== MLX_ENGINE_TYPE ||
      typeof parsed.versionTag !== "string" ||
      typeof parsed.installPath !== "string" ||
      typeof parsed.executablePath !== "string" ||
      typeof parsed.pythonVersion !== "string" ||
      typeof parsed.mlxVersion !== "string" ||
      typeof parsed.mlxLmVersion !== "string" ||
      (parsed.managedBy !== "python-venv" && parsed.managedBy !== "fake-worker") ||
      !Array.isArray(parsed.notes)
    ) {
      return undefined;
    }

    return {
      engineType: MLX_ENGINE_TYPE,
      versionTag: parsed.versionTag,
      installPath: parsed.installPath,
      executablePath: parsed.executablePath,
      pythonVersion: parsed.pythonVersion,
      mlxVersion: parsed.mlxVersion,
      mlxLmVersion: parsed.mlxLmVersion,
      managedBy: parsed.managedBy,
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : nowIso(),
      notes: parsed.notes,
    };
  } catch {
    return undefined;
  }
}

function writeInstallManifest(manifestPath: string, manifest: MlxInstallManifest): void {
  mkdirSync(path.dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function writeRuntimePlan(runtimePlanPath: string, command: ResolvedCommand): void {
  writeFileSync(runtimePlanPath, `${JSON.stringify(command, null, 2)}\n`, "utf8");
}

function isMlxSupportedPlatform(): boolean {
  return process.platform === "darwin" && process.arch === "arm64";
}

function selectPythonExecutable(options: MlxAdapterOptions): string | undefined {
  const env = options.env ?? process.env;
  const explicit = options.pythonExecutable ?? env.LOCAL_LLM_HUB_MLX_PYTHON_EXECUTABLE;
  if (explicit && existsSync(explicit)) {
    return explicit;
  }

  const onPath = findExecutableOnPath(PYTHON_CANDIDATES, env);
  if (onPath) {
    return onPath;
  }

  return ABSOLUTE_PYTHON_CANDIDATES.find((candidate) => existsSync(candidate));
}

async function spawnAndCapture(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<SpawnResult> {
  await mkdir(cwd, { recursive: true });

  return await new Promise<SpawnResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(
        new Error(`Command failed (${command} ${args.join(" ")}).\n${stdout}${stderr}`.trim()),
      );
    });
  });
}

function toVersionRecord(manifest: MlxInstallManifest, notes: string[]): EngineVersionRecord {
  return {
    versionTag: manifest.versionTag,
    installPath: manifest.installPath,
    binaryPath: manifest.executablePath,
    source: "manual",
    channel: "stable",
    managedBy: manifest.managedBy === "fake-worker" ? "fake-worker" : "binary",
    installedAt: manifest.createdAt,
    notes,
  };
}

async function probeHttpWorker(baseUrl: string): Promise<Response> {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");

  return await fetch(`${normalizedBaseUrl}/v1/models`, {
    signal: AbortSignal.timeout(1_000),
  });
}

export function createMlxAdapter(options: MlxAdapterOptions = {}): EngineAdapter {
  const env = options.env ?? process.env;
  const runtimePlans = new Map<string, RuntimePlan>();

  function resolvePaths(supportRootOverride?: string) {
    const supportRoot = supportRootOverride ?? options.supportRoot ?? process.cwd();
    return ensureEngineSupportPaths(resolveEngineSupportPaths(supportRoot, MLX_ENGINE_TYPE));
  }

  function loadRegistry(supportRootOverride?: string) {
    const paths = resolvePaths(supportRootOverride);
    const registry = readEngineVersionRegistry(paths.registryFile, MLX_ENGINE_TYPE);
    return { paths, registry };
  }

  async function ensureInstalledVersion(
    requestedVersionTag: string,
    supportRootOverride?: string,
  ): Promise<EngineInstallResult> {
    const { paths, registry } = loadRegistry(supportRootOverride);
    const versionTag = sanitizeVersionTag(requestedVersionTag || DEFAULT_VERSION_TAG);
    const installPath = path.join(paths.versionsRoot, versionTag);
    const manifestPath = path.join(installPath, "manifest.json");
    const existingManifest = readInstallManifest(manifestPath);

    if (existingManifest && existsSync(existingManifest.executablePath)) {
      const nextRegistry = writeEngineVersionRegistry(
        paths.registryFile,
        activateEngineVersion(
          upsertEngineVersionRecord(
            registry.engineType ? registry : createEmptyEngineVersionRegistry(MLX_ENGINE_TYPE),
            toVersionRecord(existingManifest, existingManifest.notes),
          ),
          existingManifest.versionTag,
        ),
      );

      return {
        success: true,
        versionTag: existingManifest.versionTag,
        installPath: existingManifest.installPath,
        binaryPath: existingManifest.executablePath,
        registryFile: paths.registryFile,
        activated: nextRegistry.activeVersionTag === existingManifest.versionTag,
        notes: existingManifest.notes,
      };
    }

    const pythonVersion = options.pythonVersion ?? DEFAULT_MLX_PYTHON_VERSION;
    const mlxVersion = options.mlxVersion ?? DEFAULT_MLX_VERSION;
    const mlxLmVersion = options.mlxLmVersion ?? DEFAULT_MLX_LM_VERSION;

    mkdirSync(installPath, { recursive: true });

    if (options.preferFakeWorker) {
      const manifest: MlxInstallManifest = {
        engineType: MLX_ENGINE_TYPE,
        versionTag,
        installPath,
        executablePath: process.execPath,
        pythonVersion,
        mlxVersion,
        mlxLmVersion,
        managedBy: "fake-worker",
        createdAt: nowIso(),
        notes: [
          `Provisioned fake MLX runtime ${versionTag} for tests.`,
          `Using ${process.execPath} to host the fake MLX worker harness.`,
        ],
      };
      writeInstallManifest(manifestPath, manifest);

      const nextRegistry = writeEngineVersionRegistry(
        paths.registryFile,
        activateEngineVersion(
          upsertEngineVersionRecord(
            registry.engineType ? registry : createEmptyEngineVersionRegistry(MLX_ENGINE_TYPE),
            toVersionRecord(manifest, manifest.notes),
          ),
          versionTag,
        ),
      );

      return {
        success: true,
        versionTag,
        installPath,
        binaryPath: process.execPath,
        registryFile: paths.registryFile,
        activated: nextRegistry.activeVersionTag === versionTag,
        notes: manifest.notes,
      };
    }

    const pythonExecutable = selectPythonExecutable(options);
    if (!isMlxSupportedPlatform()) {
      throw new Error("MLX runtime installs are supported only on Apple Silicon macOS.");
    }

    if (!pythonExecutable) {
      throw new Error(
        "Unable to locate a Python 3 executable for the managed MLX runtime. Set LOCAL_LLM_HUB_MLX_PYTHON_EXECUTABLE to a bundled or system Python path.",
      );
    }

    const venvRoot = path.join(installPath, "venv");
    const venvPython = path.join(venvRoot, "bin", "python");

    await spawnAndCapture(pythonExecutable, ["-m", "venv", venvRoot], installPath, env);
    await spawnAndCapture(venvPython, ["-m", "ensurepip", "--upgrade"], installPath, env);
    await spawnAndCapture(
      venvPython,
      ["-m", "pip", "install", "--upgrade", "pip", "setuptools", "wheel"],
      installPath,
      env,
    );
    await spawnAndCapture(
      venvPython,
      [
        "-m",
        "pip",
        "install",
        ...(options.pipIndexUrl ? ["--index-url", options.pipIndexUrl] : []),
        `mlx==${mlxVersion}`,
        `mlx-lm==${mlxLmVersion}`,
      ],
      installPath,
      env,
    );

    const manifest: MlxInstallManifest = {
      engineType: MLX_ENGINE_TYPE,
      versionTag,
      installPath,
      executablePath: venvPython,
      pythonVersion,
      mlxVersion,
      mlxLmVersion,
      managedBy: "python-venv",
      createdAt: nowIso(),
      notes: [
        `Created a managed Python ${pythonVersion} virtual environment at ${venvRoot}.`,
        `Installed mlx==${mlxVersion} and mlx-lm==${mlxLmVersion}.`,
      ],
    };
    writeInstallManifest(manifestPath, manifest);

    const nextRegistry = writeEngineVersionRegistry(
      paths.registryFile,
      activateEngineVersion(
        upsertEngineVersionRecord(
          registry.engineType ? registry : createEmptyEngineVersionRegistry(MLX_ENGINE_TYPE),
          toVersionRecord(manifest, manifest.notes),
        ),
        versionTag,
      ),
    );

    return {
      success: true,
      versionTag,
      installPath,
      binaryPath: venvPython,
      registryFile: paths.registryFile,
      activated: nextRegistry.activeVersionTag === versionTag,
      notes: manifest.notes,
    };
  }

  async function ensureActiveVersion(input: ResolveCommandInput): Promise<{
    versionTag: string;
    binaryPath: string;
    managedBy: "binary" | "fake-worker";
  }> {
    if (options.preferFakeWorker) {
      return {
        versionTag: input.versionTag ?? DEFAULT_VERSION_TAG,
        binaryPath: process.execPath,
        managedBy: "fake-worker",
      };
    }

    const { registry } = loadRegistry(input.supportRoot);
    const requestedVersion = input.versionTag ?? registry.activeVersionTag ?? DEFAULT_VERSION_TAG;

    if (!registry.activeVersionTag || !getActiveEngineVersion(registry)) {
      const installResult = await ensureInstalledVersion(requestedVersion, input.supportRoot);
      return {
        versionTag: installResult.versionTag,
        binaryPath: installResult.binaryPath ?? process.execPath,
        managedBy: "binary",
      };
    }

    const activeVersion =
      registry.versions.find((candidate) => candidate.versionTag === requestedVersion) ??
      getActiveEngineVersion(registry);
    if (!activeVersion || !existsSync(activeVersion.binaryPath)) {
      const installResult = await ensureInstalledVersion(requestedVersion, input.supportRoot);
      return {
        versionTag: installResult.versionTag,
        binaryPath: installResult.binaryPath ?? process.execPath,
        managedBy: "binary",
      };
    }

    return {
      versionTag: activeVersion.versionTag,
      binaryPath: activeVersion.binaryPath,
      managedBy: activeVersion.managedBy,
    };
  }

  return {
    engineType: MLX_ENGINE_TYPE,
    async probe(): Promise<EngineProbeResult> {
      const { registry } = loadRegistry();
      const activeVersion = getActiveEngineVersion(registry);

      if (!isMlxSupportedPlatform()) {
        return {
          available: false,
          resolvedVia: "unavailable",
          registry,
          notes: ["MLX is supported only on Apple Silicon macOS."],
        };
      }

      if (activeVersion && existsSync(activeVersion.binaryPath)) {
        return {
          available: true,
          detectedVersion: activeVersion.versionTag,
          executablePath: activeVersion.binaryPath,
          resolvedVia: "registry",
          registry,
          notes: [...activeVersion.notes],
        };
      }

      if (options.preferFakeWorker) {
        return {
          available: true,
          detectedVersion: activeVersion?.versionTag ?? DEFAULT_VERSION_TAG,
          executablePath: process.execPath,
          resolvedVia: "fake-worker",
          registry,
          notes: ["Using the MLX fake worker harness for tests."],
        };
      }

      return {
        available: false,
        ...(activeVersion?.versionTag ? { detectedVersion: activeVersion.versionTag } : {}),
        resolvedVia: "unavailable",
        registry,
        notes: [
          "No managed MLX runtime is installed.",
          "Install an MLX runtime version before launching MLX-backed models.",
        ],
      };
    },
    async install(versionTag: string): Promise<EngineInstallResult> {
      return await ensureInstalledVersion(versionTag || DEFAULT_VERSION_TAG);
    },
    async activate(
      versionTag: string,
      supportRootOverride?: string,
    ): Promise<EngineActivationResult> {
      const { paths, registry } = loadRegistry(supportRootOverride);
      const existingVersion = registry.versions.find(
        (candidate) => candidate.versionTag === versionTag,
      );

      if (!existingVersion || !existsSync(existingVersion.binaryPath)) {
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
        notes: [`Activated installed MLX runtime ${versionTag}.`, ...existingVersion.notes],
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
      const activeVersion = await ensureActiveVersion(input);
      const modelArg = path.relative(runtimeDir, input.artifact.localPath) || ".";

      mkdirSync(runtimeDir, { recursive: true });

      const command: ResolvedCommand =
        activeVersion.managedBy === "fake-worker"
          ? {
              command: process.execPath,
              args: ["--input-type=module", "--eval", buildFakeMlxWorkerProgram()],
              cwd: runtimeDir,
              env: {
                LOCALHUB_RUNTIME_KEY: runtimeKeyString,
                LOCALHUB_MODEL_ID: input.artifact.id,
                LOCALHUB_MODEL_PATH: input.artifact.localPath,
                LOCALHUB_HEALTH_FILE: healthFile,
                LOCALHUB_FAKE_STARTUP_DELAY_MS: String(options.fakeWorkerStartupDelayMs ?? 125),
              },
              healthUrl: `file://${healthFile}`,
              managedBy: "fake-worker",
              runtimeDir,
              transport: "filesystem",
              versionTag: activeVersion.versionTag,
              notes: [
                "Using the MLX fake worker harness.",
                `The harness writes readiness state to ${healthFile}.`,
              ],
            }
          : {
              command: activeVersion.binaryPath,
              args: [
                "-m",
                "mlx_lm.server",
                "--model",
                modelArg,
                "--host",
                host,
                "--port",
                String(port),
              ],
              cwd: runtimeDir,
              env: {
                PYTHONUNBUFFERED: "1",
              },
              healthUrl: `http://${host}:${port}`,
              managedBy: "binary",
              runtimeDir,
              transport: "http",
              versionTag: activeVersion.versionTag,
              notes: [
                `Using managed MLX runtime ${activeVersion.versionTag}.`,
                `Resolved model path ${modelArg} relative to ${runtimeDir}.`,
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
      return {
        ...artifact.capabilities,
      };
    },
  };
}
