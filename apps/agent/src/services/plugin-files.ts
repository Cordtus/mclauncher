import fs from "fs";
import path from "path";

export function assertPluginArtifactFileName(fileName: string) {
  if (
    !fileName ||
    fileName.includes("/") ||
    fileName.includes("\\") ||
    fileName === "." ||
    fileName === ".." ||
    fileName.includes("..") ||
    (!fileName.endsWith(".jar") && !fileName.endsWith(".jar.disabled"))
  ) {
    throw new Error("Invalid plugin fileName");
  }
}

export function pluginToggleTargetFileName(fileName: string, enabled: boolean): string | null {
  assertPluginArtifactFileName(fileName);

  if (enabled && fileName.endsWith(".jar.disabled")) {
    return fileName.replace(/\.disabled$/, "");
  }

  if (!enabled && fileName.endsWith(".jar")) {
    return `${fileName}.disabled`;
  }

  return null;
}

export function pluginToggleOperation(pluginsDir: string, fileName: string, enabled: boolean) {
  const targetFileName = pluginToggleTargetFileName(fileName, enabled);
  if (!targetFileName) return { targetFileName: null, targetExists: false };

  return {
    targetFileName,
    targetExists: fs.existsSync(path.join(pluginsDir, targetFileName)),
  };
}

export function parsePluginToggleEnabled(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new Error("Invalid enabled");
  }

  return value;
}
