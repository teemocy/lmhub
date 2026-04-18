import { describe, expect, it, vi } from "vitest";

import {
  fetchEngineUpdateSnapshot,
  fetchLatestLlamaCppReleaseTag,
  fetchLatestMlxRuntimeVersions,
} from "./engine-updates";

describe("engine update checks", () => {
  it("reads the latest llama.cpp release tag from GitHub", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        tag_name: "b9000",
      }),
    })) as unknown as typeof fetch;

    await expect(fetchLatestLlamaCppReleaseTag(fetchMock)).resolves.toEqual({
      latestReleaseTag: "b9000",
    });
  });

  it("reads mlx and mlx-lm versions from PyPI and builds a version tag", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/mlx/json")) {
        return {
          ok: true,
          json: async () => ({
            info: { version: "0.40.0" },
          }),
        };
      }

      return {
        ok: true,
        json: async () => ({
          info: { version: "0.41.0" },
        }),
      };
    }) as unknown as typeof fetch;

    await expect(fetchLatestMlxRuntimeVersions(fetchMock)).resolves.toEqual({
      latestMlxVersion: "0.40.0",
      latestMlxLmVersion: "0.41.0",
      latestVersionTag: "py312-mlx0.40.0-mlx-lm0.41.0",
    });
  });

  it("returns fallback status messages when remote checks fail", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("network unavailable");
    }) as unknown as typeof fetch;

    const snapshot = await fetchEngineUpdateSnapshot(fetchMock);

    expect(snapshot.llama.statusMessage).toContain("network unavailable");
    expect(snapshot.mlx.latestMlxVersion).toBe("0.31.1");
    expect(snapshot.mlx.latestMlxLmVersion).toBe("0.31.2");
    expect(snapshot.mlx.statusMessage).toContain("network unavailable");
  });
});
