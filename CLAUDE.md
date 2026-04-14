# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

LM Hub — a pnpm workspace monorepo providing a desktop-managed local LLM stack. An Electron shell wraps a Fastify gateway daemon that orchestrates llama.cpp model loading, chat, downloads, and exposes an OpenAI-compatible public API alongside a loopback-only control plane.

## Common Commands

```bash
pnpm install                  # Install all workspace dependencies
pnpm dev                      # Start desktop app in dev mode (spawns gateway)
pnpm build                    # Build all workspace packages
pnpm lint                     # Biome lint + format check
pnpm typecheck                # TypeScript strict checks via project references
pnpm test                     # Vitest (all workspace tests)
pnpm validate                 # CI gate: lint → typecheck → test → build
pnpm format                   # Auto-format with Biome

# Gateway-only development
pnpm --filter @localhub/gateway dev

# Database
pnpm db:migrate:plan          # Preview pending migrations
pnpm db:migrate               # Apply migrations with backup

# Packaging
pnpm package:desktop:macos    # Build macOS .app bundle
pnpm notarize:desktop:macos   # Sign and notarize for macOS
```

Run a single test file:
```bash
pnpm vitest run packages/db/src/repos/model-repo.test.ts
```

## Workspace Layout

| Package | Purpose |
|---|---|
| `apps/desktop` | Electron main process, preload bridge, React renderer |
| `services/gateway` | Fastify daemon — public API + control plane + runtime supervisor |
| `packages/shared-contracts` | Zod schemas and stable TypeScript contract types |
| `packages/platform` | Cross-platform config, app-paths, discovery, logging, security |
| `packages/db` | SQLite migration runner, repositories, fixtures |
| `packages/engine-core` | Stable engine adapter interfaces |
| `packages/engine-llama` | llama.cpp model manager, downloads, GGUF parsing, worker harness |
| `packages/ui` | Shared desktop UI tokens and shell metadata |

## Architecture

### Dual-Listener Gateway

The gateway exposes two HTTP listeners:
- **Public listener** (`127.0.0.1:1337` by default): OpenAI-compatible `/v1/models`, `/v1/chat/completions`, `/v1/embeddings`, `/healthz`, configurable through `config/gateway.json` or `LOCAL_LLM_HUB_GATEWAY_PUBLIC_HOST` / `LOCAL_LLM_HUB_GATEWAY_PUBLIC_PORT`
- **Control listener** (`127.0.0.1:16384`): Loopback-only `/control/*` routes for model lifecycle, chat sessions, downloads, engines, and WebSocket telemetry events

### Desktop ↔ Gateway

The Electron main process spawns the gateway as a child process, communicates over HTTP/WebSocket to the control API, and exposes renderer IPC through a context-isolated preload bridge. The renderer is a React SPA using React Router with screens for Dashboard, Models, Chat, Downloads, and Settings.

### Data Flow

```
Desktop Renderer → IPC (preload) → Main Process → Control API → Repositories → SQLite
                                                              → Engine Core → llama.cpp workers
```

### WebSocket Events

Gateway publishes real-time events: `MODEL_STATE_CHANGED`, `LOG_STREAM`, `METRICS_TICK`, `REQUEST_TRACE`.

## Import Boundaries (Enforced)

Dependency flow is strictly layered:
- `shared-contracts` — pure data contracts, no framework deps
- `platform` → `shared-contracts`
- `db` → `shared-contracts`
- `engine-core` → `shared-contracts`
- `engine-llama` → `engine-core`, `shared-contracts`
- `gateway` → `shared-contracts`, `platform`, `db`, `engine-core`
- `desktop` → `shared-contracts`, `platform`, `ui`

Cross-package dependencies must not skip layers or introduce cycles.

## Key Conventions

- **Formatter**: Biome, 2-space indent, 100-char line width
- **Linter**: Biome recommended + `noExplicitAny: error` + `useNodejsImportProtocol: error`
- **Node imports**: Always use `node:` protocol prefix (e.g., `import fs from "node:fs"`)
- **TypeScript**: Strict mode with project references; each package has its own `tsconfig.json`
- **Database migrations**: Forward-only, placed in `packages/db/migrations/`, prefixed with zero-padded version (`0004_add_worker_stats.sql`). Never modify shipped migrations.
- **Config precedence**: Package defaults → JSON config file → environment variable override
- **Runtime precedence**: Engine defaults → GGUF metadata → saved model profile → per-request overrides
- **Shared contracts**: Changes must be additive; require review before downstream usage expands

## Environment Variables

- `LOCAL_LLM_HUB_ENV`: `development` | `packaged` | `test`
- `LOCAL_LLM_HUB_APP_SUPPORT_DIR`: Override root app-support directory
- `LOCAL_LLM_HUB_GATEWAY_PUBLIC_HOST`: Override public listener host
- `LOCAL_LLM_HUB_GATEWAY_PUBLIC_PORT`: Override public listener port
- `LOCAL_LLM_HUB_GATEWAY_CONTROL_PORT`: Override control listener port
- `LOCAL_LLM_HUB_AUTH_REQUIRED`: Enable bearer token auth. Requests may send the token as
  `Authorization: Bearer ...`, `x-api-key`, or `api-key`.
- `LOCAL_LLM_HUB_ENABLE_LAN`: Allow network access beyond loopback

Dev mode uses `.local/lm-hub/dev/` as the support directory; packaged mode uses the OS-specific Application Support directory. Legacy `local-llm-hub` folders migrate automatically on launch.
