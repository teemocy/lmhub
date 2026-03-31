import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { resolveAppPaths } from "./app-paths.js";
import { loadGatewayConfig } from "./config.js";
import { readGatewayDiscoveryFile, writeGatewayDiscoveryFile } from "./discovery.js";
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
    expect(config.sources).toContain("env");
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
