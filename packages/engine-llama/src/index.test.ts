import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
import {
  downloadPrebuiltMetalLlamaCppBinary,
  importLocalLlamaCppBinary,
} from "./binary-installer.js";

const tempRoots: string[] = [];
const harnesses: Array<Awaited<ReturnType<typeof createLlamaCppHarness>>> = [];

async function createSupportRoot(): Promise<string> {
  const supportRoot = await mkdtemp(path.join(os.tmpdir(), "localhub-engine-llama-"));
  tempRoots.push(supportRoot);
  return supportRoot;
}

async function createBinaryAdapter(supportRoot: string) {
  const fakeBinDir = path.join(supportRoot, "fake-bin");
  const fakeBinaryPath = path.join(fakeBinDir, "llama-server");
  await mkdir(fakeBinDir, { recursive: true });
  await writeFile(fakeBinaryPath, "#!/bin/sh\nexit 0\n");
  await chmod(fakeBinaryPath, 0o755);

  return {
    adapter: createLlamaCppAdapter({
      supportRoot,
      env: {
        ...process.env,
        PATH: fakeBinDir,
      },
    }),
    fakeBinaryPath,
  };
}

async function createTarGzArchive(archiveName: string): Promise<{
  archivePath: string;
  payloadDir: string;
  tempRoot: string;
}> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "localhub-llama-archive-"));
  tempRoots.push(tempRoot);

  const payloadDir = path.join(tempRoot, "payload");
  const nestedDir = path.join(payloadDir, "llama-binary");
  await mkdir(nestedDir, { recursive: true });
  await writeFile(path.join(nestedDir, "llama-server"), "#!/bin/sh\nexit 0\n");
  await chmod(path.join(nestedDir, "llama-server"), 0o755);

  const archivePath = path.join(tempRoot, archiveName);
  const result = spawnSync("tar", ["-czf", archivePath, "-C", payloadDir, "."], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "Failed to create test tarball.");
  }

  return {
    archivePath,
    payloadDir,
    tempRoot,
  };
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
  it("packages a local llama.cpp binary into app support and reuses it through the adapter", async () => {
    const supportRoot = await createSupportRoot();
    const localBinaryPath = path.join(supportRoot, "downloads", "custom-llama-server");
    await mkdir(path.dirname(localBinaryPath), { recursive: true });
    await writeFile(localBinaryPath, "#!/bin/sh\nexit 0\n");
    await chmod(localBinaryPath, 0o755);

    const installResult = await importLocalLlamaCppBinary({
      supportRoot,
      sourcePath: localBinaryPath,
    });

    const paths = resolveEngineSupportPaths(supportRoot, "llama.cpp");
    const registry = readEngineVersionRegistry(paths.registryFile, "llama.cpp");
    const adapter = createLlamaCppAdapter({
      supportRoot,
      preferFakeWorker: true,
    });

    const adapterInstall = await adapter.install(installResult.versionTag);

    expect(installResult.success).toBe(true);
    expect(installResult.binaryPath).not.toBe(localBinaryPath);
    expect(installResult.binaryPath.startsWith(paths.versionsRoot)).toBe(true);
    expect(registry.activeVersionTag).toBe(installResult.versionTag);
    expect(adapterInstall.binaryPath).toBe(installResult.binaryPath);
  });

  it("downloads a Metal llama.cpp archive and stores it inside app support", async () => {
    if (process.platform !== "darwin") {
      return;
    }

    const supportRoot = await createSupportRoot();
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    const assetName =
      arch === "arm64"
        ? "llama-b8648-bin-macos-arm64.tar.gz"
        : "llama-b8648-bin-macos-x64.tar.gz";
    const assetUrl = `https://example.invalid/${assetName}`;
    const releaseResponse = {
      tag_name: "b8648",
      name: "b8648",
      html_url: "https://github.com/ggml-org/llama.cpp/releases/tag/b8648",
      assets: [
        {
          name: assetName,
          browser_download_url: assetUrl,
          label: arch === "arm64" ? "macOS Apple Silicon (arm64)" : "macOS Intel (x64)",
        },
      ],
    };
    const { archivePath } = await createTarGzArchive(assetName);
    const archiveBytes = await import("node:fs/promises").then((fs) => fs.readFile(archivePath));

    const result = await downloadPrebuiltMetalLlamaCppBinary({
      supportRoot,
      fetch: async (input) => {
        const url = String(input);
        if (url.includes("/releases/latest")) {
          return new Response(JSON.stringify(releaseResponse), {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          });
        }

        if (url === assetUrl) {
          return new Response(archiveBytes, {
            status: 200,
            headers: {
              "content-type": "application/gzip",
            },
          });
        }

        return new Response("not found", { status: 404 });
      },
    });

    const paths = resolveEngineSupportPaths(supportRoot, "llama.cpp");
    const registry = readEngineVersionRegistry(paths.registryFile, "llama.cpp");

    expect(result.success).toBe(true);
    expect(result.binaryPath.startsWith(paths.versionsRoot)).toBe(true);
    expect(result.binaryPath).toContain("llama-server");
    expect(registry.activeVersionTag).toBe(result.versionTag);
  });

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

  it("emits --embedding for embedding runtimes when resolving a binary launch plan", async () => {
    const supportRoot = await createSupportRoot();
    const { adapter, fakeBinaryPath } = await createBinaryAdapter(supportRoot);

    const artifact = {
      ...LLAMA_CPP_FIXTURE_ARTIFACT,
      capabilities: {
        ...LLAMA_CPP_FIXTURE_ARTIFACT.capabilities,
        chat: false,
        embeddings: true,
      },
    };
    const profile = {
      ...LLAMA_CPP_FIXTURE_PROFILE,
      role: "embeddings" as const,
      parameterOverrides: {
        ...LLAMA_CPP_FIXTURE_PROFILE.parameterOverrides,
        batchSize: 2048,
        ubatchSize: 2048,
        poolingMethod: "mean" as const,
      },
    };
    const runtimeKey = {
      ...LLAMA_CPP_FIXTURE_RUNTIME_KEY,
      role: "embeddings" as const,
    };

    await adapter.install("b3119-stage1");
    const command = await adapter.resolveCommand({
      artifact,
      profile,
      runtimeKey,
      supportRoot,
    });

    expect(command.command).toBe(fakeBinaryPath);
    expect(command.managedBy).toBe("binary");
    expect(command.args).toEqual(
      expect.arrayContaining(["--embedding", "--ubatch-size", "2048", "--pooling", "mean"]),
    );
  });

  it("emits --rerank for rerank runtimes when resolving a binary launch plan", async () => {
    const supportRoot = await createSupportRoot();
    const { adapter, fakeBinaryPath } = await createBinaryAdapter(supportRoot);

    const artifact = {
      ...LLAMA_CPP_FIXTURE_ARTIFACT,
      capabilities: {
        ...LLAMA_CPP_FIXTURE_ARTIFACT.capabilities,
        chat: false,
        embeddings: false,
        rerank: true,
      },
    };
    const profile = {
      ...LLAMA_CPP_FIXTURE_PROFILE,
      role: "rerank" as const,
    };
    const runtimeKey = {
      ...LLAMA_CPP_FIXTURE_RUNTIME_KEY,
      role: "rerank" as const,
    };

    await adapter.install("b3119-stage1");
    const command = await adapter.resolveCommand({
      artifact,
      profile,
      runtimeKey,
      supportRoot,
    });

    expect(command.command).toBe(fakeBinaryPath);
    expect(command.managedBy).toBe("binary");
    expect(command.args).toEqual(expect.arrayContaining(["--rerank", "--batch-size", "512"]));
    expect(command.args).toEqual(expect.arrayContaining(["--ubatch-size", "512"]));
    expect(command.args).toEqual(expect.arrayContaining(["--parallel", "1"]));
    expect(command.args).toEqual(expect.arrayContaining(["--pooling", "rank"]));
    expect(command.args).toEqual(
      expect.arrayContaining(["--override-kv", "qwen2.pooling_type=int:4"]),
    );
  });

  it("does not inject a rerank pooling override when the GGUF already declares one", async () => {
    const supportRoot = await createSupportRoot();
    const { adapter } = await createBinaryAdapter(supportRoot);

    const artifact = {
      ...LLAMA_CPP_FIXTURE_ARTIFACT,
      architecture: "qwen3",
      metadata: {
        ...LLAMA_CPP_FIXTURE_ARTIFACT.metadata,
        architecture: "qwen3",
        metadata: {
          ...LLAMA_CPP_FIXTURE_ARTIFACT.metadata.metadata,
          "qwen3.pooling_type": 4,
        },
      },
      capabilities: {
        ...LLAMA_CPP_FIXTURE_ARTIFACT.capabilities,
        chat: false,
        embeddings: false,
        rerank: true,
      },
    };
    const profile = {
      ...LLAMA_CPP_FIXTURE_PROFILE,
      role: "rerank" as const,
    };
    const runtimeKey = {
      ...LLAMA_CPP_FIXTURE_RUNTIME_KEY,
      role: "rerank" as const,
    };

    await adapter.install("b3119-stage1");
    const command = await adapter.resolveCommand({
      artifact,
      profile,
      runtimeKey,
      supportRoot,
    });

    expect(command.args).toEqual(expect.arrayContaining(["--pooling", "rank"]));
    expect(command.args).toEqual(expect.arrayContaining(["--parallel", "1"]));
    expect(command.args).not.toEqual(
      expect.arrayContaining(["--override-kv", "qwen3.pooling_type=int:4"]),
    );
  });

  it("emits --mmproj for vision-capable runtimes when the sidecar is registered", async () => {
    const supportRoot = await createSupportRoot();
    const { adapter, fakeBinaryPath } = await createBinaryAdapter(supportRoot);
    const mmprojPath = path.join(supportRoot, "models", "mmproj-stage1-vision.gguf");

    await mkdir(path.dirname(mmprojPath), { recursive: true });
    await writeFile(mmprojPath, "fixture");

    const artifact = {
      ...LLAMA_CPP_FIXTURE_ARTIFACT,
      metadata: {
        ...LLAMA_CPP_FIXTURE_ARTIFACT.metadata,
        metadata: {
          ...LLAMA_CPP_FIXTURE_ARTIFACT.metadata.metadata,
          mmprojPath,
        },
      },
      capabilities: {
        ...LLAMA_CPP_FIXTURE_ARTIFACT.capabilities,
        vision: true,
      },
    };

    await adapter.install("b3119-stage1");
    const command = await adapter.resolveCommand({
      artifact,
      profile: LLAMA_CPP_FIXTURE_PROFILE,
      runtimeKey: LLAMA_CPP_FIXTURE_RUNTIME_KEY,
      supportRoot,
    });

    expect(command.command).toBe(fakeBinaryPath);
    expect(command.managedBy).toBe("binary");
    expect(command.args).toEqual(expect.arrayContaining(["--mmproj", mmprojPath]));
  });
});
