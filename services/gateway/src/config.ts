import {
  type LoadConfigOptions,
  loadGatewayConfig as loadSharedGatewayConfig,
} from "@localhub/platform";

export interface GatewayConfig {
  defaultModelTtlMs: number;
  maxActiveModelsInMemory: number;
  publicHost: string;
  publicPort: number;
  controlHost: string;
  controlPort: number;
  localModelsDir: string;
  publicBearerToken: string | undefined;
  controlBearerToken: string | undefined;
  corsAllowlist: string[];
  telemetryIntervalMs: number;
}

function parseNumber(rawValue: string | undefined, fallback: number, label: string): number {
  if (!rawValue) {
    return fallback;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid numeric value for ${label}: ${rawValue}`);
  }

  return parsed;
}

function pickFirstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const normalized = value?.trim();
    if (normalized) {
      return normalized;
    }
  }

  return undefined;
}

export function loadGatewayConfig(options: LoadConfigOptions = {}): GatewayConfig {
  const loaded = loadSharedGatewayConfig(options);
  const env = options.env ?? process.env;

  const sharedToken = pickFirstNonEmpty(env.LOCAL_LLM_HUB_AUTH_TOKEN);
  const publicBearerToken = pickFirstNonEmpty(
    env.LOCAL_LLM_HUB_GATEWAY_PUBLIC_BEARER_TOKEN,
    env.GATEWAY_PUBLIC_BEARER_TOKEN,
    loaded.value.publicAuthToken,
    sharedToken,
  );
  const controlBearerToken = pickFirstNonEmpty(
    env.LOCAL_LLM_HUB_GATEWAY_CONTROL_BEARER_TOKEN,
    env.GATEWAY_CONTROL_BEARER_TOKEN,
    publicBearerToken,
    sharedToken,
  );

  if (loaded.value.authRequired && !publicBearerToken) {
    throw new Error(
      "LOCAL_LLM_HUB_AUTH_REQUIRED is enabled but no bearer token override was provided.",
    );
  }

  return {
    defaultModelTtlMs: loaded.value.defaultModelTtlMs,
    maxActiveModelsInMemory: loaded.value.maxActiveModelsInMemory,
    publicHost: loaded.value.publicHost,
    publicPort: loaded.value.publicPort,
    controlHost: loaded.value.controlHost,
    controlPort: loaded.value.controlPort,
    localModelsDir: loaded.value.localModelsDir,
    publicBearerToken,
    controlBearerToken,
    corsAllowlist: [...loaded.value.corsAllowlist],
    telemetryIntervalMs: parseNumber(
      pickFirstNonEmpty(
        env.LOCAL_LLM_HUB_GATEWAY_TELEMETRY_INTERVAL_MS,
        env.GATEWAY_TELEMETRY_INTERVAL_MS,
      ),
      5_000,
      "LOCAL_LLM_HUB_GATEWAY_TELEMETRY_INTERVAL_MS",
    ),
  };
}
