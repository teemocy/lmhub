import type {
  RequestRoute,
  RequestTrace,
  RuntimeKey,
  RuntimeRole,
  GatewayEvent as SharedGatewayEvent,
  WorkerLifecycleState,
} from "@localhub/shared-contracts";

export type GatewayPlane = "public" | "control";

export type WorkerState =
  | "Idle"
  | "Loading"
  | "Ready"
  | "Busy"
  | "Unloading"
  | "Crashed"
  | "CoolingDown";

export interface RuntimeModelRecord {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  loaded: boolean;
  state: WorkerState;
  capabilities: string[];
}

export interface DownloadTaskRecord {
  id: string;
  provider: "huggingface" | "modelscope";
  modelId: string;
  status: "queued" | "running" | "completed";
  progress: number;
}

export interface EngineRecord {
  id: string;
  version: string;
  channel: "stable" | "nightly";
  installed: boolean;
}

export interface ControlHealthSnapshot {
  status: "ok";
  plane: GatewayPlane;
  uptimeMs: number;
  loadedModelCount: number;
  activeWebSocketClients: number;
}

export interface RequestTraceRecord {
  requestId: string;
  plane: GatewayPlane;
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  remoteAddress?: string | undefined;
}

export interface PreloadModelResult {
  model: RuntimeModelRecord;
  alreadyWarm: boolean;
}

export interface EvictModelResult {
  model: RuntimeModelRecord;
  wasLoaded: boolean;
}

export type GatewayEvent = SharedGatewayEvent;
export type RuntimeEventRoute = RequestRoute;
export type RuntimeEventTrace = RequestTrace;
export type RuntimeEventKey = RuntimeKey;
export type RuntimeEventRole = RuntimeRole;
export type RuntimeLifecycleState = WorkerLifecycleState;
