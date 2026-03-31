import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";

import type { EngineAdapter, EngineHealthCheck, ResolveCommandInput, ResolvedCommand } from "@localhub/engine-core";

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

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

export interface SpawnedLlamaCppHarness {
  readonly child: ChildProcessWithoutNullStreams;
  readonly command: ResolvedCommand;
  readonly stdout: string[];
  readonly stderr: string[];
  waitForReady: (timeoutMs?: number) => Promise<EngineHealthCheck>;
  stop: (timeoutMs?: number) => Promise<void>;
}

export async function createLlamaCppHarness(
  adapter: EngineAdapter,
  input: ResolveCommandInput,
): Promise<SpawnedLlamaCppHarness> {
  const command = await adapter.resolveCommand(input);
  const child = spawn(command.command, command.args, {
    cwd: command.cwd,
    env: {
      ...process.env,
      ...command.env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const stdout: string[] = [];
  const stderr: string[] = [];

  child.stdout.on("data", (chunk) => {
    stdout.push(chunk.toString());
  });

  child.stderr.on("data", (chunk) => {
    stderr.push(chunk.toString());
  });

  return {
    child,
    command,
    stdout,
    stderr,
    async waitForReady(timeoutMs = 3_000): Promise<EngineHealthCheck> {
      const deadline = Date.now() + timeoutMs;

      while (Date.now() < deadline) {
        const health = await adapter.healthCheck(input.runtimeKey);
        if (health.ok) {
          return health;
        }
        await sleep(50);
      }

      throw new Error(
        `Timed out waiting for fake llama.cpp worker readiness.\n${stdout.join("")}${stderr.join("")}`,
      );
    },
    async stop(timeoutMs = 2_000): Promise<void> {
      if (child.exitCode !== null) {
        return;
      }

      const exitPromise = once(child, "exit").then(() => undefined);

      if (command.healthUrl?.startsWith("http")) {
        try {
          await fetch(command.healthUrl.replace("/healthz", "/control/shutdown"), {
            method: "POST",
            signal: AbortSignal.timeout(500),
          });
        } catch {}
      }

      if (child.exitCode === null) {
        child.kill("SIGTERM");
      }

      await Promise.race([
        exitPromise,
        sleep(timeoutMs).then(() => {
          if (child.exitCode === null) {
            child.kill("SIGKILL");
          }
        }),
      ]);

      await exitPromise;
    },
  };
}
