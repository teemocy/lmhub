export const preloadBridgeContract = {
  version: 1,
  channels: [
    "gateway:discovery",
    "gateway:subscribe-events",
    "gateway:list-model-library",
    "gateway:register-local-model",
    "gateway:delete-registered-model",
    "gateway:update-model-config",
    "gateway:preload-model",
    "gateway:evict-model",
    "gateway:delete-chat-session",
    "gateway:restart",
    "gateway:shutdown",
    "gateway:get-catalog-model",
    "system:update-control-auth-header-name",
  ] as const,
};

export type PreloadBridgeChannel = (typeof preloadBridgeContract.channels)[number];
