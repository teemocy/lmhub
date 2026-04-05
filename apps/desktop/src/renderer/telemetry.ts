import type { GatewayEvent } from "@localhub/shared-contracts";

type ActivityRailEvent = Extract<
  GatewayEvent,
  { type: "MODEL_STATE_CHANGED" | "DOWNLOAD_PROGRESS" }
>;

type LiveConsoleEvent = Extract<GatewayEvent, { type: "LOG_STREAM" | "REQUEST_TRACE" }>;

export type LiveConsoleEntry = {
  tone: "debug" | "info" | "warn" | "error" | "trace";
  label: string;
  message: string;
};

const formatBytes = (value: number): string => {
  if (value <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  let nextValue = value;
  let unitIndex = 0;

  while (nextValue >= 1024 && unitIndex < units.length - 1) {
    nextValue /= 1024;
    unitIndex += 1;
  }

  return `${nextValue >= 10 ? nextValue.toFixed(0) : nextValue.toFixed(1)} ${units[unitIndex]}`;
};

export const selectActivityRailEvents = (events: GatewayEvent[], limit = 10): ActivityRailEvent[] =>
  events
    .filter(
      (event): event is ActivityRailEvent =>
        event.type === "MODEL_STATE_CHANGED" || event.type === "DOWNLOAD_PROGRESS",
    )
    .slice(0, limit);

export const selectLiveConsoleEvents = (events: GatewayEvent[], limit = 10): LiveConsoleEvent[] =>
  events
    .filter(
      (event): event is LiveConsoleEvent =>
        event.type === "LOG_STREAM" || event.type === "REQUEST_TRACE",
    )
    .slice(0, limit);

export const formatActivityRailMessage = (event: ActivityRailEvent): string => {
  if (event.type === "MODEL_STATE_CHANGED") {
    return event.payload.reason
      ? `${event.payload.modelId} -> ${event.payload.nextState} (${event.payload.reason})`
      : `${event.payload.modelId} -> ${event.payload.nextState}`;
  }

  const progress =
    typeof event.payload.totalBytes === "number" && event.payload.totalBytes > 0
      ? `${formatBytes(event.payload.downloadedBytes)} / ${formatBytes(event.payload.totalBytes)}`
      : `${formatBytes(event.payload.downloadedBytes)} downloaded`;
  const scope = event.payload.modelId ? `${event.payload.modelId} • ` : "";
  const detail = event.payload.message ? ` • ${event.payload.message}` : "";
  return `${scope}${event.payload.status} • ${progress}${detail}`;
};

export const formatLiveConsoleEntry = (event: LiveConsoleEvent): LiveConsoleEntry => {
  if (event.type === "LOG_STREAM") {
    return {
      tone: event.payload.level,
      label: event.payload.level.toUpperCase(),
      message: `[${event.payload.source}] ${event.payload.message}`,
    };
  }

  const facets: string[] = [event.payload.route];
  facets.push(
    typeof event.payload.statusCode === "number" ? String(event.payload.statusCode) : "Pending",
  );
  facets.push(
    typeof event.payload.durationMs === "number" ? `${event.payload.durationMs} ms` : "In flight",
  );

  if (event.payload.modelId) {
    facets.push(`model ${event.payload.modelId}`);
  }

  return {
    tone: "trace",
    label: "TRACE",
    message: facets.join(" • "),
  };
};
