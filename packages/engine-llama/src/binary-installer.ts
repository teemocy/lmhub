import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { createReadStream, createWriteStream } from "node:fs";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  type EngineInstallResult,
  activateEngineVersion,
  createEmptyEngineVersionRegistry,
  ensureEngineSupportPaths,
  readEngineVersionRegistry,
  resolveEngineSupportPaths,
  upsertEngineVersionRecord,
  writeEngineVersionRegistry,
} from "@localhub/engine-core";

const LLAMA_CPP_ENGINE_TYPE = "llama.cpp";
const DEFAULT_RELEASE_OWNER = "ggml-org";
const DEFAULT_RELEASE_REPO = "llama.cpp";
const DEFAULT_BINARY_NAMES = ["llama-server", "server"] as const;
const DEFAULT_GITHUB_USER_AGENT = "LM Hub";

type InstallSource =
  | {
      kind: "release";
      releaseTag: string;
      releaseName?: string;
      releaseUrl: string;
      assetName: string;
      assetUrl: string;
      platform: NodeJS.Platform;
      arch: string;
    }
  | {
      kind: "manual";
      sourcePath: string;
      platform: NodeJS.Platform;
      arch: string;
    };

interface InstallManifest {
  engineType: typeof LLAMA_CPP_ENGINE_TYPE;
  versionTag: string;
  installPath: string;
  binaryPath: string;
  managedBy: "binary";
  createdAt: string;
  source: InstallSource;
  notes: string[];
  checksumSha256?: string;
}

interface InstallContext {
  supportRoot: string;
  versionTag?: string;
  activate?: boolean;
  platform?: NodeJS.Platform;
  arch?: string;
}

interface ReleaseInstallOptions extends InstallContext {
  fetch?: typeof fetch;
  releaseTag?: string;
}

interface ManualInstallOptions extends InstallContext {
  sourcePath: string;
}

interface RestoreInstallOptions {
  supportRoot: string;
  versionTag: string;
  fetch?: typeof fetch;
  platform?: NodeJS.Platform;
  arch?: string;
}

interface BinaryInstallResult {
  versionTag: string;
  installPath: string;
  binaryPath: string;
  registryFile: string;
  activated: boolean;
  notes: string[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function sanitizeVersionTag(versionTag: string): string {
  return versionTag.replace(/[^A-Za-z0-9._-]+/g, "-");
}

function toVersionTag(
  source: InstallSource,
  explicitVersionTag?: string,
  checksumSha256?: string,
): string {
  if (explicitVersionTag?.trim()) {
    return sanitizeVersionTag(explicitVersionTag.trim());
  }

  if (source.kind === "release") {
    return sanitizeVersionTag(`release-${source.releaseTag}-${source.platform}-${source.arch}`);
  }

  const baseName = path.basename(source.sourcePath, path.extname(source.sourcePath));
  const slug = baseName.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (checksumSha256) {
    return sanitizeVersionTag(`manual-${slug || "binary"}-${checksumSha256.slice(0, 12)}`);
  }

  return sanitizeVersionTag(`manual-${slug || "binary"}-${source.platform}-${source.arch}`);
}

function isBinaryName(fileName: string): boolean {
  return DEFAULT_BINARY_NAMES.some(
    (candidate) => fileName === candidate || fileName === `${candidate}.exe`,
  );
}

async function computeFileSha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

async function copyDirectoryTree(sourceDir: string, destinationDir: string): Promise<void> {
  await mkdir(destinationDir, { recursive: true });
  const entries = await readdir(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const destinationPath = path.join(destinationDir, entry.name);

    if (entry.isDirectory()) {
      await copyDirectoryTree(sourcePath, destinationPath);
      continue;
    }

    if (entry.isSymbolicLink()) {
      const linkTarget = await readlink(sourcePath);
      await symlink(linkTarget, destinationPath).catch(() => undefined);
      continue;
    }

    if (entry.isFile()) {
      await mkdir(path.dirname(destinationPath), { recursive: true });
      await cp(sourcePath, destinationPath, { force: true });
    }
  }
}

async function copySourceTree(sourcePath: string, destinationDir: string): Promise<void> {
  const stats = await lstat(sourcePath);

  if (stats.isDirectory()) {
    await copyDirectoryTree(sourcePath, destinationDir);
    return;
  }

  await mkdir(destinationDir, { recursive: true });
  await cp(sourcePath, path.join(destinationDir, path.basename(sourcePath)), { force: true });
}

async function findBinaryPath(rootDir: string): Promise<string | undefined> {
  if (!existsSync(rootDir)) {
    return undefined;
  }

  const queue = [rootDir];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const candidatePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(candidatePath);
        continue;
      }

      if (entry.isFile() && isBinaryName(entry.name)) {
        return candidatePath;
      }
    }
  }

  return undefined;
}

async function writeManifest(manifestPath: string, manifest: InstallManifest): Promise<void> {
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function readManifest(manifestPath: string): Promise<InstallManifest | undefined> {
  if (!existsSync(manifestPath)) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as Partial<InstallManifest>;
    if (
      parsed.engineType !== LLAMA_CPP_ENGINE_TYPE ||
      typeof parsed.versionTag !== "string" ||
      typeof parsed.installPath !== "string" ||
      typeof parsed.binaryPath !== "string" ||
      parsed.managedBy !== "binary" ||
      typeof parsed.createdAt !== "string" ||
      !parsed.source ||
      typeof parsed.source !== "object" ||
      !Array.isArray(parsed.notes)
    ) {
      return undefined;
    }

    if (parsed.source.kind === "release") {
      return {
        engineType: LLAMA_CPP_ENGINE_TYPE,
        versionTag: parsed.versionTag,
        installPath: parsed.installPath,
        binaryPath: parsed.binaryPath,
        managedBy: "binary",
        createdAt: parsed.createdAt,
        source: {
          kind: "release",
          releaseTag: parsed.source.releaseTag,
          releaseUrl: parsed.source.releaseUrl,
          assetName: parsed.source.assetName,
          assetUrl: parsed.source.assetUrl,
          platform: parsed.source.platform,
          arch: parsed.source.arch,
          ...(typeof parsed.source.releaseName === "string"
            ? { releaseName: parsed.source.releaseName }
            : {}),
        },
        notes: parsed.notes.filter((note): note is string => typeof note === "string"),
        ...(typeof parsed.checksumSha256 === "string"
          ? { checksumSha256: parsed.checksumSha256 }
          : {}),
      };
    }

    if (parsed.source.kind === "manual") {
      return {
        engineType: LLAMA_CPP_ENGINE_TYPE,
        versionTag: parsed.versionTag,
        installPath: parsed.installPath,
        binaryPath: parsed.binaryPath,
        managedBy: "binary",
        createdAt: parsed.createdAt,
        source: {
          kind: "manual",
          sourcePath: parsed.source.sourcePath,
          platform: parsed.source.platform,
          arch: parsed.source.arch,
        },
        notes: parsed.notes.filter((note): note is string => typeof note === "string"),
        ...(typeof parsed.checksumSha256 === "string"
          ? { checksumSha256: parsed.checksumSha256 }
          : {}),
      };
    }
  } catch {
    return undefined;
  }

  return undefined;
}

async function execTarExtract(archivePath: string, destinationDir: string): Promise<void> {
  await mkdir(destinationDir, { recursive: true });

  await new Promise<void>((resolve, reject) => {
    const child = spawn("tar", ["-xzf", archivePath, "-C", destinationDir], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(stderr.trim() || `tar exited with code ${code ?? "unknown"}.`));
    });
  });
}

async function downloadToFile(
  url: string,
  targetPath: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  const response = await fetchImpl(url, {
    headers: {
      "user-agent": DEFAULT_GITHUB_USER_AGENT,
      accept: "application/octet-stream",
    },
  });

  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url} (${response.status}).`);
  }

  await mkdir(path.dirname(targetPath), { recursive: true });
  await pipeline(Readable.fromWeb(response.body), createWriteStream(targetPath));
}

function selectReleaseAsset(
  assets: Array<{
    name: string;
    browser_download_url: string;
    label?: string | null;
  }>,
  platform: NodeJS.Platform,
  arch: string,
): { name: string; url: string } {
  if (platform !== "darwin") {
    throw new Error("Metal llama.cpp binaries are currently only published for macOS.");
  }

  const normalizedArch = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : undefined;
  if (!normalizedArch) {
    throw new Error(`Unsupported macOS architecture: ${arch}.`);
  }

  const patterns =
    normalizedArch === "arm64" ? [/macos.*arm64/i, /apple silicon/i] : [/macos.*x64/i, /intel/i];
  const match = assets.find((asset) =>
    patterns.some((pattern) => pattern.test(asset.name) || pattern.test(asset.label ?? "")),
  );

  if (!match) {
    throw new Error(`Unable to find a Metal binary asset for macOS ${normalizedArch}.`);
  }

  return {
    name: match.name,
    url: match.browser_download_url,
  };
}

async function fetchReleaseDescriptor(
  fetchImpl: typeof fetch,
  releaseTag?: string,
): Promise<{
  tag_name: string;
  name?: string;
  html_url: string;
  assets: Array<{
    name: string;
    browser_download_url: string;
    label?: string | null;
  }>;
}> {
  const releaseUrl = releaseTag
    ? `https://api.github.com/repos/${DEFAULT_RELEASE_OWNER}/${DEFAULT_RELEASE_REPO}/releases/tags/${encodeURIComponent(releaseTag)}`
    : `https://api.github.com/repos/${DEFAULT_RELEASE_OWNER}/${DEFAULT_RELEASE_REPO}/releases/latest`;

  const response = await fetchImpl(releaseUrl, {
    headers: {
      "user-agent": DEFAULT_GITHUB_USER_AGENT,
      accept: "application/vnd.github+json",
    },
  });

  if (!response.ok) {
    throw new Error(`Unable to load llama.cpp release metadata (${response.status}).`);
  }

  return (await response.json()) as {
    tag_name: string;
    name?: string;
    html_url: string;
    assets: Array<{
      name: string;
      browser_download_url: string;
      label?: string | null;
    }>;
  };
}

async function registerInstalledBinary(
  supportRoot: string,
  manifest: InstallManifest,
): Promise<BinaryInstallResult> {
  const paths = ensureEngineSupportPaths(
    resolveEngineSupportPaths(supportRoot, LLAMA_CPP_ENGINE_TYPE),
  );
  const manifestPath = path.join(manifest.installPath, "manifest.json");

  await writeManifest(manifestPath, manifest);

  const registry = readEngineVersionRegistry(paths.registryFile, LLAMA_CPP_ENGINE_TYPE);
  const nextRegistry = writeEngineVersionRegistry(
    paths.registryFile,
    activateEngineVersion(
      upsertEngineVersionRecord(
        registry.engineType ? registry : createEmptyEngineVersionRegistry(LLAMA_CPP_ENGINE_TYPE),
        {
          versionTag: manifest.versionTag,
          installPath: manifest.installPath,
          binaryPath: manifest.binaryPath,
          source: manifest.source.kind,
          channel: manifest.source.kind === "release" ? "stable" : "custom",
          managedBy: "binary",
          installedAt: manifest.createdAt,
          notes: manifest.notes,
        },
      ),
      manifest.versionTag,
    ),
  );

  return {
    versionTag: manifest.versionTag,
    installPath: manifest.installPath,
    binaryPath: manifest.binaryPath,
    registryFile: paths.registryFile,
    activated: nextRegistry.activeVersionTag === manifest.versionTag,
    notes: [...manifest.notes],
  };
}

async function installReleaseBinary(options: ReleaseInstallOptions): Promise<EngineInstallResult> {
  const fetchImpl = options.fetch ?? fetch;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const release = await fetchReleaseDescriptor(fetchImpl, options.releaseTag);
  const asset = selectReleaseAsset(release.assets ?? [], platform, arch);
  const source: InstallSource = {
    kind: "release",
    releaseTag: release.tag_name,
    releaseUrl: release.html_url,
    assetName: asset.name,
    assetUrl: asset.url,
    platform,
    arch,
    ...(typeof release.name === "string" ? { releaseName: release.name } : {}),
  };
  const versionTag = toVersionTag(source, options.versionTag);
  const paths = ensureEngineSupportPaths(
    resolveEngineSupportPaths(options.supportRoot, LLAMA_CPP_ENGINE_TYPE),
  );
  const installPath = path.join(paths.versionsRoot, versionTag);
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "localhub-llama-cpp-"));
  const archivePath = path.join(tempRoot, asset.name);
  const extractDir = path.join(tempRoot, "extract");

  try {
    await rm(installPath, { recursive: true, force: true });
    await mkdir(installPath, { recursive: true });
    await mkdir(extractDir, { recursive: true });

    await downloadToFile(asset.url, archivePath, fetchImpl);
    await execTarExtract(archivePath, extractDir);
    await copySourceTree(extractDir, installPath);

    const binaryPath = await findBinaryPath(installPath);
    if (!binaryPath) {
      throw new Error("The downloaded llama.cpp package did not contain a llama-server binary.");
    }

    await chmod(binaryPath, 0o755).catch(() => undefined);
    const checksumSha256 = await computeFileSha256(binaryPath).catch(() => undefined);
    const manifest: InstallManifest = {
      engineType: LLAMA_CPP_ENGINE_TYPE,
      versionTag,
      installPath,
      binaryPath,
      managedBy: "binary",
      createdAt: nowIso(),
      source,
      notes: [
        `Downloaded llama.cpp release ${release.tag_name}.`,
        `Packaged the Metal binary inside ${installPath}.`,
        `Source asset: ${asset.name}.`,
      ],
      ...(checksumSha256 ? { checksumSha256 } : {}),
    };

    return {
      success: true,
      ...(await registerInstalledBinary(options.supportRoot, manifest)),
    };
  } finally {
    await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function installManualBinary(options: ManualInstallOptions): Promise<EngineInstallResult> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const sourceStats = await lstat(options.sourcePath);
  const checksumSha256 = sourceStats.isFile()
    ? await computeFileSha256(options.sourcePath)
    : undefined;
  const source: InstallSource = {
    kind: "manual",
    sourcePath: options.sourcePath,
    platform,
    arch,
  };
  const versionTag = toVersionTag(source, options.versionTag, checksumSha256);
  const paths = ensureEngineSupportPaths(
    resolveEngineSupportPaths(options.supportRoot, LLAMA_CPP_ENGINE_TYPE),
  );
  const installPath = path.join(paths.versionsRoot, versionTag);

  await rm(installPath, { recursive: true, force: true });
  await mkdir(installPath, { recursive: true });

  if (sourceStats.isDirectory()) {
    await copyDirectoryTree(options.sourcePath, installPath);
  } else {
    const copiedBinaryPath = path.join(installPath, path.basename(options.sourcePath));
    await cp(options.sourcePath, copiedBinaryPath, {
      force: true,
    });
  }

  const binaryPath = sourceStats.isFile()
    ? path.join(installPath, path.basename(options.sourcePath))
    : await findBinaryPath(installPath);
  if (!binaryPath) {
    throw new Error("The selected local path did not contain a llama.cpp executable.");
  }

  await chmod(binaryPath, 0o755).catch(() => undefined);
  const packagedChecksum = await computeFileSha256(binaryPath).catch(() => undefined);
  const manifest: InstallManifest = {
    engineType: LLAMA_CPP_ENGINE_TYPE,
    versionTag,
    installPath,
    binaryPath,
    managedBy: "binary",
    createdAt: nowIso(),
    source,
    notes: [
      `Imported a local llama.cpp binary from ${options.sourcePath}.`,
      `Packaged the binary inside ${installPath}.`,
    ],
    ...(packagedChecksum ? { checksumSha256: packagedChecksum } : {}),
  };

  return {
    success: true,
    ...(await registerInstalledBinary(options.supportRoot, manifest)),
  };
}

async function restoreFromManifest(
  options: RestoreInstallOptions,
): Promise<EngineInstallResult | undefined> {
  const paths = ensureEngineSupportPaths(
    resolveEngineSupportPaths(options.supportRoot, LLAMA_CPP_ENGINE_TYPE),
  );
  const installPath = path.join(paths.versionsRoot, sanitizeVersionTag(options.versionTag));
  const manifest = await readManifest(path.join(installPath, "manifest.json"));
  if (!manifest) {
    return undefined;
  }

  if (manifest.source.kind === "manual") {
    if (!existsSync(manifest.source.sourcePath)) {
      return undefined;
    }

    return await installManualBinary({
      supportRoot: options.supportRoot,
      sourcePath: manifest.source.sourcePath,
      versionTag: options.versionTag,
      platform: options.platform ?? manifest.source.platform,
      arch: options.arch ?? manifest.source.arch,
    });
  }

  return await installReleaseBinary({
    supportRoot: options.supportRoot,
    versionTag: options.versionTag,
    releaseTag: manifest.source.releaseTag,
    platform: options.platform ?? manifest.source.platform,
    arch: options.arch ?? manifest.source.arch,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}

export async function getInstalledPackagedLlamaCppBinary(
  supportRoot: string,
  versionTag: string,
): Promise<EngineInstallResult | undefined> {
  const paths = ensureEngineSupportPaths(
    resolveEngineSupportPaths(supportRoot, LLAMA_CPP_ENGINE_TYPE),
  );
  const registry = readEngineVersionRegistry(paths.registryFile, LLAMA_CPP_ENGINE_TYPE);
  const existing = registry.versions.find((version) => version.versionTag === versionTag);
  if (!existing || !existsSync(existing.binaryPath)) {
    return undefined;
  }

  const manifest = await readManifest(path.join(existing.installPath, "manifest.json"));
  return {
    success: true,
    versionTag: existing.versionTag,
    installPath: existing.installPath,
    binaryPath: existing.binaryPath,
    registryFile: paths.registryFile,
    activated: registry.activeVersionTag === existing.versionTag,
    notes: manifest?.notes ?? existing.notes,
  };
}

export async function downloadPrebuiltMetalLlamaCppBinary(
  options: ReleaseInstallOptions,
): Promise<EngineInstallResult> {
  return await installReleaseBinary(options);
}

export async function importLocalLlamaCppBinary(
  options: ManualInstallOptions,
): Promise<EngineInstallResult> {
  return await installManualBinary(options);
}

export async function restorePackagedLlamaCppBinary(
  options: RestoreInstallOptions,
): Promise<EngineInstallResult | undefined> {
  const existing = await getInstalledPackagedLlamaCppBinary(
    options.supportRoot,
    options.versionTag,
  );
  if (existing) {
    return existing;
  }

  return await restoreFromManifest(options);
}
