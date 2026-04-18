import { describe, expect, it } from "vitest";

import { createMlxAdapter } from "./index.js";

describe("mlx adapter response normalization", () => {
  it("maps reasoning fields and fills missing message content", () => {
    const adapter = createMlxAdapter({
      preferFakeWorker: true,
    });

    const normalized = adapter.normalizeResponse({
      id: "chatcmpl-test",
      object: "chat.completion",
      created: 1,
      model: "/tmp/mlx-model",
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: {
            role: "assistant",
            reasoning: "thinking",
            tool_calls: null,
          },
        },
      ],
      usage: null,
    }) as {
      usage?: unknown;
      choices: Array<{
        message: {
          content: unknown;
          reasoning_content?: unknown;
          reasoning?: unknown;
          tool_calls?: unknown;
        };
      }>;
    };

    expect(normalized.usage).toBeUndefined();
    expect(normalized.choices[0]?.message.content).toBeNull();
    expect(normalized.choices[0]?.message.reasoning_content).toBe("thinking");
    expect(normalized.choices[0]?.message.reasoning).toBeUndefined();
    expect(normalized.choices[0]?.message.tool_calls).toBeUndefined();
  });

  it("maps streaming delta reasoning to reasoning_content", () => {
    const adapter = createMlxAdapter({
      preferFakeWorker: true,
    });

    const normalized = adapter.normalizeResponse({
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 1,
      model: "/tmp/mlx-model",
      choices: [
        {
          index: 0,
          finish_reason: null,
          delta: {
            role: "assistant",
            reasoning: "step",
            tool_calls: null,
          },
        },
      ],
    }) as {
      choices: Array<{
        delta: {
          reasoning_content?: unknown;
          reasoning?: unknown;
          tool_calls?: unknown;
        };
      }>;
    };

    expect(normalized.choices[0]?.delta.reasoning_content).toBe("step");
    expect(normalized.choices[0]?.delta.reasoning).toBeUndefined();
    expect(normalized.choices[0]?.delta.tool_calls).toBeUndefined();
  });
});
