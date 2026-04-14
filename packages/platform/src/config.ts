import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path, { dirname } from "node:path";

import {
  type DesktopConfigRecord,
  type GatewayConfigRecord,
  desktopConfigDefaults,
  desktopConfigRecordSchema,
  gatewayConfigDefaults,
  gatewayConfigRecordSchema,
} from "@localhub/shared-contracts/foundation-config";

import { type ResolveAppPathsOptions, resolveAppPaths } from "./app-paths.js";

export interface LoadedConfig<T> {
  value: T;
  filePath: string;
  sources: Array<"defaults" | "file" | "env">;
}

export interface LoadConfigOptions extends ResolveAppPathsOptions {
  env?: NodeJS.ProcessEnv;
  filePath?: string;
}

function readJsonFile<T extends object>(filePath: string): Partial<T> {
  if (!existsSync(filePath)) {
    return {};
  }

  const raw = readFileSync(filePath, "utf8");
  return JSON.parse(raw) as Partial<T>;
}

function pickBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  return value === "true" || value === "1";
}

function pickNumber(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeModelsDir(rawValue: string, baseDir: string): string {
  const trimmed = rawValue.trim();
  const expanded =
    trimmed === "~"
      ? os.homedir()
      : trimmed.startsWith("~/")
        ? path.join(os.homedir(), trimmed.slice(2))
        : trimmed;

  return path.isAbsolute(expanded) ? expanded : path.resolve(baseDir, expanded);
}

function setIfDefined<T extends object, K extends keyof T>(
  target: Partial<T>,
  key: K,
  value: T[K] | undefined,
): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

export function loadGatewayConfig(
  options: LoadConfigOptions = {},
): LoadedConfig<GatewayConfigRecord> {
  const env = options.env ?? process.env;
  const paths = resolveAppPaths(options);
  const filePath =
    options.filePath ?? env.LOCAL_LLM_HUB_GATEWAY_CONFIG_FILE ?? paths.gatewayConfigFile;
  const fileValues = readJsonFile<GatewayConfigRecord>(filePath);
  const envValues: Partial<GatewayConfigRecord> = {};
  setIfDefined(
    envValues,
    "environment",
    env.LOCAL_LLM_HUB_ENV as GatewayConfigRecord["environment"] | undefined,
  );
  setIfDefined(envValues, "publicHost", env.LOCAL_LLM_HUB_GATEWAY_PUBLIC_HOST);
  setIfDefined(envValues, "publicPort", pickNumber(env.LOCAL_LLM_HUB_GATEWAY_PUBLIC_PORT));
  setIfDefined(envValues, "controlHost", env.LOCAL_LLM_HUB_GATEWAY_CONTROL_HOST);
  setIfDefined(envValues, "controlPort", pickNumber(env.LOCAL_LLM_HUB_GATEWAY_CONTROL_PORT));
  setIfDefined(envValues, "enableLan", pickBoolean(env.LOCAL_LLM_HUB_ENABLE_LAN));
  setIfDefined(envValues, "authRequired", pickBoolean(env.LOCAL_LLM_HUB_AUTH_REQUIRED));
  setIfDefined(
    envValues,
    "logLevel",
    env.LOCAL_LLM_HUB_LOG_LEVEL as GatewayConfigRecord["logLevel"] | undefined,
  );
  setIfDefined(envValues, "defaultModelTtlMs", pickNumber(env.LOCAL_LLM_HUB_DEFAULT_MODEL_TTL_MS));
  setIfDefined(
    envValues,
    "maxActiveModelsInMemory",
    pickNumber(
      env.LOCAL_LLM_HUB_GATEWAY_MAX_ACTIVE_MODELS_IN_MEMORY ??
        env.LOCAL_LLM_HUB_MAX_ACTIVE_MODELS_IN_MEMORY,
    ),
  );
  setIfDefined(
    envValues,
    "requestTraceRetentionDays",
    pickNumber(env.LOCAL_LLM_HUB_REQUEST_TRACE_RETENTION_DAYS),
  );
  setIfDefined(envValues, "localModelsDir", env.LOCAL_LLM_HUB_MODELS_DIR);

  // Stage 2 freeze: shared config precedence is defaults < file < environment overrides.
  const merged = gatewayConfigRecordSchema.parse({
    ...gatewayConfigDefaults,
    ...fileValues,
    ...envValues,
  });
  const normalized = {
    ...merged,
    localModelsDir: normalizeModelsDir(merged.localModelsDir, paths.supportRoot),
  };

  const sources: LoadedConfig<GatewayConfigRecord>["sources"] = ["defaults"];

  if (existsSync(filePath)) {
    sources.push("file");
  }

  if (Object.values(envValues).some((value) => value !== undefined)) {
    sources.push("env");
  }

  return { value: normalized, filePath, sources };
}

export function loadDesktopConfig(
  options: LoadConfigOptions = {},
): LoadedConfig<DesktopConfigRecord> {
  const env = options.env ?? process.env;
  const paths = resolveAppPaths(options);
  const filePath =
    options.filePath ?? env.LOCAL_LLM_HUB_DESKTOP_CONFIG_FILE ?? paths.desktopConfigFile;
  const fileValues = readJsonFile<DesktopConfigRecord>(filePath);
  const envValues: Partial<DesktopConfigRecord> = {};
  setIfDefined(
    envValues,
    "environment",
    env.LOCAL_LLM_HUB_ENV as DesktopConfigRecord["environment"] | undefined,
  );
  setIfDefined(envValues, "closeToTray", pickBoolean(env.LOCAL_LLM_HUB_CLOSE_TO_TRAY));
  setIfDefined(envValues, "autoLaunchGateway", pickBoolean(env.LOCAL_LLM_HUB_AUTO_LAUNCH_GATEWAY));
  setIfDefined(
    envValues,
    "theme",
    env.LOCAL_LLM_HUB_THEME as DesktopConfigRecord["theme"] | undefined,
  );
  setIfDefined(envValues, "preferredWindowWidth", pickNumber(env.LOCAL_LLM_HUB_DESKTOP_WIDTH));
  setIfDefined(envValues, "preferredWindowHeight", pickNumber(env.LOCAL_LLM_HUB_DESKTOP_HEIGHT));
  setIfDefined(
    envValues,
    "logLevel",
    env.LOCAL_LLM_HUB_LOG_LEVEL as DesktopConfigRecord["logLevel"] | undefined,
  );

  // Stage 2 freeze: desktop config follows the same defaults < file < env merge order.
  const merged = desktopConfigRecordSchema.parse({
    ...desktopConfigDefaults,
    ...fileValues,
    ...envValues,
  });

  const sources: LoadedConfig<DesktopConfigRecord>["sources"] = ["defaults"];

  if (existsSync(filePath)) {
    sources.push("file");
  }

  if (Object.values(envValues).some((value) => value !== undefined)) {
    sources.push("env");
  }

  return { value: merged, filePath, sources };
}

export function writeConfigFile<T extends object>(filePath: string, value: T): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
