# Release Readiness

This document is the short operational checklist for cutting a macOS desktop release. For the full design, deployment, and end-user walkthrough, see [design-deployment-user-guide.md](./design-deployment-user-guide.md).

## Desktop packaging

1. Install dependencies:
   `pnpm install`
2. Build the workspace:
   `pnpm build`
3. Package the app bundle:
   `pnpm package:desktop:macos`
4. Inspect the generated output under `release/macos/`.

The packaging flow now stages:

- desktop renderer assets
- Electron main and preload output
- the gateway runtime build
- workspace package runtime dependencies
- the pnpm store entries needed by the packaged app's preserved symlinks

If packaging fails because the Electron app template is missing, make sure `apps/desktop/node_modules/electron/dist/Electron.app` exists after `pnpm install`.

## Signing and notarization

The macOS signing and notarization flow requires:

- `APPLE_SIGNING_IDENTITY`
- `APPLE_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`
- `APPLE_TEAM_ID`

Run:

`pnpm notarize:desktop:macos`

The notarization script now performs the full release path:

1. deep-sign the `.app` with hardened runtime
2. verify the signature with `codesign --verify`
3. archive the app with `ditto`
4. submit to Apple with `xcrun notarytool submit --wait`
5. staple the ticket with `xcrun stapler`
6. verify the final artifact with `spctl`

The CI workflow at `.github/workflows/release-desktop.yml` follows the same path and uploads the signed bundle from `release/macos/`.

## Migration safety

Before shipping an upgrade against an existing database:

1. Print the migration safety plan:
   `pnpm db:migrate:plan /absolute/path/to/gateway.sqlite`
2. If pending migrations exist, create a backup and apply them:
   `pnpm db:migrate --backup /absolute/path/to/gateway.sqlite`

Important behavior:

- the plan reports current version, target version, pending migrations, and whether a backup is recommended
- `--backup` now creates the backup before migrations are applied
- the backup path is produced using a WAL-safe SQLite snapshot strategy

## Release checklist

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- `pnpm db:migrate:plan`
- `pnpm package:desktop:macos`
- `pnpm notarize:desktop:macos`
- confirm the final artifact exists under `release/macos/`
- confirm the release machine or CI job uses the intended Apple credentials

## Notes

- Release artifacts are produced on macOS only.
- Existing databases should always be backed up before applying pending migrations during an upgrade.
- Release candidates are blocked if migration drift is detected in `schema_migrations`.
