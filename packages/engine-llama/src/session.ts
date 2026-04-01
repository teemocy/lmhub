import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";

import type {
  EngineAdapter,
  EngineHealthCheck,
  ResolveCommandInput,
  ResolvedCommand,
} from "@localhub/engine-core";

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

export interface LiveLlamaCppSession {
  readonly child: ChildProcessWithoutNullStreams;
  readonly command: ResolvedCommand;
  readonly stdout: string[];
  readonly stderr: string[];
  waitForReady: (timeoutMs?: number) => Promise<EngineHealthCheck>;
  checkHealth: () => Promise<EngineHealthCheck>;
  stop: (timeoutMs?: number) => Promise<void>;
}

export async function launchLlamaCppSession(
  adapter: EngineAdapter,
  input: ResolveCommandInput,
): Promise<LiveLlamaCppSession> {
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
    async waitForReady(timeoutMs = 5_000): Promise<EngineHealthCheck> {
      const deadline = Date.now() + timeoutMs;

      while (Date.now() < deadline) {
        const health = await adapter.healthCheck(input.runtimeKey);
        if (health.ok) {
          return health;
        }

        if (child.exitCode !== null) {
          break;
        }

        await sleep(75);
      }

      throw new Error(
        `Timed out waiting for llama.cpp readiness.\n${stdout.join("")}${stderr.join("")}`,
      );
    },
    async checkHealth(): Promise<EngineHealthCheck> {
      return adapter.healthCheck(input.runtimeKey);
    },
    async stop(timeoutMs = 2_000): Promise<void> {
      if (child.exitCode !== null) {
        return;
      }

      const exitPromise = once(child, "exit").then(() => undefined);
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
