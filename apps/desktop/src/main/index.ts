import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ensureAppPaths,
  loadDesktopConfig,
  loadGatewayConfig as loadPlatformGatewayConfig,
  resolveAppPaths,
  writeConfigFile,
} from "@localhub/platform";
import type { ControlAuthHeaderName } from "@localhub/shared-contracts";
import {
  BrowserWindow,
  type Event as ElectronEvent,
  Menu,
  Tray,
  app,
  clipboard,
  dialog,
  ipcMain,
  nativeImage,
  shell,
} from "electron";
import { loadGatewayConfig } from "../../../../services/gateway/src/config";
import { IPC_CHANNELS } from "./channels";
import { GatewayManager, resolveDesktopRuntimeEnvironment } from "./gateway-manager";

export type DesktopRuntimeContext = {
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

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
const APP_NAME = "LM Hub";

const workspaceRoot = path.resolve(__dirname, "..", "..", "..");
const runtimeEnvironment = resolveDesktopRuntimeEnvironment(workspaceRoot);
app.setName(APP_NAME);
let desktopConfig = loadDesktopConfig({
  cwd: workspaceRoot,
  environment: runtimeEnvironment,
});
const gatewayManager = new GatewayManager({
  getControlAuthHeaderName: () => desktopConfig.value.controlAuthHeaderName,
  getControlAuthToken: () => desktopConfig.value.controlAuthToken,
});
const appPaths = ensureAppPaths(
  resolveAppPaths({
    cwd: workspaceRoot,
    environment: runtimeEnvironment,
  }),
);
let gatewayConfig = loadGatewayConfig({
  cwd: workspaceRoot,
  environment: runtimeEnvironment,
});
let sharedGatewayConfig = loadPlatformGatewayConfig({
  cwd: workspaceRoot,
  environment: runtimeEnvironment,
});

const relayToWindows = (channel: string, payload: unknown): void => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(channel, payload);
    }
  }
};

gatewayManager.on("state", (state) => {
  relayToWindows(IPC_CHANNELS.shellStateChanged, state);
});

gatewayManager.on("event", (event) => {
  relayToWindows(IPC_CHANNELS.gatewayEvent, event);
});

gatewayManager.on("chatStream", (event) => {
  relayToWindows(IPC_CHANNELS.gatewayChatStream, event);
});

const createTrayIcon = () =>
  nativeImage.createFromDataURL(
    `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
        <rect x="10" y="14" width="44" height="36" rx="10" fill="#0f172a" />
        <path d="M22 23h20v6H22zm0 12h14v6H22z" fill="#f8fafc" />
        <circle cx="44" cy="38" r="4" fill="#f59e0b" />
      </svg>
    `)}`,
  );

const showWindow = (): void => {
  if (!mainWindow) {
    return;
  }

  if (!mainWindow.isVisible()) {
    mainWindow.show();
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  mainWindow.focus();
};

const normalizeLocalModelsDir = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Local models directory cannot be empty.");
  }

  const expanded =
    trimmed === "~"
      ? os.homedir()
      : trimmed.startsWith("~/")
        ? path.join(os.homedir(), trimmed.slice(2))
        : trimmed;

  return path.isAbsolute(expanded) ? expanded : path.resolve(appPaths.supportRoot, expanded);
};

const buildRuntimeContext = (): DesktopRuntimeContext => ({
  desktop: {
    closeToTray: desktopConfig.value.closeToTray,
    autoLaunchGateway: desktopConfig.value.autoLaunchGateway,
    theme: desktopConfig.value.theme,
    controlAuthHeaderName: desktopConfig.value.controlAuthHeaderName,
    ...(desktopConfig.value.controlAuthToken !== undefined
      ? { controlAuthToken: desktopConfig.value.controlAuthToken }
      : {}),
  },
  gateway: {
    enableLan: sharedGatewayConfig.value.enableLan,
    authRequired: sharedGatewayConfig.value.authRequired,
    publicHost: gatewayConfig.publicHost,
    controlHost: gatewayConfig.controlHost,
    corsAllowlist: [...gatewayConfig.corsAllowlist],
    defaultModelTtlMs: gatewayConfig.defaultModelTtlMs,
    localModelsDir: gatewayConfig.localModelsDir,
    controlAuthHeaderName: desktopConfig.value.controlAuthHeaderName,
    authConfigured: Boolean(gatewayConfig.controlBearerToken || gatewayConfig.publicBearerToken),
  },
  files: {
    desktopConfigFile: appPaths.desktopConfigFile,
    gatewayConfigFile: appPaths.gatewayConfigFile,
  },
});

const reloadGatewayConfig = (): void => {
  gatewayConfig = loadGatewayConfig({
    cwd: workspaceRoot,
    environment: runtimeEnvironment,
  });
  sharedGatewayConfig = loadPlatformGatewayConfig({
    cwd: workspaceRoot,
    environment: runtimeEnvironment,
  });
};

const reloadDesktopConfig = (): void => {
  desktopConfig = loadDesktopConfig({
    cwd: workspaceRoot,
    environment: runtimeEnvironment,
  });
};

const createWindow = async (): Promise<void> => {
  mainWindow = new BrowserWindow({
    width: 1460,
    height: 920,
    minWidth: 1180,
    minHeight: 760,
    backgroundColor: "#f4efe6",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    await mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    await mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
};

const createTray = (): void => {
  tray = new Tray(createTrayIcon());
  tray.setToolTip(APP_NAME);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "Show Desktop Shell",
        click: () => {
          showWindow();
        },
      },
      {
        label: "Quit",
        click: async () => {
          quitting = true;
          await gatewayManager.stop();
          app.quit();
        },
      },
    ]),
  );
  tray.on("click", () => {
    showWindow();
  });
};

const registerIpcHandlers = (): void => {
  ipcMain.handle(IPC_CHANNELS.shellGetState, () => gatewayManager.getState());
  ipcMain.handle(IPC_CHANNELS.gatewayListModels, () => gatewayManager.listModels());
  ipcMain.handle(IPC_CHANNELS.gatewayListModelLibrary, () => gatewayManager.listModelLibrary());
  ipcMain.handle(IPC_CHANNELS.gatewayGetHealth, () => gatewayManager.getHealth());
  ipcMain.handle(IPC_CHANNELS.gatewayListEngines, () => gatewayManager.listEngines());
  ipcMain.handle(IPC_CHANNELS.gatewayInstallEngineBinary, (_event, payload) =>
    gatewayManager.installEngineBinary(payload),
  );
  ipcMain.handle(IPC_CHANNELS.gatewayRegisterLocalModel, (_event, payload) =>
    gatewayManager.registerLocalModel(payload),
  );
  ipcMain.handle(IPC_CHANNELS.gatewayUpdateModelConfig, (_event, modelId: string, payload) =>
    gatewayManager.updateModelConfig(modelId, payload),
  );
  ipcMain.handle(IPC_CHANNELS.gatewayPreloadModel, (_event, modelId: string) =>
    gatewayManager.preloadModel(modelId),
  );
  ipcMain.handle(IPC_CHANNELS.gatewayEvictModel, (_event, modelId: string) =>
    gatewayManager.evictModel(modelId),
  );
  ipcMain.handle(IPC_CHANNELS.gatewayListChatSessions, () => gatewayManager.listChatSessions());
  ipcMain.handle(IPC_CHANNELS.gatewayListChatMessages, (_event, sessionId: string) =>
    gatewayManager.listChatMessages(sessionId),
  );
  ipcMain.handle(IPC_CHANNELS.gatewayUpsertChatSession, (_event, payload) =>
    gatewayManager.upsertChatSession(payload),
  );
  ipcMain.handle(IPC_CHANNELS.gatewayDeleteChatSession, (_event, sessionId: string) =>
    gatewayManager.deleteChatSession(sessionId),
  );
  ipcMain.handle(IPC_CHANNELS.gatewayRunChat, (_event, payload) => gatewayManager.runChat(payload));
  ipcMain.handle(IPC_CHANNELS.gatewayCancelChat, (_event, clientRequestId: string) =>
    gatewayManager.cancelChat(clientRequestId),
  );
  ipcMain.handle(IPC_CHANNELS.gatewayListApiLogs, (_event, limit?: number) =>
    gatewayManager.listApiLogs(limit),
  );
  ipcMain.handle(IPC_CHANNELS.gatewaySearchCatalog, (_event, query: string) =>
    gatewayManager.searchCatalog(query),
  );
  ipcMain.handle(
    IPC_CHANNELS.gatewayGetCatalogModel,
    (_event, provider: "huggingface" | "modelscope", providerModelId: string) =>
      gatewayManager.getCatalogModel(provider, providerModelId),
  );
  ipcMain.handle(IPC_CHANNELS.gatewayListDownloads, () => gatewayManager.listDownloads());
  ipcMain.handle(IPC_CHANNELS.gatewayCreateDownload, (_event, payload) =>
    gatewayManager.createDownload(payload),
  );
  ipcMain.handle(IPC_CHANNELS.gatewayPauseDownload, (_event, id: string) =>
    gatewayManager.pauseDownload(id),
  );
  ipcMain.handle(IPC_CHANNELS.gatewayResumeDownload, (_event, id: string) =>
    gatewayManager.resumeDownload(id),
  );
  ipcMain.handle(IPC_CHANNELS.gatewayRestart, () => gatewayManager.restart());
  ipcMain.handle(IPC_CHANNELS.gatewayShutdown, () => gatewayManager.shutdown());
  ipcMain.handle(IPC_CHANNELS.systemGetPaths, () => gatewayManager.paths);
  ipcMain.handle(
    IPC_CHANNELS.systemGetRuntimeContext,
    (): DesktopRuntimeContext => buildRuntimeContext(),
  );
  ipcMain.handle(IPC_CHANNELS.systemCopyPath, (_event, filePath: string) => {
    clipboard.writeText(filePath);
  });
  ipcMain.handle(IPC_CHANNELS.gatewayOpenModelsDirectoryDialog, async () => {
    const options = {
      title: "Choose a local models directory",
      properties: ["openDirectory"] as Array<"openDirectory">,
      filters: [],
    };

    return mainWindow ? dialog.showOpenDialog(mainWindow, options) : dialog.showOpenDialog(options);
  });
  ipcMain.handle(
    IPC_CHANNELS.systemUpdateModelsDirectory,
    async (_event, rawModelsDir: string): Promise<DesktopRuntimeContext> => {
      const modelsDir = normalizeLocalModelsDir(rawModelsDir);
      mkdirSync(modelsDir, { recursive: true });
      mkdirSync(path.dirname(sharedGatewayConfig.filePath), { recursive: true });
      writeConfigFile(sharedGatewayConfig.filePath, {
        ...sharedGatewayConfig.value,
        localModelsDir: modelsDir,
      });
      reloadGatewayConfig();
      await gatewayManager.restart();

      return buildRuntimeContext();
    },
  );
  ipcMain.handle(IPC_CHANNELS.systemRevealPath, async (_event, filePath: string) =>
    shell.showItemInFolder(filePath),
  );
  ipcMain.handle(
    IPC_CHANNELS.systemUpdateControlAuthSettings,
    async (
      _event,
      payload: { headerName: ControlAuthHeaderName; token?: string | undefined },
    ): Promise<DesktopRuntimeContext> => {
      if (
        payload.headerName !== "authorization" &&
        payload.headerName !== "x-api-key" &&
        payload.headerName !== "api-key"
      ) {
        throw new Error("Unsupported control auth header name.");
      }

      const controlAuthToken = payload.token?.trim();

      mkdirSync(path.dirname(desktopConfig.filePath), { recursive: true });
      writeConfigFile(desktopConfig.filePath, {
        ...desktopConfig.value,
        controlAuthHeaderName: payload.headerName,
        controlAuthToken:
          controlAuthToken && controlAuthToken.length > 0 ? controlAuthToken : undefined,
      });
      reloadDesktopConfig();
      await gatewayManager.restart();

      return buildRuntimeContext();
    },
  );
  ipcMain.handle(IPC_CHANNELS.gatewayOpenModelDialog, async () => {
    const options = {
      title: "Pick a local model artifact",
      properties: ["openFile"] as Array<"openFile">,
      filters: [
        {
          name: "Model Artifacts",
          extensions: ["gguf", "bin"],
        },
      ],
    };

    return mainWindow ? dialog.showOpenDialog(mainWindow, options) : dialog.showOpenDialog(options);
  });
  ipcMain.handle(IPC_CHANNELS.gatewayOpenEngineBinaryDialog, async () => {
    const options = {
      title: "Pick a llama.cpp binary or containing folder",
      properties: ["openFile", "openDirectory"] as Array<"openFile" | "openDirectory">,
      filters: [],
    };

    return mainWindow ? dialog.showOpenDialog(mainWindow, options) : dialog.showOpenDialog(options);
  });
};

const bootstrap = async (): Promise<void> => {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  app.on("second-instance", () => {
    showWindow();
  });

  app.on("activate", () => {
    showWindow();
  });

  await app.whenReady();
  Menu.setApplicationMenu(null);
  registerIpcHandlers();
  await createWindow();
  createTray();
  await gatewayManager.start();
};

app.on("before-quit", () => {
  quitting = true;
  void gatewayManager.stop();
});

app.on("window-all-closed", (event: ElectronEvent) => {
  if (!quitting) {
    event.preventDefault();
  }
});

void bootstrap().catch(async (error) => {
  console.error(error);
  quitting = true;
  await gatewayManager.stop();
  app.quit();
});
