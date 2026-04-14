import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadGatewayConfig } from "../src/config.js";

const tempDirs: string[] = [];

function createTempDir(): string {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "gateway-config-"));
  tempDirs.push(tempDir);
  return tempDir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();
    if (tempDir) {
      rmSync(tempDir, { force: true, recursive: true });
    }
  }
});

describe("loadGatewayConfig", () => {
  it("uses the shared LOCAL_LLM_HUB gateway env overrides", () => {
    const config = loadGatewayConfig({
      cwd: process.cwd(),
      supportRoot: createTempDir(),
      env: {
        ...process.env,
        GATEWAY_PUBLIC_PORT: "7777",
        LOCAL_LLM_HUB_AUTH_REQUIRED: "true",
        LOCAL_LLM_HUB_AUTH_TOKEN: "stage1-shared-token",
        LOCAL_LLM_HUB_GATEWAY_PUBLIC_PORT: "9001",
        LOCAL_LLM_HUB_GATEWAY_CONTROL_PORT: "9002",
        LOCAL_LLM_HUB_GATEWAY_TELEMETRY_INTERVAL_MS: "2500",
        LOCAL_LLM_HUB_MAX_ACTIVE_MODELS_IN_MEMORY: "3",
        LOCAL_LLM_HUB_MODELS_DIR: "~/custom-models",
      },
    });

    expect(config.publicPort).toBe(9001);
    expect(config.controlPort).toBe(9002);
    expect(config.telemetryIntervalMs).toBe(2500);
    expect(config.maxActiveModelsInMemory).toBe(3);
    expect(config.publicBearerToken).toBe("stage1-shared-token");
    expect(config.controlBearerToken).toBe("stage1-shared-token");
    expect(config.localModelsDir).toBe(path.join(os.homedir(), "custom-models"));
  });

  it("uses the persisted public auth token when no env override is set", () => {
    const supportRoot = createTempDir();
    const filePath = path.join(supportRoot, "gateway.json");
    writeFileSync(
      filePath,
      JSON.stringify(
        {
          publicAuthToken: "persisted-public-secret",
          authRequired: true,
        },
        null,
        2,
      ),
    );

    const config = loadGatewayConfig({
      cwd: process.cwd(),
      supportRoot,
      filePath,
      env: {
        ...process.env,
      },
    });

    expect(config.publicBearerToken).toBe("persisted-public-secret");
    expect(config.controlBearerToken).toBe("persisted-public-secret");
  });
});
