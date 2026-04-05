import type {
  ChatSession,
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
import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS } from "./channels";
import type { DesktopSystemPaths } from "./gateway-manager";
import type { DesktopRuntimeContext } from "./index";

type FileDialogResult = {
  canceled: boolean;
  filePaths: string[];
};

type Listener<T> = (payload: T) => void;

const subscribe = <T>(channel: string, listener: Listener<T>) => {
  const wrapped = (_event: Electron.IpcRendererEvent, payload: T) => {
    listener(payload);
  };

  ipcRenderer.on(channel, wrapped);

  return () => {
    ipcRenderer.removeListener(channel, wrapped);
  };
};

const api = {
  shell: {
    getState: () => ipcRenderer.invoke(IPC_CHANNELS.shellGetState) as Promise<DesktopShellState>,
    onStateChange: (listener: Listener<DesktopShellState>) =>
      subscribe(IPC_CHANNELS.shellStateChanged, listener),
  },
  gateway: {
    listModels: () =>
      ipcRenderer.invoke(IPC_CHANNELS.gatewayListModels) as Promise<PublicModelList>,
    listModelLibrary: () =>
      ipcRenderer.invoke(IPC_CHANNELS.gatewayListModelLibrary) as Promise<DesktopModelLibrary>,
    getHealth: () =>
      ipcRenderer.invoke(IPC_CHANNELS.gatewayGetHealth) as Promise<GatewayHealthSnapshot>,
    listEngines: () =>
      ipcRenderer.invoke(IPC_CHANNELS.gatewayListEngines) as Promise<DesktopEngineList>,
    installEngineBinary: (payload: DesktopEngineInstallRequest) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.gatewayInstallEngineBinary,
        payload,
      ) as Promise<DesktopEngineInstallResponse>,
    registerLocalModel: (payload: DesktopLocalModelImportRequest) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.gatewayRegisterLocalModel,
        payload,
      ) as Promise<DesktopLocalModelImportResponse>,
    updateModelConfig: (modelId: string, payload: DesktopModelConfigUpdateRequest) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.gatewayUpdateModelConfig,
        modelId,
        payload,
      ) as Promise<DesktopModelConfigUpdateResponse>,
    preloadModel: (modelId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.gatewayPreloadModel, modelId) as Promise<void>,
    evictModel: (modelId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.gatewayEvictModel, modelId) as Promise<void>,
    listChatSessions: () =>
      ipcRenderer.invoke(IPC_CHANNELS.gatewayListChatSessions) as Promise<DesktopChatSessionList>,
    listChatMessages: (sessionId: string) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.gatewayListChatMessages,
        sessionId,
      ) as Promise<DesktopChatMessageList>,
    upsertChatSession: (payload: DesktopChatSessionUpsertRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.gatewayUpsertChatSession, payload) as Promise<ChatSession>,
    deleteChatSession: (sessionId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.gatewayDeleteChatSession, sessionId) as Promise<void>,
    runChat: (payload: DesktopChatRunRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.gatewayRunChat, payload) as Promise<DesktopChatRunResponse>,
    subscribeChatStream: (listener: Listener<DesktopChatStreamEvent>) =>
      subscribe(IPC_CHANNELS.gatewayChatStream, listener),
    listApiLogs: (limit?: number) =>
      ipcRenderer.invoke(IPC_CHANNELS.gatewayListApiLogs, limit) as Promise<DesktopApiLogList>,
    searchCatalog: (query: string) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.gatewaySearchCatalog,
        query,
      ) as Promise<DesktopProviderSearchResult>,
    getCatalogModel: (provider: "huggingface" | "modelscope", providerModelId: string) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.gatewayGetCatalogModel,
        provider,
        providerModelId,
      ) as Promise<DesktopProviderCatalogDetailResponse>,
    listDownloads: () =>
      ipcRenderer.invoke(IPC_CHANNELS.gatewayListDownloads) as Promise<DesktopDownloadList>,
    createDownload: (payload: DesktopDownloadCreateRequest) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.gatewayCreateDownload,
        payload,
      ) as Promise<DesktopDownloadActionResponse>,
    pauseDownload: (id: string) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.gatewayPauseDownload,
        id,
      ) as Promise<DesktopDownloadActionResponse>,
    resumeDownload: (id: string) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.gatewayResumeDownload,
        id,
      ) as Promise<DesktopDownloadActionResponse>,
    restart: () => ipcRenderer.invoke(IPC_CHANNELS.gatewayRestart) as Promise<void>,
    shutdown: () => ipcRenderer.invoke(IPC_CHANNELS.gatewayShutdown) as Promise<void>,
    subscribeEvents: (listener: Listener<GatewayEvent>) =>
      subscribe(IPC_CHANNELS.gatewayEvent, listener),
    openModelFileDialog: () =>
      ipcRenderer.invoke(IPC_CHANNELS.gatewayOpenModelDialog) as Promise<FileDialogResult>,
    openEngineBinaryDialog: () =>
      ipcRenderer.invoke(IPC_CHANNELS.gatewayOpenEngineBinaryDialog) as Promise<FileDialogResult>,
  },
  system: {
    getPaths: () => ipcRenderer.invoke(IPC_CHANNELS.systemGetPaths) as Promise<DesktopSystemPaths>,
    getRuntimeContext: () =>
      ipcRenderer.invoke(IPC_CHANNELS.systemGetRuntimeContext) as Promise<DesktopRuntimeContext>,
    copyPath: (filePath: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.systemCopyPath, filePath) as Promise<void>,
    revealPath: (filePath: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.systemRevealPath, filePath) as Promise<boolean>,
    pickModelsDirectory: () =>
      ipcRenderer.invoke(
        IPC_CHANNELS.gatewayOpenModelsDirectoryDialog,
      ) as Promise<FileDialogResult>,
    updateModelsDirectory: (modelsDir: string) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.systemUpdateModelsDirectory,
        modelsDir,
      ) as Promise<DesktopRuntimeContext>,
    updateControlAuthSettings: (payload: {
      headerName: "authorization" | "x-api-key" | "api-key";
      token?: string;
    }) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.systemUpdateControlAuthSettings,
        payload,
      ) as Promise<DesktopRuntimeContext>,
  },
};

contextBridge.exposeInMainWorld("desktopApi", api);
