import type {
  ArtifactChecksum,
  GgufArchitectureMetadata,
  ModelArtifactFormat,
} from "./artifacts.js";

export const PROVIDER_IDS = ["huggingface", "modelscope"] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

export type ProviderSearchSort = "downloads" | "likes" | "updated";

export interface ProviderSearchQuery {
  text: string;
  formats: ModelArtifactFormat[];
  limit: number;
  cursor?: string;
  tags?: string[];
  sort?: ProviderSearchSort;
}

export interface ProviderArtifactDescriptor {
  artifactId: string;
  fileName: string;
  format: ModelArtifactFormat;
  sizeBytes?: number;
  architecture?: string;
  quantization?: string;
  checksum?: ArtifactChecksum;
  downloadUrl?: string;
  metadata?: Partial<GgufArchitectureMetadata>;
}

export interface ProviderModelSummary {
  provider: ProviderId;
  providerModelId: string;
  title: string;
  author?: string;
  repositoryUrl: string;
  tags: string[];
  formats: ModelArtifactFormat[];
  artifacts: ProviderArtifactDescriptor[];
  license?: string;
  downloads?: number;
  likes?: number;
  updatedAt?: string;
  description?: string;
}

export interface ProviderSearchResult {
  items: ProviderModelSummary[];
  nextCursor?: string;
  warnings: string[];
  sourceLatencyMs?: number;
}

export interface ProviderDownloadRequest {
  provider: ProviderId;
  providerModelId: string;
  artifactId: string;
  destinationPath: string;
  preferredChunkBytes?: number;
  resumeFromByte?: number;
}

export interface ProviderDownloadPlan {
  provider: ProviderId;
  artifactId: string;
  url: string;
  headers: Record<string, string>;
  fileName: string;
  checksum?: ArtifactChecksum;
  supportsRange: boolean;
  estimatedSizeBytes?: number;
}

export interface ModelProvider {
  readonly id: ProviderId;
  search(query: ProviderSearchQuery): Promise<ProviderSearchResult>;
  resolveDownload(request: ProviderDownloadRequest): Promise<ProviderDownloadPlan>;
}
