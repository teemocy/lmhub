import type { GatewayEvent } from "@localhub/shared-contracts";
import { describe, expect, it } from "vitest";
import {
  formatActivityRailMessage,
  formatLiveConsoleEntry,
  selectActivityRailEvents,
  selectLiveConsoleEvents,
} from "./telemetry";

const runtimeKey = {
  modelId: "demo-model",
  engineType: "llama.cpp",
  role: "chat" as const,
  configHash: "config-1234",
};

const traceEvent: GatewayEvent = {
  type: "REQUEST_TRACE",
  ts: "2026-04-03T08:15:00.000Z",
  traceId: "trace-12345678",
  payload: {
    traceId: "trace-12345678",
    requestId: "request-12345678",
    route: "POST /v1/chat/completions",
    method: "POST",
    receivedAt: "2026-04-03T08:14:59.000Z",
    completedAt: "2026-04-03T08:15:00.000Z",
    durationMs: 950,
    statusCode: 200,
    metadata: {},
  },
};

const logEvent: GatewayEvent = {
  type: "LOG_STREAM",
  ts: "2026-04-03T08:14:58.000Z",
  traceId: "trace-23456789",
  payload: {
    runtimeKey,
    level: "warn",
    message: "Worker warmed after retry",
    source: "gateway",
  },
};

const modelStateEvent: GatewayEvent = {
  type: "MODEL_STATE_CHANGED",
  ts: "2026-04-03T08:14:57.000Z",
  traceId: "trace-34567890",
  payload: {
    modelId: "demo-model",
    runtimeKey,
    nextState: "Ready",
    previousState: "Loading",
  },
};

const metricsEvent: GatewayEvent = {
  type: "METRICS_TICK",
  ts: "2026-04-03T08:14:56.000Z",
  traceId: "trace-45678901",
  payload: {
    activeWorkers: 1,
    queuedRequests: 0,
    residentMemoryBytes: 2048,
    gpuMemoryBytes: 1024,
  },
};

const downloadEvent: GatewayEvent = {
  type: "DOWNLOAD_PROGRESS",
  ts: "2026-04-03T08:14:55.000Z",
  traceId: "trace-56789012",
  payload: {
    taskId: "task-12345678",
    modelId: "demo-model",
    downloadedBytes: 2_097_152,
    totalBytes: 4_194_304,
    status: "downloading",
    message: "Fetching shard 2 of 4",
  },
};

describe("telemetry helpers", () => {
  it("routes only log and trace events into the live console stream", () => {
    expect(selectLiveConsoleEvents([traceEvent, metricsEvent, logEvent])).toEqual([
      traceEvent,
      logEvent,
    ]);
  });

  it("keeps only the latest 10 log entries in the live console stream", () => {
    const olderLogEvents: GatewayEvent[] = Array.from({ length: 20 }, (_, index) => ({
      type: "LOG_STREAM",
      ts: `2026-04-03T08:14:${String(40 - index).padStart(2, "0")}.000Z`,
      traceId: `trace-${String(index).padStart(8, "0")}`,
      payload: {
        runtimeKey,
        level: "info",
        message: `Log entry ${index + 1}`,
        source: "gateway",
      },
    }));

    const liveConsoleEvents = selectLiveConsoleEvents([traceEvent, ...olderLogEvents]);

    expect(liveConsoleEvents).toHaveLength(10);
    expect(liveConsoleEvents[0]).toEqual(traceEvent);
    expect(liveConsoleEvents.at(-1)).toEqual(olderLogEvents[8]);
  });

  it("keeps streaming telemetry out of the right-rail activity list", () => {
    expect(
      selectActivityRailEvents([traceEvent, logEvent, modelStateEvent, downloadEvent]),
    ).toEqual([modelStateEvent, downloadEvent]);
  });

  it("formats trace entries with an explicit TRACE badge", () => {
    expect(formatLiveConsoleEntry(traceEvent)).toEqual({
      tone: "trace",
      label: "TRACE",
      message: "POST /v1/chat/completions • 200 • 950 ms",
    });
  });

  it("formats activity messages for download progress", () => {
    expect(formatActivityRailMessage(downloadEvent)).toBe(
      "demo-model • downloading • 2.0 MB / 4.0 MB • Fetching shard 2 of 4",
    );
  });
});
