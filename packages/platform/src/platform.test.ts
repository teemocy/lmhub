import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LOCAL_ARTIFACT_LAYOUT_SPEC } from "@localhub/shared-contracts";
import { afterEach, describe, expect, it } from "vitest";

import { ensureAppPaths, resolveAppPaths } from "./app-paths.js";
import { loadDesktopConfig, loadGatewayConfig, writeConfigFile } from "./config.js";
import { readGatewayDiscoveryFile, writeGatewayDiscoveryFile } from "./discovery.js";
import { classifyStderrLogLevel } from "./log-stream.js";
import { createLogger } from "./logger.js";
import { createApiTokenRecord, verifyBearerToken } from "./security.js";

const tempDirectories: string[] = [];

afterEach(() => {
  while (tempDirectories.length > 0) {
    rmSync(tempDirectories.pop() as string, { recursive: true, force: true });
  }
});

describe("platform helpers", () => {
  it("resolves deterministic development app paths", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "local-llm-hub-paths-"));
    tempDirectories.push(root);

    const paths = resolveAppPaths({ cwd: root, environment: "development" });
    expect(paths.supportRoot).toContain(path.join(".local", "local-llm-hub", "dev"));
    expect(paths.databaseFile.endsWith("gateway.sqlite")).toBe(true);
    expect(paths.promptCachesDir).toContain(
      LOCAL_ARTIFACT_LAYOUT_SPEC.directories.promptCaches.relativePath,
    );
    expect(paths.checksumsDir).toContain(
      LOCAL_ARTIFACT_LAYOUT_SPEC.directories.checksums.relativePath,
    );
    expect(paths.tempDir).toContain(LOCAL_ARTIFACT_LAYOUT_SPEC.directories.temp.relativePath);
    expect(paths.promptCacheDir).toBe(paths.promptCachesDir);
  });

  it("provisions the shared artifact layout directories", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "local-llm-hub-layout-"));
    tempDirectories.push(root);

    const paths = ensureAppPaths(
      resolveAppPaths({ supportRoot: root, environment: "development" }),
    );

    expect(existsSync(paths.enginesDir)).toBe(true);
    expect(existsSync(paths.modelsDir)).toBe(true);
    expect(existsSync(paths.downloadsDir)).toBe(true);
    expect(existsSync(paths.checksumsDir)).toBe(true);
    expect(existsSync(paths.promptCachesDir)).toBe(true);
    expect(existsSync(paths.tempDir)).toBe(true);
  });

  it("loads gateway config with environment overrides", () => {
    const config = loadGatewayConfig({
      cwd: "/workspace",
      environment: "development",
      env: {
        LOCAL_LLM_HUB_GATEWAY_PUBLIC_PORT: "9000",
        LOCAL_LLM_HUB_ENABLE_LAN: "true",
      },
    });

    expect(config.value.publicPort).toBe(9000);
    expect(config.value.enableLan).toBe(true);
    expect(config.value.localModelsDir).toBe(path.join(os.homedir(), ".llm_hub", "models"));
    expect(config.sources).toContain("env");
  });

  it("loads desktop config with a persisted control auth header preference", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "local-llm-hub-desktop-config-"));
    tempDirectories.push(root);
    const filePath = path.join(root, "desktop.json");

    writeConfigFile(filePath, {
      controlAuthHeaderName: "x-api-key",
      controlAuthToken: "test-secret-value",
    });

    const config = loadDesktopConfig({
      cwd: root,
      environment: "development",
      filePath,
    });

    expect(config.value.controlAuthHeaderName).toBe("x-api-key");
    expect(config.value.controlAuthToken).toBe("test-secret-value");
    expect(config.sources).toContain("file");
  });

  it("creates parent directories when writing config files", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "local-llm-hub-config-"));
    tempDirectories.push(root);
    const filePath = path.join(root, "config", "gateway.json");

    writeConfigFile(filePath, {
      localModelsDir: "/tmp/models",
      enableLan: true,
    });

    expect(existsSync(filePath)).toBe(true);
    expect(JSON.parse(readFileSync(filePath, "utf8"))).toEqual({
      localModelsDir: "/tmp/models",
      enableLan: true,
    });
  });

  it("round-trips the discovery file", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "local-llm-hub-discovery-"));
    tempDirectories.push(root);
    const filePath = path.join(root, "gateway-discovery.json");

    writeGatewayDiscoveryFile(filePath, {
      environment: "development",
      gatewayVersion: "0.1.0",
      generatedAt: "2026-03-31T12:00:00.000Z",
      publicBaseUrl: "http://127.0.0.1:1337",
      controlBaseUrl: "http://127.0.0.1:16384",
      websocketUrl: "ws://127.0.0.1:16384/ws",
      supportRoot: root,
    });

    const discovery = readGatewayDiscoveryFile(filePath);
    expect(discovery?.gatewayVersion).toBe("0.1.0");
  });

  it("redacts token-like fields in structured logs", () => {
    const entries: unknown[] = [];
    const logger = createLogger({
      name: "gateway",
      level: "debug",
      sink(entry) {
        entries.push(entry);
      },
    });

    logger.info("request received", {
      requestId: "req_1",
      authorization: "Bearer secret-token",
    });

    expect(entries).toHaveLength(1);
    expect(JSON.stringify(entries[0])).toContain("[redacted]");
  });

  it("classifies common stderr diagnostics without promoting them to errors", () => {
    expect(classifyStderrLogLevel("ggml_metal_free: deallocating")).toBe("info");
    expect(
      classifyStderrLogLevel(
        "llama_memory_breakdown_print: | memory breakdown [MiB] | total free self model context compute unaccounted |",
      ),
    ).toBe("info");
    expect(classifyStderrLogLevel("srv operator(): cleaning up before exit...")).toBe("info");
    expect(classifyStderrLogLevel("Warning: model cache is stale")).toBe("warn");
    expect(classifyStderrLogLevel("Fatal error: worker crashed")).toBe("error");
  });

  it("hashes and verifies bearer tokens", () => {
    const tokenRecord = createApiTokenRecord("integration");
    expect(verifyBearerToken(tokenRecord.plainTextToken, tokenRecord.tokenHash)).toBe(true);
    expect(verifyBearerToken("invalid-token-value", tokenRecord.tokenHash)).toBe(false);
  });

  it("fails closed for malformed stored hashes", () => {
    const token = "0123456789abcdef";

    expect(verifyBearerToken(token, "scrypt$16384$8$1$bad-salt$short")).toBe(false);
    expect(verifyBearerToken(token, "scrypt$not-a-number$8$1$salt$hash")).toBe(false);
    expect(verifyBearerToken("short-token", "scrypt$16384$8$1$bad-salt$short")).toBe(false);
  });
});
