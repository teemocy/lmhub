import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

const workspaceRoot = path.resolve(import.meta.dirname, "..");
const removableDirectories = ["dist", "coverage", ".local", "node_modules"];
const removableFiles = [".tsbuildinfo"];

function cleanDirectory(currentDirectory) {
  for (const entry of readdirSync(currentDirectory, { withFileTypes: true })) {
    const absolutePath = path.join(currentDirectory, entry.name);

    if (entry.isDirectory()) {
      if (removableDirectories.includes(entry.name)) {
        rmSync(absolutePath, { recursive: true, force: true });
        continue;
      }

      cleanDirectory(absolutePath);
      continue;
    }

    if (removableFiles.some((suffix) => entry.name.endsWith(suffix))) {
      rmSync(absolutePath, { force: true });
    }
  }
}

if (existsSync(workspaceRoot)) {
  cleanDirectory(workspaceRoot);
}
