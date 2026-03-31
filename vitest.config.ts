import path from "node:path";
import { defineConfig } from "vitest/config";

const workspaceRoot = path.resolve(import.meta.dirname);

export default defineConfig({
  resolve: {
    alias: [
      {
        find: "@localhub/shared-contracts/foundation-common",
        replacement: path.resolve(workspaceRoot, "packages/shared-contracts/src/common.ts"),
      },
      {
        find: "@localhub/shared-contracts/foundation-config",
        replacement: path.resolve(workspaceRoot, "packages/shared-contracts/src/config.ts"),
      },
      {
        find: "@localhub/shared-contracts/foundation-events",
        replacement: path.resolve(workspaceRoot, "packages/shared-contracts/src/events.ts"),
      },
      {
        find: "@localhub/shared-contracts/foundation-models",
        replacement: path.resolve(workspaceRoot, "packages/shared-contracts/src/models.ts"),
      },
      {
        find: "@localhub/shared-contracts/foundation-openai",
        replacement: path.resolve(workspaceRoot, "packages/shared-contracts/src/openai.ts"),
      },
      {
        find: "@localhub/shared-contracts/foundation-persistence",
        replacement: path.resolve(workspaceRoot, "packages/shared-contracts/src/persistence.ts"),
      },
      {
        find: "@localhub/shared-contracts/foundation-request-tracing",
        replacement: path.resolve(
          workspaceRoot,
          "packages/shared-contracts/src/request-tracing.ts",
        ),
      },
      {
        find: "@localhub/shared-contracts/foundation-runtime",
        replacement: path.resolve(workspaceRoot, "packages/shared-contracts/src/runtime.ts"),
      },
      {
        find: /^@localhub\/shared-contracts$/,
        replacement: path.resolve(workspaceRoot, "packages/shared-contracts/src/index.ts"),
      },
      {
        find: "@localhub/platform",
        replacement: path.resolve(workspaceRoot, "packages/platform/src/index.ts"),
      },
      {
        find: "@localhub/db",
        replacement: path.resolve(workspaceRoot, "packages/db/src/index.ts"),
      },
      {
        find: "@localhub/engine-core",
        replacement: path.resolve(workspaceRoot, "packages/engine-core/src/index.ts"),
      },
      {
        find: "@localhub/engine-llama",
        replacement: path.resolve(workspaceRoot, "packages/engine-llama/src/index.ts"),
      },
      {
        find: "@localhub/ui",
        replacement: path.resolve(workspaceRoot, "packages/ui/src/index.ts"),
      },
    ],
  },
  test: {
    environment: "node",
    include: [
      "apps/**/*.test.ts",
      "services/**/*.test.ts",
      "services/**/test/**/*.test.ts",
      "packages/**/*.test.ts",
    ],
  },
});
