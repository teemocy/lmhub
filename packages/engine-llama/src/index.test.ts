import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { readEngineVersionRegistry, resolveEngineSupportPaths } from "@localhub/engine-core";
import { afterEach, describe, expect, it } from "vitest";

import {
  LLAMA_CPP_FIXTURE_ARTIFACT,
  LLAMA_CPP_FIXTURE_PROFILE,
  LLAMA_CPP_FIXTURE_RUNTIME_KEY,
  createLlamaCppAdapter,
  createLlamaCppHarness,
} from "./index.js";

const tempRoots: string[] = [];
const harnesses: Array<Awaited<ReturnType<typeof createLlamaCppHarness>>> = [];

async function createSupportRoot(): Promise<string> {
  const supportRoot = await mkdtemp(path.join(os.tmpdir(), "localhub-engine-llama-"));
  tempRoots.push(supportRoot);
  return supportRoot;
}

afterEach(async () => {
  while (harnesses.length > 0) {
    const harness = harnesses.pop();
    if (!harness) {
      continue;
    }

    await harness.stop().catch(() => undefined);
  }

  while (tempRoots.length > 0) {
    const supportRoot = tempRoots.pop();
    if (!supportRoot) {
      continue;
    }

    await rm(supportRoot, { recursive: true, force: true });
  }
});

describe("llama.cpp stage 1 scaffolding", () => {
  it("creates and activates a file-backed engine version registry", async () => {
    const supportRoot = await createSupportRoot();
    const adapter = createLlamaCppAdapter({
      supportRoot,
      preferFakeWorker: true,
    });

    const installResult = await adapter.install("b3119-stage1");
    const paths = resolveEngineSupportPaths(supportRoot, "llama.cpp");
    const registry = readEngineVersionRegistry(paths.registryFile, "llama.cpp");

    expect(installResult.success).toBe(true);
    expect(installResult.activated).toBe(true);
    expect(registry.activeVersionTag).toBe("b3119-stage1");
    expect(registry.versions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          versionTag: "b3119-stage1",
          managedBy: "fake-worker",
        }),
      ]),
    );
  });

  it("resolves a spawnable command with runtime metadata instead of a PATH placeholder", async () => {
    const supportRoot = await createSupportRoot();
    const adapter = createLlamaCppAdapter({
      supportRoot,
      preferFakeWorker: true,
      fakeWorkerStartupDelayMs: 25,
    });

    await adapter.install("b3119-stage1");
    const command = await adapter.resolveCommand({
      artifact: LLAMA_CPP_FIXTURE_ARTIFACT,
      profile: LLAMA_CPP_FIXTURE_PROFILE,
      runtimeKey: LLAMA_CPP_FIXTURE_RUNTIME_KEY,
      supportRoot,
    });

    expect(command.command).toBe(process.execPath);
    expect(command.args).toEqual(expect.arrayContaining(["--input-type=module", "--eval"]));
    expect(command.managedBy).toBe("fake-worker");
    expect(command.healthUrl).toMatch(/^file:\/\/.+\/health\.json$/);
    expect(command.env).toMatchObject({
      LOCALHUB_MODEL_ID: LLAMA_CPP_FIXTURE_ARTIFACT.id,
      LOCALHUB_MODEL_PATH: LLAMA_CPP_FIXTURE_ARTIFACT.localPath,
    });
  });

  it("spawns the fake worker harness and reports readiness through health checks", async () => {
    const supportRoot = await createSupportRoot();
    const adapter = createLlamaCppAdapter({
      supportRoot,
      preferFakeWorker: true,
      fakeWorkerStartupDelayMs: 25,
    });

    await adapter.install("b3119-stage1");

    const harness = await createLlamaCppHarness(adapter, {
      artifact: LLAMA_CPP_FIXTURE_ARTIFACT,
      profile: LLAMA_CPP_FIXTURE_PROFILE,
      runtimeKey: LLAMA_CPP_FIXTURE_RUNTIME_KEY,
      supportRoot,
    });
    harnesses.push(harness);

    const readyHealth = await harness.waitForReady();
    expect(readyHealth.ok).toBe(true);
    expect(harness.stdout.join("")).toContain('"phase":"ready"');

    await harness.stop();

    const stoppedHealth = await adapter.healthCheck(LLAMA_CPP_FIXTURE_RUNTIME_KEY);
    expect(stoppedHealth.ok).toBe(false);
    expect(stoppedHealth.snapshot?.state).toBe("offline");
  });
});
