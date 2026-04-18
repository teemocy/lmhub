import { describe, expect, it } from "vitest";

import { buildMlxVersionTag, parseMlxVersionTag } from "./versioning.js";

describe("mlx version tags", () => {
  it("round-trips runtime version tags", () => {
    const versionTag = buildMlxVersionTag({
      pythonVersion: "3.12",
      mlxVersion: "0.31.1",
      mlxLmVersion: "0.31.2",
    });

    expect(parseMlxVersionTag(versionTag)).toEqual({
      pythonVersion: "3.12",
      mlxVersion: "0.31.1",
      mlxLmVersion: "0.31.2",
    });
  });

  it("returns undefined for unrelated tags", () => {
    expect(parseMlxVersionTag("custom-runtime")).toBeUndefined();
  });
});
