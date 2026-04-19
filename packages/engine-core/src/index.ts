import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { GatewayEvent } from "@localhub/shared-contracts";
import type {
  CapabilitySet,
  ModelArtifact,
  ModelProfile,
} from "@localhub/shared-contracts/foundation-models";
import type { RuntimeKey } from "@localhub/shared-contracts/foundation-runtime";

export interface EngineVersionRecord {
  versionTag: string;
  installPath: string;
  binaryPath: string;
  source: "release" | "system-path" | "fixture" | "manual";
  channel: "stable" | "nightly" | "custom";
  managedBy: "binary" | "fake-worker";
  installedAt: string;
  activatedAt?: string;
  notes: string[];
}

export interface EngineVersionRegistry {
  engineType: string;
  activeVersionTag?: string;
  versions: EngineVersionRecord[];
  updatedAt: string;
}

export interface EngineSupportPaths {
  supportRoot: string;
  engineRoot: string;
  versionsRoot: string;
  runtimeRoot: string;
  registryFile: string;
}

export interface EngineProbeResult {
  available: boolean;
  detectedVersion?: string;
  executablePath?: string;
  resolvedVia: "registry" | "system-path" | "fake-worker" | "unavailable";
  registry: EngineVersionRegistry;
  notes: string[];
}

export interface EngineInstallResult {
  success: boolean;
  versionTag: string;
  installPath?: string;
  binaryPath?: string;
  registryFile: string;
  activated: boolean;
  notes: string[];
}

export interface EngineActivationResult {
  success: boolean;
  versionTag: string;
  registryFile: string;
  binaryPath?: string;
  notes: string[];
}

export interface ResolveCommandInput {
  artifact: ModelArtifact;
  profile: ModelProfile;
  runtimeKey: RuntimeKey;
  supportRoot: string;
  host?: string;
  port?: number;
  versionTag?: string;
}

export interface ResolvedCommand {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  healthUrl?: string;
  managedBy: "binary" | "fake-worker";
  runtimeDir?: string;
  transport: "http" | "filesystem";
  versionTag?: string;
  notes?: string[];
}

export interface EngineHealthSnapshot {
  state: "offline" | "starting" | "ready" | "degraded";
  checkedAt: string;
  healthUrl?: string;
  statusCode?: number;
  pid?: number;
  notes?: string[];
}

export interface EngineHealthCheck {
  ok: boolean;
  snapshot?: EngineHealthSnapshot;
  events?: GatewayEvent[];
  notes?: string[];
}

export interface EngineAdapter {
  readonly engineType: string;
  probe(): Promise<EngineProbeResult>;
  install(versionTag: string, options?: { force?: boolean }): Promise<EngineInstallResult>;
  activate(versionTag: string, supportRoot?: string): Promise<EngineActivationResult>;
  resolveCommand(input: ResolveCommandInput): Promise<ResolvedCommand>;
  healthCheck(runtimeKey: RuntimeKey): Promise<EngineHealthCheck>;
  normalizeResponse(payload: unknown): unknown;
  capabilities(artifact: ModelArtifact, profile: ModelProfile): CapabilitySet;
}

export function runtimeKeyToString(runtimeKey: RuntimeKey): string {
  return [runtimeKey.modelId, runtimeKey.engineType, runtimeKey.role, runtimeKey.configHash]
    .map((part) => part.replace(/[^A-Za-z0-9._-]+/g, "-"))
    .join("__");
}

export function resolveEngineSupportPaths(
  supportRoot: string,
  engineType: string,
): EngineSupportPaths {
  const engineRoot = path.join(supportRoot, "engines", engineType);
  return {
    supportRoot,
    engineRoot,
    versionsRoot: path.join(engineRoot, "versions"),
    runtimeRoot: path.join(engineRoot, "runtime"),
    registryFile: path.join(engineRoot, "registry.json"),
  };
}

export function ensureEngineSupportPaths(paths: EngineSupportPaths): EngineSupportPaths {
  mkdirSync(paths.engineRoot, { recursive: true });
  mkdirSync(paths.versionsRoot, { recursive: true });
  mkdirSync(paths.runtimeRoot, { recursive: true });
  return paths;
}

export function createEmptyEngineVersionRegistry(engineType: string): EngineVersionRegistry {
  return {
    engineType,
    versions: [],
    updatedAt: new Date().toISOString(),
  };
}

export function readEngineVersionRegistry(
  registryFile: string,
  engineType: string,
): EngineVersionRegistry {
  if (!existsSync(registryFile)) {
    return createEmptyEngineVersionRegistry(engineType);
  }

  const parsed = JSON.parse(readFileSync(registryFile, "utf8")) as Partial<EngineVersionRegistry>;
  const registry: EngineVersionRegistry = {
    engineType: parsed.engineType ?? engineType,
    versions: Array.isArray(parsed.versions)
      ? parsed.versions.map((version) => ({
          ...version,
          notes: Array.isArray(version.notes) ? version.notes : [],
        }))
      : [],
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
  };

  if (typeof parsed.activeVersionTag === "string") {
    registry.activeVersionTag = parsed.activeVersionTag;
  }

  return registry;
}

export function writeEngineVersionRegistry(
  registryFile: string,
  registry: EngineVersionRegistry,
): EngineVersionRegistry {
  const nextRegistry = {
    ...registry,
    updatedAt: new Date().toISOString(),
  };
  mkdirSync(path.dirname(registryFile), { recursive: true });
  writeFileSync(registryFile, `${JSON.stringify(nextRegistry, null, 2)}\n`, "utf8");
  return nextRegistry;
}

export function upsertEngineVersionRecord(
  registry: EngineVersionRegistry,
  versionRecord: EngineVersionRecord,
): EngineVersionRegistry {
  const nextVersions = registry.versions.filter(
    (candidate) => candidate.versionTag !== versionRecord.versionTag,
  );
  nextVersions.push(versionRecord);
  nextVersions.sort((left, right) => left.versionTag.localeCompare(right.versionTag));

  return {
    ...registry,
    versions: nextVersions,
    activeVersionTag: registry.activeVersionTag ?? versionRecord.versionTag,
    updatedAt: new Date().toISOString(),
  };
}

export function activateEngineVersion(
  registry: EngineVersionRegistry,
  versionTag: string,
): EngineVersionRegistry {
  const nextVersions = registry.versions.map((version) =>
    version.versionTag === versionTag
      ? {
          ...version,
          activatedAt: new Date().toISOString(),
        }
      : version,
  );

  return {
    ...registry,
    activeVersionTag: versionTag,
    versions: nextVersions,
    updatedAt: new Date().toISOString(),
  };
}

export function getActiveEngineVersion(
  registry: EngineVersionRegistry,
): EngineVersionRecord | undefined {
  if (!registry.activeVersionTag) {
    return undefined;
  }

  return registry.versions.find((version) => version.versionTag === registry.activeVersionTag);
}

export function removeEngineVersion(
  registry: EngineVersionRegistry,
  versionTag: string,
): EngineVersionRegistry {
  const nextVersions = registry.versions.filter((version) => version.versionTag !== versionTag);
  const { activeVersionTag: _activeVersionTag, ...rest } = registry;
  const nextActiveVersionTag =
    registry.activeVersionTag === versionTag ? nextVersions[0]?.versionTag : registry.activeVersionTag;

  return {
    ...rest,
    ...(nextActiveVersionTag !== undefined ? { activeVersionTag: nextActiveVersionTag } : {}),
    versions: nextVersions,
    updatedAt: new Date().toISOString(),
  };
}
