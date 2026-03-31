import { rmSync } from "node:fs";
import { resolveAppPaths } from "@localhub/platform";
import { loadGatewayConfig } from "./config.js";
import { startGateway } from "./server/app.js";

const config = loadGatewayConfig();
const appPaths = resolveAppPaths({
  cwd: process.cwd(),
});
const gateway = await startGateway(config);

console.info(`[gateway] public listener ready at ${gateway.publicAddress}`);
console.info(`[gateway] control listener ready at ${gateway.controlAddress}`);

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.info(`[gateway] shutting down on ${signal}`);
  await gateway.stop();
  rmSync(appPaths.discoveryFile, {
    force: true,
  });
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown(signal);
  });
}

process.once("exit", () => {
  rmSync(appPaths.discoveryFile, {
    force: true,
  });
});
