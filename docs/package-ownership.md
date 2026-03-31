# Package Ownership and Contract Governance

## Thread ownership

- Thread 1 owns workspace structure, package boundaries, shared contracts, config precedence, migrations, repositories, and release automation.
- Thread 2 owns `services/gateway` behavior and may only depend on shared contracts, platform helpers, engine contracts, and repository interfaces.
- Thread 3 owns `packages/engine-core` and `packages/engine-llama` implementations plus external artifact handling behind the published contracts.
- Thread 4 owns `apps/desktop` and `packages/ui`, consuming only the published desktop, discovery, and gateway contracts.

## Stable import boundaries

- `packages/shared-contracts` must remain pure data contracts and schema validators.
- `packages/platform` may depend on `packages/shared-contracts` but not on gateway, desktop, or engine implementations.
- `packages/db` may depend on `packages/shared-contracts` only; repositories are the persistence boundary for services and apps.
- `packages/engine-core` may depend on `packages/shared-contracts` only.
- `packages/engine-llama` may depend on `packages/engine-core` and `packages/shared-contracts`.
- `packages/ui` may depend on `packages/shared-contracts` only.
- `services/gateway` may depend on `shared-contracts`, `platform`, `db`, and `engine-core`.
- `apps/desktop` may depend on `shared-contracts`, `platform`, and `ui`.

## Change control rules

- Shared contract changes must be additive by default and require Thread 1 review before downstream usage expands.
- Database migrations are forward-only. Existing migration files are immutable after merge; follow-up fixes must ship as new numbered migrations.
- Config precedence is fixed as defaults < config file < environment overrides.
- Runtime precedence remains engine defaults < GGUF metadata < saved model profile overrides < allowed per-request overrides.
- Shared filesystem layout changes must preserve deterministic paths for discovery files, logs, downloads, engines, and prompt caches.

## Review checklist

- Does the change introduce a new cross-package dependency that can be avoided?
- Does it modify a shared schema without a matching version or migration story?
- Does it require a config default, environment override, and doc update together?
- Does it keep public `/v1/*`, localhost control routes, and desktop preload boundaries clearly separated?

## Migration conventions

- Place migrations in `packages/db/migrations`.
- Prefix migration files with a zero-padded numeric version such as `0004_add_worker_stats.sql`.
- Keep each migration idempotent with `IF NOT EXISTS` where reasonable, but never mutate previously shipped migration files.
- Record applied migrations in the `schema_migrations` table with a checksum for drift detection.
