import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const desktopDir = path.join(repoRoot, "apps", "desktop");
const gatewayDir = path.join(repoRoot, "services", "gateway");
const packagesDir = path.join(repoRoot, "packages");
const pnpmStoreDir = path.join(repoRoot, "node_modules", ".pnpm");
const releaseRoot = path.join(repoRoot, "release", "macos");
const appName = "LM Hub";
const electronAppTemplate = path.join(
  desktopDir,
  "node_modules",
  "electron",
  "dist",
  "Electron.app",
);
const appBundlePath = path.join(releaseRoot, `${appName}.app`);
const contentsRoot = path.join(appBundlePath, "Contents");
const resourcesDir = path.join(contentsRoot, "Resources");
const appPayloadDir = path.join(resourcesDir, "app");
const packagedGatewayDir = path.join(resourcesDir, "services", "gateway");
const packagedPackagesDir = path.join(resourcesDir, "packages");
const packagedNodeModulesDir = path.join(resourcesDir, "node_modules");

function assertPathExists(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`Expected packaged asset is missing: ${filePath}`);
  }
}

function copyIntoBundle(sourcePath, destinationPath) {
  assertPathExists(sourcePath);
  cpSync(sourcePath, destinationPath, {
    recursive: true,
  });
}

if (process.platform !== "darwin") {
  throw new Error("package-macos.mjs must be run on macOS.");
}

if (!existsSync(electronAppTemplate)) {
  throw new Error(
    `Electron.app template not found at ${electronAppTemplate}. Run pnpm install first.`,
  );
}

rmSync(appBundlePath, { recursive: true, force: true });
mkdirSync(releaseRoot, { recursive: true });
cpSync(electronAppTemplate, appBundlePath, { recursive: true });

rmSync(appPayloadDir, { recursive: true, force: true });
rmSync(packagedGatewayDir, { recursive: true, force: true });
rmSync(packagedPackagesDir, { recursive: true, force: true });
rmSync(packagedNodeModulesDir, { recursive: true, force: true });
mkdirSync(appPayloadDir, { recursive: true });
mkdirSync(packagedGatewayDir, { recursive: true });
mkdirSync(packagedPackagesDir, { recursive: true });
mkdirSync(packagedNodeModulesDir, { recursive: true });

for (const relativePath of ["dist", "dist-electron", "node_modules", "package.json"]) {
  copyIntoBundle(path.join(desktopDir, relativePath), path.join(appPayloadDir, relativePath));
}

for (const relativePath of ["dist", "node_modules", "package.json"]) {
  copyIntoBundle(path.join(gatewayDir, relativePath), path.join(packagedGatewayDir, relativePath));
}

copyIntoBundle(packagesDir, packagedPackagesDir);
copyIntoBundle(pnpmStoreDir, path.join(packagedNodeModulesDir, ".pnpm"));

writeFileSync(
  path.join(releaseRoot, "manifest.json"),
  `${JSON.stringify(
    {
      appName,
      builtAt: new Date().toISOString(),
      appBundlePath,
      bundledPaths: [
        "Resources/app/dist",
        "Resources/app/dist-electron",
        "Resources/app/node_modules",
        "Resources/services/gateway/dist",
        "Resources/services/gateway/node_modules",
        "Resources/packages",
        "Resources/node_modules/.pnpm",
      ],
      signingIdentity: process.env.APPLE_SIGNING_IDENTITY ?? null,
      notarizationConfigured: Boolean(process.env.APPLE_ID && process.env.APPLE_TEAM_ID),
    },
    null,
    2,
  )}\n`,
  "utf8",
);

process.stdout.write(`${appBundlePath}\n`);
