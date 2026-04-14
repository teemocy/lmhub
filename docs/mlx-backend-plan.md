# Apple Silicon MLX Backend Plan

This document captures the current implementation plan for adding an `mlx` backend to LM Hub.

## Goal

Add a real `mlx` engine path for Apple Silicon macOS while keeping the existing `llama.cpp` and GGUF workflows stable.

The intended user-facing outcome is:

- GGUF models keep running through `llama.cpp`
- MLX-native models can be discovered, downloaded, registered, and served through a managed MLX runtime
- the app manages the MLX runtime installation the same way it already manages `llama.cpp` installs, without requiring the user to set up Python manually

## Current Design Findings

The current workspace is already partially prepared for a second engine family, but the actual behavior is still `llama.cpp`-only.

- Shared contracts already accept `engineType: "mlx"` and `format: "mlx"`.
- The gateway runtime currently instantiates a single adapter and a single model manager, both from `packages/engine-llama`.
- Local model registration and startup auto-discovery are GGUF-only.
- Provider discovery and download detail building are GGUF-only.
- The desktop engine UI is written around Metal `llama.cpp` binary installs.
- The repo does not currently contain Python or MLX runtime provisioning.

## Upstream Packaging Constraint

As of 2026-04-09, upstream MLX serving is published as Python packages, not as a standalone `llama-server`-style binary.

- Official MLX-LM serving uses `mlx_lm.server`.
- `mlx-lm` is distributed on PyPI as a wheel.
- `mlx` is distributed on PyPI as platform-specific wheels, including macOS ARM64.
- The official `mlx-lm` GitHub releases page does not provide a dedicated standalone server executable comparable to `llama-server`.

Because of that, the implementation should mirror the current `llama.cpp` installer operationally, but stage a managed MLX runtime environment instead of downloading one binary.

Reference links:

- https://github.com/ml-explore/mlx-lm/releases
- https://raw.githubusercontent.com/ml-explore/mlx-lm/main/mlx_lm/SERVER.md
- https://pypi.org/project/mlx-lm/
- https://pypi.org/project/mlx/

## Implementation Plan

### 1. Managed MLX Runtime Installer

Add a new `packages/engine-mlx` workspace package.

It should own:

- MLX runtime install, activation, and probe logic
- MLX command resolution for worker launches
- MLX model-directory sniffing and registration
- MLX response normalization where needed

The installer should follow the same lifecycle as the current `llama.cpp` installer:

- install into `engines/mlx/versions/<versionTag>/`
- persist an engine manifest and activation state
- expose installed and active versions through the existing engine registry model

Instead of a single binary, each installed MLX version should contain:

- a managed Python runtime for macOS ARM64
- pinned `mlx` and `mlx-lm` wheel installs
- a manifest that records Python version, package versions, executable path, install timestamp, and compatibility notes

The desktop should expose this as a managed install flow for the `mlx` engine family rather than a local-binary import flow.

### 2. Multi-Engine Gateway Dispatch

Refactor the repository-backed gateway runtime so it no longer assumes a single global adapter.

Key changes:

- dispatch by `profile.engineType`
- keep one adapter per engine family
- keep engine-specific model managers
- store the resolved adapter on each managed worker

Worker launch, health checks, shutdown, response normalization, and persisted engine records must use the worker's actual engine family.

The MLX adapter should launch workers with the managed Python runtime and `-m mlx_lm.server`.

For local model directories, pass the model path relative to the worker `cwd`, because upstream MLX-LM expects local model paths relative to the directory where the server starts.

MLX readiness should be checked via its OpenAI-compatible HTTP surface rather than assuming the `llama.cpp` health endpoints.

### 3. Local Model Registration and Discovery

Keep the current GGUF path unchanged:

- GGUF file -> `engineType: "llama.cpp"`, `format: "gguf"`

Add a parallel MLX path on Apple Silicon macOS:

- MLX model directory -> `engineType: "mlx"`, `format: "mlx"`

MLX local discovery should detect model directories by required runtime files such as:

- `config.json`
- tokenizer assets
- one or more safetensor shard files or shard indexes

Registration should capture at least:

- display name
- local directory path
- total model size
- model architecture when recoverable from config
- context length when recoverable from config

MLX capability defaults for the first pass should be conservative:

- `chat: true`
- `streaming: true`
- `embeddings: false`
- `rerank: false`
- `vision: false`
- `audioTranscription: false`
- `audioSpeech: false`

### 4. Provider Search, Catalog Detail, and Downloads

Provider search should stay GGUF-first on unsupported systems and expand to GGUF plus MLX on Apple Silicon macOS.

Provider detail building must stop assuming every supported artifact is a GGUF file.

For MLX repositories:

- treat the runtime payload as a bundle of files, not one artifact
- group runtime files into a single download variant
- auto-register the completed directory root, not an individual file

The MLX bundle allowlist should cover runtime-relevant files such as:

- `config.json`
- `generation_config.json`
- `tokenizer*`
- `special_tokens_map.json`
- `preprocessor_config.json`
- `chat_template.jinja`
- `*.safetensors`
- `*.safetensors.index.json`
- `merges.txt`
- `vocab.json`
- `*.tiktoken`
- `quant_strategy.json`

The existing bundle metadata path in downloads should be extended so the completed primary task can register an MLX directory root directly.

On supported Macs, when both GGUF and MLX variants exist for the same model family, the desktop should prefer the MLX variant by default while still allowing the user to pick GGUF explicitly.

### 5. Desktop Contracts and UX

Promote the desktop runtime-context shape into shared contracts instead of repeating it separately in main, preload, and renderer.

The runtime context should include:

- OS
- architecture
- whether MLX is supported
- whether MLX is installed
- an optional status or error message for MLX availability

Desktop UX changes:

- local model import should allow directories when MLX is supported
- downloads copy should become format-agnostic instead of GGUF-specific
- engine management should show `mlx` as a first-class engine family
- `llama.cpp` binary import controls should stay scoped to `llama.cpp`

For MLX-registered models, keep only cross-engine model settings visible:

- alias
- pinned state
- TTL
- shared capability overrides

Hide or disable llama-specific cold-start controls for MLX models, including:

- batch size
- GPU layers
- parallel slots
- flash attention mode
- context override

## Testing Plan

Add or update tests in these layers:

- installer tests for MLX version install, activation, and probe behavior
- model-manager tests for MLX directory detection and registration
- download tests for MLX multi-file bundle completion and directory-root auto-registration
- gateway runtime tests for MLX chat request handling
- gateway runtime tests that MLX models reject embeddings cleanly
- desktop tests for Apple Silicon gating and MLX engine install state
- regression tests for existing `llama.cpp` flows

## Acceptance Criteria

The work is complete when all of the following are true:

- Apple Silicon macOS can install and activate an MLX runtime without manual Python setup
- a local MLX model directory can be imported and registered
- a provider-hosted MLX model bundle can be downloaded and auto-registered
- MLX models can answer chat requests through the gateway
- GGUF and `llama.cpp` behavior remains unchanged
- unsupported MLX features fail with explicit, user-readable messages rather than silent fallbacks

## Non-Goals for the First Pass

- Intel Mac support
- in-app GGUF-to-MLX conversion
- embeddings on MLX unless upstream support is explicitly verified and implemented
- rerank, vision, or audio routes on MLX
- unofficial third-party MLX server binaries
