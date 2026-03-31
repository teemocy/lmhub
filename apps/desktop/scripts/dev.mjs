import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import waitOn from "wait-on";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const desktopDir = path.resolve(__dirname, "..");
const workspaceRoot = path.resolve(desktopDir, "../..");
const children = [];
let shuttingDown = false;

const start = (command, args, cwd, extraEnv = {}) => {
  const child = spawn(command, args, {
    cwd,
    stdio: "inherit",
    env: {
      ...process.env,
      ...extraEnv,
    },
  });

  children.push(child);

  child.on("exit", (code) => {
    if (!shuttingDown && code && code !== 0) {
      shuttingDown = true;
      for (const current of children) {
        current.kill("SIGTERM");
      }
      process.exit(code);
    }
  });

  return child;
};

const stop = () => {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  for (const child of children) {
    child.kill("SIGTERM");
  }
};

process.on("SIGINT", stop);
process.on("SIGTERM", stop);

start("pnpm", ["--filter", "@localhub/shared-contracts", "dev"], workspaceRoot);
start("pnpm", ["--filter", "@localhub/platform", "build", "--", "--watch"], workspaceRoot);
start("pnpm", ["--filter", "@localhub/ui", "build", "--", "--watch"], workspaceRoot);
start("pnpm", ["--filter", "@localhub/gateway", "build", "--", "--watch"], workspaceRoot);
start("pnpm", ["run", "build:main", "--", "--watch"], desktopDir);
start("pnpm", ["exec", "vite"], desktopDir, { BROWSER: "none" });

await waitOn({
  resources: [
    `file:${path.join(workspaceRoot, "packages/shared-contracts/dist/index.js")}`,
    `file:${path.join(workspaceRoot, "packages/platform/dist/index.js")}`,
    `file:${path.join(workspaceRoot, "packages/ui/dist/index.js")}`,
    `file:${path.join(workspaceRoot, "services/gateway/dist/index.js")}`,
    `file:${path.join(desktopDir, "dist-electron/main.js")}`,
    `file:${path.join(desktopDir, "dist-electron/preload.js")}`,
    "http-get://127.0.0.1:5173",
  ],
  timeout: 60_000,
});

const electron = start("pnpm", ["exec", "electron", "."], desktopDir, {
  VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
});

electron.on("exit", () => {
  stop();
});
