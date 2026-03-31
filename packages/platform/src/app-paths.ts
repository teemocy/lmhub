import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  type RuntimeEnvironment,
  runtimeEnvironmentSchema,
} from "@localhub/shared-contracts/foundation-common";

const APP_SUPPORT_SLUG = "local-llm-hub";
const APP_SUPPORT_NAME = "Local LLM Hub";

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
  promptCacheDir: string;
  gatewayConfigFile: string;
  desktopConfigFile: string;
  discoveryFile: string;
  databaseFile: string;
}

function defaultPackagedSupportRoot(platform: NodeJS.Platform, homeDir: string): string {
  if (platform === "darwin") {
    return path.join(homeDir, "Library", "Application Support", APP_SUPPORT_NAME);
  }

  if (platform === "win32") {
    return path.join(homeDir, "AppData", "Roaming", APP_SUPPORT_NAME);
  }

  return path.join(homeDir, ".config", APP_SUPPORT_SLUG);
}

export function resolveAppPaths(options: ResolveAppPathsOptions = {}): AppPaths {
  const environment = runtimeEnvironmentSchema.parse(
    options.environment ?? process.env.LOCAL_LLM_HUB_ENV ?? "development",
  );
  const platform = options.platform ?? process.platform;
  const cwd = options.cwd ?? process.cwd();
  const homeDir = options.homeDir ?? os.homedir();

  const supportRoot =
    options.supportRoot ??
    process.env.LOCAL_LLM_HUB_APP_SUPPORT_DIR ??
    (environment === "development"
      ? path.join(cwd, ".local", APP_SUPPORT_SLUG, "dev")
      : environment === "test"
        ? path.join(cwd, ".local", APP_SUPPORT_SLUG, "test")
        : defaultPackagedSupportRoot(platform, homeDir));

  const configDir = path.join(supportRoot, "config");
  const logsDir = path.join(supportRoot, "logs");
  const runtimeDir = path.join(supportRoot, "runtime");
  const dataDir = path.join(supportRoot, "data");
  const downloadsDir = path.join(supportRoot, "downloads");
  const enginesDir = path.join(supportRoot, "engines");
  const modelsDir = path.join(supportRoot, "models");
  const promptCacheDir = path.join(supportRoot, "prompt-cache");

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
    promptCacheDir,
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
    paths.promptCacheDir,
  ]) {
    mkdirSync(directory, { recursive: true });
  }

  return paths;
}
