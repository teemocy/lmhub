import { describe, expect, it } from "vitest";

import type { EngineVersionRecord, EngineVersionRegistry } from "./index.js";
import { removeEngineVersion } from "./index.js";

function createVersionRecord(
  versionTag: string,
  installedAt: string,
  source: EngineVersionRecord["source"] = "release",
): EngineVersionRecord {
  return {
    versionTag,
    installPath: `/engines/llama.cpp/${versionTag}`,
    binaryPath: `/engines/llama.cpp/${versionTag}/llama-server`,
    source,
    channel: source === "release" ? "stable" : "custom",
    managedBy: "binary",
    installedAt,
    notes: [],
  };
}

describe("engine version registry helpers", () => {
  it("promotes the next installed version when removing the active entry", () => {
    const registry: EngineVersionRegistry = {
      engineType: "llama.cpp",
      activeVersionTag: "b9001",
      updatedAt: "2026-04-19T10:00:00.000Z",
      versions: [
        createVersionRecord("b9001", "2026-04-19T10:00:00.000Z"),
        createVersionRecord("b9000", "2026-04-18T10:00:00.000Z"),
      ],
    };

    const nextRegistry = removeEngineVersion(registry, "b9001");

    expect(nextRegistry.activeVersionTag).toBe("b9000");
    expect(nextRegistry.versions).toEqual([expect.objectContaining({ versionTag: "b9000" })]);
    expect(nextRegistry.updatedAt).not.toBe(registry.updatedAt);
  });

  it("keeps the current active entry when removing an inactive version", () => {
    const registry: EngineVersionRegistry = {
      engineType: "llama.cpp",
      activeVersionTag: "b9001",
      updatedAt: "2026-04-19T10:00:00.000Z",
      versions: [
        createVersionRecord("b9001", "2026-04-19T10:00:00.000Z"),
        createVersionRecord("manual-import", "2026-04-18T10:00:00.000Z", "manual"),
      ],
    };

    const nextRegistry = removeEngineVersion(registry, "manual-import");

    expect(nextRegistry.activeVersionTag).toBe("b9001");
    expect(nextRegistry.versions).toEqual([expect.objectContaining({ versionTag: "b9001" })]);
  });
});
