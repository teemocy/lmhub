# Thread 3 Stage 0 Contract Freeze

This document freezes the engine and model-management surface owned by Thread 3 before any real runtime wiring begins.

## Published Packages
- `packages/shared-contracts`: canonical engine, model, provider, GGUF, and artifact-layout types.
- `packages/engine-core`: engine-facing package boundary for runtime consumers.
- `packages/engine-llama`: `llama.cpp` family marker and Stage 1 implementation handoff notes.

## Engine Adapter Boundary
The adapter contract is intentionally small and stable:

| Method | Responsibility | Explicitly out of scope in Stage 0 |
| --- | --- | --- |
| `probe` | detect supported/installed engine versions and platform readiness | launching long-lived workers |
| `install` | register or install an engine artifact/version | silent activation side effects outside the return value |
| `resolveCommand` | produce executable path, argv, cwd, env, and ready-signal metadata | spawning processes |
| `healthCheck` | evaluate worker readiness and health after launch | mutating registry state |
| `normalizeResponse` | translate raw engine payloads into the shared OpenAI-style envelope | transport retry logic |
| `capabilities` | derive a capability set from the artifact/profile pair | adding UI-only inferred flags |

## GGUF and Model Metadata
The shared contracts freeze:
- `GgufHeaderInfo`, `GgufArchitectureMetadata`, and `GgufMetadata`.
- `ModelArtifact` for local/provider-backed artifact registration.
- `ModelProfile` for runtime defaults and user overrides.
- `RuntimeFacingModelMetadata` as the minimum stable metadata surface for gateway and UI consumers.

## Provider Boundary
Stage 0 only locks the normalized abstraction:
- `search(query)` returns provider-normalized summaries and artifact descriptors.
- `resolveDownload(request)` returns a concrete download plan, checksum hints, and range support.
- Real network IO, retries, resumable state, and progress reporting remain Stage 3 work.

## Local Artifact Layout
Thread 3 owns the artifact directory contract below the app-support root:

| Directory | Purpose |
| --- | --- |
| `engines/` | installed engine versions and version registries |
| `models/` | registered local model artifacts and sidecar metadata |
| `downloads/` | in-progress and resumable download state |
| `checksums/` | computed checksum records and verification outputs |
| `prompt-caches/` | prompt-cache artifacts addressed by runtime key |
| `tmp/` | temporary extraction and repair workspaces |

Registry files are also frozen:
- `engines/registry.json`
- `models/registry.json`
- `downloads/tasks.json`

## Minimal Metadata Required by Gateway and UI
`RuntimeFacingModelMetadata` is the Stage 1 and Stage 2 handoff shape. Consumers should not invent additional required fields beyond:
- identity: `artifactId`, `profileId`, `displayName`
- runtime routing: `engineFamily`, `capabilities`, `localPath`
- presentation: `provider`, `format`, `sizeBytes`, `quantization`, `architecture`
- safety/state: `state`, `checksumStatus`, `contextLength`, `embeddingLength`

## Fixtures
Example payloads live in `packages/shared-contracts/fixtures/`:
- `engine-probe.sample.json`
- `gguf-metadata.sample.json`
- `model-artifact.sample.json`
- `provider-search.sample.json`

These fixtures are contract-test inputs for Threads 2 and 4, not implementation fixtures for production logic.
