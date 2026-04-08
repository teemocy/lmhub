import { describe, expect, it } from "vitest";

import { estimateTextTokens } from "./chat-content.js";

describe("estimateTextTokens", () => {
  it("uses text density instead of whitespace-delimited words", () => {
    expect(
      estimateTextTokens("counterrevolutionary hyperparameterization metamorphosis finalization"),
    ).toBe(17);
  });

  it("counts East Asian characters more realistically than word splitting", () => {
    expect(estimateTextTokens("\u8fd9\u662f\u4e00\u4e2a\u63a8\u7406\u8fc7\u7a0b")).toBe(8);
  });
});
