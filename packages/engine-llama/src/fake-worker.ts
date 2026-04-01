import type { ResolveCommandInput, EngineAdapter } from "@localhub/engine-core";

import { launchLlamaCppSession, type LiveLlamaCppSession } from "./session.js";

export function buildFakeLlamaCppWorkerProgram(): string {
  return [
    'import { rmSync, writeFileSync } from "node:fs";',
    'const runtimeKey = process.env.LOCALHUB_RUNTIME_KEY ?? "unknown";',
    'const modelId = process.env.LOCALHUB_MODEL_ID ?? "unknown";',
    'const modelPath = process.env.LOCALHUB_MODEL_PATH ?? "";',
    'const healthFile = process.env.LOCALHUB_HEALTH_FILE ?? "";',
    'const startupDelayMs = Number(process.env.LOCALHUB_FAKE_STARTUP_DELAY_MS ?? "60");',
    "const startedAt = Date.now();",
    "let shutdownStarted = false;",
    "const keepAliveTimer = setInterval(() => {}, 60_000);",
    'const emit = (payload) => process.stdout.write(`${JSON.stringify(payload)}\\n`);',
    "const writeHealth = (state) => {",
    "  if (!healthFile) {",
    "    return;",
    "  }",
    "  writeFileSync(",
    "    healthFile,",
    "    `${JSON.stringify({",
    "      state,",
    "      runtimeKey,",
    "      modelId,",
    "      pid: process.pid,",
    "      uptimeMs: Date.now() - startedAt,",
    "      checkedAt: new Date().toISOString(),",
    "    })}\\n`,",
    '    "utf8",',
    "  );",
    "};",
    "const shutdown = (reason) => {",
    "  if (shutdownStarted) {",
    "    return;",
    "  }",
    "  shutdownStarted = true;",
    '  emit({ level: "info", phase: "shutdown", reason, runtimeKey });',
    "  clearInterval(keepAliveTimer);",
    "  if (healthFile) {",
    "    rmSync(healthFile, { force: true });",
    "  }",
    "  setTimeout(() => process.exit(0), 200).unref();",
    "  process.exit(0);",
    "};",
    'emit({ level: "info", phase: "boot", runtimeKey, modelId, modelPath });',
    'writeHealth("starting");',
    "setTimeout(() => {",
    '  writeHealth("ready");',
    "  emit({",
    '    level: "info",',
    '    phase: "ready",',
    "    runtimeKey,",
    "    modelId,",
    "    healthFile,",
    "  });",
    "}, startupDelayMs);",
    'process.on("SIGTERM", () => shutdown("sigterm"));',
    'process.on("SIGINT", () => shutdown("sigint"));',
    'process.on("uncaughtException", (error) => {',
    '  process.stderr.write(`${String(error?.stack ?? error)}\\n`);',
    "  process.exit(1);",
    "});",
  ].join("\n");
}

export type SpawnedLlamaCppHarness = LiveLlamaCppSession;

export async function createLlamaCppHarness(
  adapter: EngineAdapter,
  input: ResolveCommandInput,
): Promise<SpawnedLlamaCppHarness> {
  return launchLlamaCppSession(adapter, input);
}
