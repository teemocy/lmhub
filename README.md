# LM Hub Workspace

This repository contains the LM Hub desktop shell, gateway daemon, shared contracts, and runtime support packages. The current workspace supports a desktop-managed local LLM stack with model registration, downloads, chat persistence, observability, OpenAI-compatible public routes, and a loopback-only control plane.

## Workspace layout

- `apps/desktop`: Electron shell, preload bridge, and React renderer owned by Desktop & UX.
- `services/gateway`: Fastify gateway, control plane, and runtime supervisor owned by Gateway & Runtime.
- `packages/shared-contracts`: Shared Zod schemas and stable contract types.
- `packages/platform`: Shared config, app-paths, discovery, logging, and security helpers.
- `packages/db`: SQLite migration runner, repositories, fixtures, and retention utilities.
- `packages/engine-core`: Stable runtime adapter interfaces.
- `packages/engine-llama`: `llama.cpp` model manager, download flows, and worker harness.
- `packages/ui`: Shared desktop UI tokens and shell metadata.

## Getting started

```bash
pnpm install
pnpm dev
```

For a full setup, deployment, and user walkthrough, see [docs/design-deployment-user-guide.md](./docs/design-deployment-user-guide.md).

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

The platform package resolves a deterministic dev layout inside `.local/lm-hub/dev` and a packaged layout inside the OS application support directory, migrating legacy `local-llm-hub` folders on first launch.

## Documentation

- [Design, Deployment, and User Guide](./docs/design-deployment-user-guide.md)
- [Release Readiness](./docs/release-readiness.md)
- [Config Precedence](./docs/config-precedence.md)
- [Package Ownership](./docs/package-ownership.md)

## Governance

Contract, schema, config, and package-boundary rules live in [docs/package-ownership.md](./docs/package-ownership.md).
