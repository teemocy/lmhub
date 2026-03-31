import type {
  DesktopShellState,
  GatewayEvent,
  GatewayHealthSnapshot,
  PublicModelList,
} from "@localhub/shared-contracts";

type DesktopSystemPaths = {
  workspaceRoot: string;
  supportDir: string;
  discoveryFile: string;
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
    getHealth(): Promise<GatewayHealthSnapshot>;
    subscribeEvents(listener: (event: GatewayEvent) => void): Unsubscribe;
    openModelFileDialog(): Promise<FileDialogResult>;
  };
  system: {
    getPaths(): Promise<DesktopSystemPaths>;
  };
};

declare global {
  interface Window {
    desktopApi: DesktopApi;
  }
}
