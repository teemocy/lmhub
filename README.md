# Local LLM Hub Workspace

This repository now starts from a buildable TypeScript monorepo foundation for the Local LLM Hub platform. The focus of this pass is Thread 1 ownership: workspace scaffolding, shared contracts, config and discovery conventions, SQLite migrations and repositories, and validation automation.

## Workspace layout

- `apps/desktop`: Electron shell scaffold owned by Desktop & UX.
- `services/gateway`: Fastify gateway scaffold owned by Gateway & Runtime.
- `packages/shared-contracts`: Shared Zod schemas and stable contract types.
- `packages/platform`: Shared config, app-paths, discovery, logging, and security helpers.
- `packages/db`: SQLite migration runner, repositories, fixtures, and retention utilities.
- `packages/engine-core`: Stable runtime adapter interfaces.
- `packages/engine-llama`: `llama.cpp` adapter placeholder built on the engine contract.
- `packages/ui`: Shared desktop UI tokens and shell placeholders.

## Getting started

```bash
pnpm install
pnpm build
pnpm test
pnpm db:migrate
```

## Validation scripts

- `pnpm lint`: Biome lint and formatting checks.
- `pnpm typecheck`: strict TypeScript project-reference build.
- `pnpm test`: Vitest contract, platform, and repository tests.
- `pnpm build`: emits build artifacts for every workspace package.
- `pnpm validate`: runs lint, typecheck, test, and build in CI order.

## Environment conventions

- `LOCAL_LLM_HUB_ENV`: `development`, `packaged`, or `test`.
- `LOCAL_LLM_HUB_APP_SUPPORT_DIR`: override the root app-support directory for both desktop and gateway.
- `LOCAL_LLM_HUB_GATEWAY_CONFIG_FILE`: override the gateway JSON config file path.
- `LOCAL_LLM_HUB_DESKTOP_CONFIG_FILE`: override the desktop JSON config file path.
- `LOCAL_LLM_HUB_GATEWAY_PUBLIC_PORT`: override the public listener port.
- `LOCAL_LLM_HUB_GATEWAY_CONTROL_PORT`: override the control listener port.

The platform package resolves a deterministic dev layout inside `.local/local-llm-hub/dev` and a packaged layout inside the OS application support directory.

## Governance

Contract, schema, config, and package-boundary rules live in [docs/package-ownership.md](/Users/timocy/Tools/Antigravity/llama-cpp-ui/docs/package-ownership.md).
