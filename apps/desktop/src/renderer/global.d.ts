import type {
  ChatSession,
  ControlAuthHeaderName,
  DesktopApiLogList,
  DesktopChatMessageList,
  DesktopChatRunRequest,
  DesktopChatRunResponse,
  DesktopChatSessionList,
  DesktopChatSessionUpsertRequest,
  DesktopChatStreamEvent,
  DesktopDownloadActionResponse,
  DesktopDownloadCreateRequest,
  DesktopDownloadList,
  DesktopEngineInstallRequest,
  DesktopEngineInstallResponse,
  DesktopEngineList,
  DesktopLocalModelImportRequest,
  DesktopLocalModelImportResponse,
  DesktopModelConfigUpdateRequest,
  DesktopModelConfigUpdateResponse,
  DesktopModelLibrary,
  DesktopProviderCatalogDetailResponse,
  DesktopProviderSearchResult,
  DesktopShellState,
  GatewayEvent,
  GatewayHealthSnapshot,
  PublicModelList,
} from "@localhub/shared-contracts";

type DesktopSystemPaths = {
  workspaceRoot: string;
  supportDir: string;
  logsDir: string;
  sessionLogFile: string;
  discoveryFile: string;
};

type DesktopRuntimeContext = {
  desktop: {
    closeToTray: boolean;
    autoLaunchGateway: boolean;
    theme: "system" | "light" | "dark";
    controlAuthHeaderName: ControlAuthHeaderName;
    controlAuthToken?: string;
  };
  gateway: {
    enableLan: boolean;
    authRequired: boolean;
    publicHost: string;
    controlHost: string;
    corsAllowlist: string[];
    defaultModelTtlMs: number;
    localModelsDir: string;
    controlAuthHeaderName: ControlAuthHeaderName;
    authConfigured: boolean;
  };
  files: {
    desktopConfigFile: string;
    gatewayConfigFile: string;
  };
};

type FileDialogResult = {
  canceled: boolean;
  filePaths: string[];
};

type Unsubscribe = () => void;

type DesktopApi = {
  shell: {
    getState(): Promise<DesktopShellState>;
    onStateChange(listener: (state: DesktopShellState) => void): Unsubscribe;
  };
  gateway: {
    listModels(): Promise<PublicModelList>;
    listModelLibrary(): Promise<DesktopModelLibrary>;
    getHealth(): Promise<GatewayHealthSnapshot>;
    listEngines(): Promise<DesktopEngineList>;
    installEngineBinary(
      payload: DesktopEngineInstallRequest,
    ): Promise<DesktopEngineInstallResponse>;
    registerLocalModel(
      payload: DesktopLocalModelImportRequest,
    ): Promise<DesktopLocalModelImportResponse>;
    updateModelConfig(
      modelId: string,
      payload: DesktopModelConfigUpdateRequest,
    ): Promise<DesktopModelConfigUpdateResponse>;
    preloadModel(modelId: string): Promise<void>;
    evictModel(modelId: string): Promise<void>;
    listChatSessions(): Promise<DesktopChatSessionList>;
    listChatMessages(sessionId: string): Promise<DesktopChatMessageList>;
    upsertChatSession(payload: DesktopChatSessionUpsertRequest): Promise<ChatSession>;
    deleteChatSession(sessionId: string): Promise<void>;
    runChat(payload: DesktopChatRunRequest): Promise<DesktopChatRunResponse>;
    subscribeChatStream(listener: (event: DesktopChatStreamEvent) => void): Unsubscribe;
    listApiLogs(limit?: number): Promise<DesktopApiLogList>;
    searchCatalog(query: string): Promise<DesktopProviderSearchResult>;
    getCatalogModel(
      provider: "huggingface" | "modelscope",
      providerModelId: string,
    ): Promise<DesktopProviderCatalogDetailResponse>;
    listDownloads(): Promise<DesktopDownloadList>;
    createDownload(payload: DesktopDownloadCreateRequest): Promise<DesktopDownloadActionResponse>;
    pauseDownload(id: string): Promise<DesktopDownloadActionResponse>;
    resumeDownload(id: string): Promise<DesktopDownloadActionResponse>;
    restart(): Promise<void>;
    shutdown(): Promise<void>;
    subscribeEvents(listener: (event: GatewayEvent) => void): Unsubscribe;
    openModelFileDialog(): Promise<FileDialogResult>;
    openEngineBinaryDialog(): Promise<FileDialogResult>;
  };
  system: {
    getPaths(): Promise<DesktopSystemPaths>;
    getRuntimeContext(): Promise<DesktopRuntimeContext>;
    copyPath(filePath: string): Promise<void>;
    revealPath(filePath: string): Promise<boolean>;
    pickModelsDirectory(): Promise<FileDialogResult>;
    updateModelsDirectory(modelsDir: string): Promise<DesktopRuntimeContext>;
    updateControlAuthSettings(payload: {
      headerName: ControlAuthHeaderName;
      token?: string;
    }): Promise<DesktopRuntimeContext>;
  };
};

declare global {
  interface Window {
    desktopApi: DesktopApi;
  }
}
