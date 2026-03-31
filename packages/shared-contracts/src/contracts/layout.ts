export interface ArtifactDirectoryDescriptor {
  relativePath: string;
  purpose: string;
  retainedBetweenAppUpgrades: boolean;
}

export interface ArtifactLayoutSpec {
  version: "v1";
  directories: {
    engines: ArtifactDirectoryDescriptor;
    models: ArtifactDirectoryDescriptor;
    downloads: ArtifactDirectoryDescriptor;
    checksums: ArtifactDirectoryDescriptor;
    promptCaches: ArtifactDirectoryDescriptor;
    temp: ArtifactDirectoryDescriptor;
  };
  registryFiles: {
    engineVersions: string;
    modelArtifacts: string;
    downloadTasks: string;
  };
}

export const LOCAL_ARTIFACT_LAYOUT_SPEC: ArtifactLayoutSpec = {
  version: "v1",
  directories: {
    engines: {
      relativePath: "engines",
      purpose: "Installed engine versions, active-version links, and manifests.",
      retainedBetweenAppUpgrades: true,
    },
    models: {
      relativePath: "models",
      purpose: "Registered local model artifacts and sidecar metadata.",
      retainedBetweenAppUpgrades: true,
    },
    downloads: {
      relativePath: "downloads",
      purpose: "In-progress, paused, and resumable download state.",
      retainedBetweenAppUpgrades: true,
    },
    checksums: {
      relativePath: "checksums",
      purpose: "Computed checksum records and verification outputs.",
      retainedBetweenAppUpgrades: true,
    },
    promptCaches: {
      relativePath: "prompt-caches",
      purpose: "Prompt-cache artifacts addressed by runtime key.",
      retainedBetweenAppUpgrades: false,
    },
    temp: {
      relativePath: "tmp",
      purpose: "Temporary extraction, staging, and repair workspaces.",
      retainedBetweenAppUpgrades: false,
    },
  },
  registryFiles: {
    engineVersions: "engines/registry.json",
    modelArtifacts: "models/registry.json",
    downloadTasks: "downloads/tasks.json",
  },
};
