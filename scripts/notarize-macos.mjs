import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const appPath = process.argv[2] ?? path.join(repoRoot, "release", "macos", "LM Hub.app");

if (process.platform !== "darwin") {
  throw new Error("notarize-macos.mjs must be run on macOS.");
}

if (!existsSync(appPath)) {
  throw new Error(`App bundle not found: ${appPath}`);
}

const requiredEnv = [
  "APPLE_SIGNING_IDENTITY",
  "APPLE_ID",
  "APPLE_APP_SPECIFIC_PASSWORD",
  "APPLE_TEAM_ID",
];
const missing = requiredEnv.filter((name) => !process.env[name]);

if (missing.length > 0) {
  throw new Error(`Missing notarization environment variables: ${missing.join(", ")}`);
}

const releaseDir = path.dirname(appPath);
const archivePath = path.join(releaseDir, `${path.basename(appPath, ".app")}.zip`);

function run(command, args) {
  execFileSync(command, args, {
    stdio: "inherit",
  });
}

rmSync(archivePath, { force: true });

run("codesign", [
  "--force",
  "--deep",
  "--options",
  "runtime",
  "--timestamp",
  "--sign",
  process.env.APPLE_SIGNING_IDENTITY,
  appPath,
]);

run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);

run("ditto", ["-c", "-k", "--keepParent", appPath, archivePath]);

run("xcrun", [
  "notarytool",
  "submit",
  archivePath,
  "--apple-id",
  process.env.APPLE_ID,
  "--password",
  process.env.APPLE_APP_SPECIFIC_PASSWORD,
  "--team-id",
  process.env.APPLE_TEAM_ID,
  "--wait",
]);

run("xcrun", ["stapler", "staple", "-v", appPath]);
run("spctl", ["--assess", "--type", "execute", "-vv", appPath]);

process.stdout.write(
  `${[
    "Desktop artifact signed, notarized, stapled, and verified.",
    `App bundle: ${appPath}`,
    `Archive: ${archivePath}`,
  ].join("\n")}\n`,
);
