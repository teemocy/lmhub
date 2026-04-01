import path from "node:path";
import {
  BrowserWindow,
  type Event as ElectronEvent,
  Menu,
  Tray,
  app,
  dialog,
  ipcMain,
  nativeImage,
} from "electron";
import { IPC_CHANNELS } from "./channels";
import { GatewayManager } from "./gateway-manager";

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

const gatewayManager = new GatewayManager();

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

const createWindow = async (): Promise<void> => {
  mainWindow = new BrowserWindow({
    width: 1460,
    height: 920,
    minWidth: 1180,
    minHeight: 760,
    backgroundColor: "#f4efe6",
    titleBarStyle: "hiddenInset",
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
  tray.setToolTip("Local LLM Hub");
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
  ipcMain.handle(IPC_CHANNELS.gatewayRegisterLocalModel, (_event, payload) =>
    gatewayManager.registerLocalModel(payload),
  );
  ipcMain.handle(IPC_CHANNELS.gatewayPreloadModel, (_event, modelId: string) =>
    gatewayManager.preloadModel(modelId),
  );
  ipcMain.handle(IPC_CHANNELS.gatewayEvictModel, (_event, modelId: string) =>
    gatewayManager.evictModel(modelId),
  );
  ipcMain.handle(IPC_CHANNELS.systemGetPaths, () => gatewayManager.paths);
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
