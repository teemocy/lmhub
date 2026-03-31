import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import {
  type GatewayDiscoveryFile,
  gatewayDiscoveryFileSchema,
} from "@localhub/shared-contracts/foundation-config";

export function readGatewayDiscoveryFile(filePath: string): GatewayDiscoveryFile | null {
  if (!existsSync(filePath)) {
    return null;
  }

  return gatewayDiscoveryFileSchema.parse(JSON.parse(readFileSync(filePath, "utf8")));
}

export function writeGatewayDiscoveryFile(filePath: string, discovery: GatewayDiscoveryFile): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    `${JSON.stringify(gatewayDiscoveryFileSchema.parse(discovery), null, 2)}\n`,
    "utf8",
  );
}
