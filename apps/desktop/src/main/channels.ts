export const IPC_CHANNELS = {
  shellGetState: "shell:get-state",
  shellStateChanged: "shell:state-changed",
  gatewayListModels: "gateway:list-models",
  gatewayGetHealth: "gateway:get-health",
  gatewayEvent: "gateway:event",
  gatewayOpenModelDialog: "gateway:open-model-dialog",
  systemGetPaths: "system:get-paths",
} as const;
