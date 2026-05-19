import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { afterEach, describe, expect, it } from "vitest";
import { WorldManager } from "./world.js";

type CommandRunner = typeof execFileSync;

const tempDirs: string[] = [];

function makeMcDir() {
  const mcDir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-world-manager-"));
  tempDirs.push(mcDir);
  fs.mkdirSync(path.join(mcDir, "worlds"), { recursive: true });
  return mcDir;
}

function makeCommandRunner(mcDir: string, createLevelOnStart: boolean, onStart?: () => void): CommandRunner {
  let active = false;

  return ((cmd: string, args: string[] = []) => {
    if (cmd === "systemctl") {
      const action = args[0];
      if (action === "is-active") return active ? "active" : "inactive";
      if (action === "start") {
        active = true;
        onStart?.();
        if (createLevelOnStart) {
          const propertiesPath = path.join(mcDir, "server.properties");
          const properties = fs.existsSync(propertiesPath) ? fs.readFileSync(propertiesPath, "utf8") : "";
          const configuredLevelName = properties.match(/^level-name=(.*)$/m)?.[1]?.trim() || "world";
          const worldTarget = configuredLevelName === "world"
            ? fs.readlinkSync(path.join(mcDir, "world"))
            : path.join(mcDir, configuredLevelName);
          fs.mkdirSync(worldTarget, { recursive: true });
          fs.writeFileSync(path.join(worldTarget, "level.dat"), "generated");
        }
        return "";
      }
      if (action === "stop") {
        active = false;
        return "";
      }
    }

    return "";
  }) as CommandRunner;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("WorldManager.generateWorld", () => {
  it("restores server.properties after generating a seeded world", async () => {
    const mcDir = makeMcDir();
    const oldWorld = path.join(mcDir, "worlds", "old-world");
    fs.mkdirSync(oldWorld, { recursive: true });
    fs.writeFileSync(path.join(oldWorld, "level.dat"), "old");
    fs.symlinkSync(oldWorld, path.join(mcDir, "world"));

    const propertiesPath = path.join(mcDir, "server.properties");
    const originalProperties = "# server settings\nlevel-name=custom-existing\nlevel-seed=old-seed\nlevel-type=minecraft:normal\n";
    fs.writeFileSync(propertiesPath, originalProperties);

    const manager = new WorldManager(mcDir, {
      execFileSync: makeCommandRunner(mcDir, true),
      generationPollMs: 1,
      generationTimeoutMs: 50,
    });

    const world = await manager.generateWorld({
      name: "new-world",
      seed: "fresh-seed",
      levelType: "flat",
    });

    const newWorldPath = path.join(mcDir, "worlds", "new-world");
    expect(world.name).toBe("new-world");
    const restoredProperties = fs.readFileSync(propertiesPath, "utf8");
    expect(restoredProperties).toContain("level-name=world");
    expect(restoredProperties).toContain("level-seed=old-seed");
    expect(restoredProperties).toContain("level-type=minecraft:normal");
    expect(fs.readlinkSync(path.join(mcDir, "world"))).toBe(newWorldPath);
    expect(fs.existsSync(path.join(newWorldPath, "level.dat"))).toBe(true);
    expect(fs.existsSync(path.join(mcDir, "custom-existing", "level.dat"))).toBe(false);
  });

  it("clears the previous seed when no seed is supplied", async () => {
    const mcDir = makeMcDir();
    const oldWorld = path.join(mcDir, "worlds", "old-world");
    fs.mkdirSync(oldWorld, { recursive: true });
    fs.writeFileSync(path.join(oldWorld, "level.dat"), "old");
    fs.symlinkSync(oldWorld, path.join(mcDir, "world"));

    const propertiesPath = path.join(mcDir, "server.properties");
    const originalProperties = "# server settings\nlevel-name=world\nlevel-seed=old-seed\nlevel-type=minecraft:normal\n";
    fs.writeFileSync(propertiesPath, originalProperties);
    let propertiesAtStart = "";

    const manager = new WorldManager(mcDir, {
      execFileSync: makeCommandRunner(mcDir, true, () => {
        propertiesAtStart = fs.readFileSync(propertiesPath, "utf8");
      }),
      generationPollMs: 1,
      generationTimeoutMs: 50,
    });

    await manager.generateWorld({
      name: "random-world",
      levelType: "default",
    });

    expect(propertiesAtStart).toContain("level-name=world");
    expect(propertiesAtStart).toContain("level-seed=");
    expect(propertiesAtStart).not.toContain("level-seed=old-seed");
    expect(fs.readFileSync(propertiesPath, "utf8")).toBe(originalProperties);
  });

  it("removes failed generated worlds and dangling world links on fresh installs", async () => {
    const mcDir = makeMcDir();
    const propertiesPath = path.join(mcDir, "server.properties");
    const originalProperties = "# server settings\nlevel-seed=\nlevel-type=minecraft:normal\n";
    fs.writeFileSync(propertiesPath, originalProperties);

    const manager = new WorldManager(mcDir, {
      execFileSync: makeCommandRunner(mcDir, false),
      generationPollMs: 1,
      generationTimeoutMs: 2,
    });

    await expect(
      manager.generateWorld({
        name: "failed-world",
        seed: "temporary-seed",
        levelType: "amplified",
      })
    ).rejects.toThrow("World generation timed out before level.dat was stable");

    expect(fs.readFileSync(propertiesPath, "utf8")).toBe(originalProperties);
    expect(fs.existsSync(path.join(mcDir, "worlds", "failed-world"))).toBe(false);
    expect(() => fs.lstatSync(path.join(mcDir, "world"))).toThrow();
  });
});
