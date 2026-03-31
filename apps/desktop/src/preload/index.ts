export const preloadBridgeContract = {
  version: 1,
  channels: ["gateway:discovery", "gateway:subscribe-events", "gateway:shutdown"] as const,
};

export type PreloadBridgeChannel = (typeof preloadBridgeContract.channels)[number];
