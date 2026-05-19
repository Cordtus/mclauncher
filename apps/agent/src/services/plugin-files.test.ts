import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertPluginArtifactFileName,
  parsePluginToggleEnabled,
  pluginToggleOperation,
  pluginToggleTargetFileName,
} from "./plugin-files.js";

const tempDirs: string[] = [];

function makePluginsDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-plugins-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("plugin file helpers", () => {
  it("accepts only plugin jar artifacts", () => {
    expect(() => assertPluginArtifactFileName("LuckPerms.jar")).not.toThrow();
    expect(() => assertPluginArtifactFileName("LuckPerms.jar.disabled")).not.toThrow();

    expect(() => assertPluginArtifactFileName("config.yml")).toThrow("Invalid plugin fileName");
    expect(() => assertPluginArtifactFileName("plugins/LuckPerms.jar")).toThrow("Invalid plugin fileName");
    expect(() => assertPluginArtifactFileName("../LuckPerms.jar")).toThrow("Invalid plugin fileName");
  });

  it("computes enable and disable rename targets without touching non-jar files", () => {
    expect(pluginToggleTargetFileName("LuckPerms.jar", false)).toBe("LuckPerms.jar.disabled");
    expect(pluginToggleTargetFileName("LuckPerms.jar.disabled", true)).toBe("LuckPerms.jar");
    expect(pluginToggleTargetFileName("LuckPerms.jar", true)).toBeNull();
    expect(pluginToggleTargetFileName("LuckPerms.jar.disabled", false)).toBeNull();
    expect(() => pluginToggleTargetFileName("config.yml", false)).toThrow("Invalid plugin fileName");
  });

  it("requires an explicit boolean toggle value", () => {
    expect(parsePluginToggleEnabled(true)).toBe(true);
    expect(parsePluginToggleEnabled(false)).toBe(false);
    expect(() => parsePluginToggleEnabled(undefined)).toThrow("Invalid enabled");
    expect(() => parsePluginToggleEnabled("false")).toThrow("Invalid enabled");
  });

  it("reports toggle destination collisions before rename", () => {
    const pluginsDir = makePluginsDir();
    fs.writeFileSync(path.join(pluginsDir, "LuckPerms.jar"), "enabled");
    fs.writeFileSync(path.join(pluginsDir, "LuckPerms.jar.disabled"), "disabled");

    expect(pluginToggleOperation(pluginsDir, "LuckPerms.jar", false)).toEqual({
      targetFileName: "LuckPerms.jar.disabled",
      targetExists: true,
    });
    expect(pluginToggleOperation(pluginsDir, "LuckPerms.jar.disabled", true)).toEqual({
      targetFileName: "LuckPerms.jar",
      targetExists: true,
    });
  });
});
