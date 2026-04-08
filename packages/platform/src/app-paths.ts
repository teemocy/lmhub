import { existsSync, mkdirSync, renameSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  LOCAL_ARTIFACT_LAYOUT_SPEC,
  type RuntimeEnvironment,
  runtimeEnvironmentSchema,
} from "@localhub/shared-contracts";

const APP_SUPPORT_SLUG = "lm-hub";
const APP_SUPPORT_NAME = "LM Hub";
const LEGACY_APP_SUPPORT_SLUG = "local-llm-hub";
const LEGACY_APP_SUPPORT_NAME = "Local LLM Hub";

export interface ResolveAppPathsOptions {
  cwd?: string;
  environment?: RuntimeEnvironment;
  homeDir?: string;
  supportRoot?: string;
  platform?: NodeJS.Platform;
}

export interface AppPaths {
  environment: RuntimeEnvironment;
  supportRoot: string;
  configDir: string;
  logsDir: string;
  runtimeDir: string;
  dataDir: string;
  downloadsDir: string;
  enginesDir: string;
  modelsDir: string;
  checksumsDir: string;
  promptCachesDir: string;
  promptCacheDir: string;
  tempDir: string;
  gatewayConfigFile: string;
  desktopConfigFile: string;
  discoveryFile: string;
  databaseFile: string;
}

function localSupportRoot(cwd: string, slug: string, environment: "development" | "test"): string {
  const environmentSlug = environment === "development" ? "dev" : "test";

  return path.join(cwd, ".local", slug, environmentSlug);
}

function packagedSupportRoot(
  platform: NodeJS.Platform,
  homeDir: string,
  appSupportName: string,
  appSupportSlug: string,
): string {
  if (platform === "darwin") {
    return path.join(homeDir, "Library", "Application Support", appSupportName);
  }

  if (platform === "win32") {
    return path.join(homeDir, "AppData", "Roaming", appSupportName);
  }

  return path.join(homeDir, ".config", appSupportSlug);
}

function migrateLegacySupportRoot(preferredRoot: string, legacyRoot: string): string {
  if (preferredRoot === legacyRoot) {
    return preferredRoot;
  }

  if (existsSync(preferredRoot) || !existsSync(legacyRoot)) {
    return preferredRoot;
  }

  mkdirSync(path.dirname(preferredRoot), { recursive: true });

  try {
    renameSync(legacyRoot, preferredRoot);
    return preferredRoot;
  } catch {
    return legacyRoot;
  }
}

export function resolveAppPaths(options: ResolveAppPathsOptions = {}): AppPaths {
  const environment = runtimeEnvironmentSchema.parse(
    options.environment ?? process.env.LOCAL_LLM_HUB_ENV ?? "development",
  );
  const platform = options.platform ?? process.platform;
  const cwd = options.cwd ?? process.cwd();
  const homeDir = options.homeDir ?? os.homedir();
  const preferredSupportRoot =
    environment === "development" || environment === "test"
      ? localSupportRoot(cwd, APP_SUPPORT_SLUG, environment)
      : packagedSupportRoot(platform, homeDir, APP_SUPPORT_NAME, APP_SUPPORT_SLUG);
  const legacySupportRoot =
    environment === "development" || environment === "test"
      ? localSupportRoot(cwd, LEGACY_APP_SUPPORT_SLUG, environment)
      : packagedSupportRoot(platform, homeDir, LEGACY_APP_SUPPORT_NAME, LEGACY_APP_SUPPORT_SLUG);

  const supportRoot =
    options.supportRoot ??
    process.env.LOCAL_LLM_HUB_APP_SUPPORT_DIR ??
    migrateLegacySupportRoot(preferredSupportRoot, legacySupportRoot);

  const configDir = path.join(supportRoot, "config");
  const logsDir = path.join(supportRoot, "logs");
  const runtimeDir = path.join(supportRoot, "runtime");
  const dataDir = path.join(supportRoot, "data");
  const downloadsDir = path.join(
    supportRoot,
    LOCAL_ARTIFACT_LAYOUT_SPEC.directories.downloads.relativePath,
  );
  const enginesDir = path.join(
    supportRoot,
    LOCAL_ARTIFACT_LAYOUT_SPEC.directories.engines.relativePath,
  );
  const modelsDir = path.join(
    supportRoot,
    LOCAL_ARTIFACT_LAYOUT_SPEC.directories.models.relativePath,
  );
  const checksumsDir = path.join(
    supportRoot,
    LOCAL_ARTIFACT_LAYOUT_SPEC.directories.checksums.relativePath,
  );
  const promptCachesDir = path.join(
    supportRoot,
    LOCAL_ARTIFACT_LAYOUT_SPEC.directories.promptCaches.relativePath,
  );
  const tempDir = path.join(supportRoot, LOCAL_ARTIFACT_LAYOUT_SPEC.directories.temp.relativePath);

  return {
    environment,
    supportRoot,
    configDir,
    logsDir,
    runtimeDir,
    dataDir,
    downloadsDir,
    enginesDir,
    modelsDir,
    checksumsDir,
    promptCachesDir,
    // Backward-compatible alias while downstream code migrates to the shared Stage 2 layout names.
    promptCacheDir: promptCachesDir,
    tempDir,
    gatewayConfigFile: path.join(configDir, "gateway.json"),
    desktopConfigFile: path.join(configDir, "desktop.json"),
    discoveryFile: path.join(runtimeDir, "gateway-discovery.json"),
    databaseFile: path.join(dataDir, "gateway.sqlite"),
  };
}

export function ensureAppPaths(paths: AppPaths): AppPaths {
  for (const directory of [
    paths.supportRoot,
    paths.configDir,
    paths.logsDir,
    paths.runtimeDir,
    paths.dataDir,
    paths.downloadsDir,
    paths.enginesDir,
    paths.modelsDir,
    paths.checksumsDir,
    paths.promptCachesDir,
    paths.promptCacheDir,
    paths.tempDir,
  ]) {
    mkdirSync(directory, { recursive: true });
  }

  return paths;
}
