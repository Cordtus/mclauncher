import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { PasskeyService } from "./passkeys.js";

describe("PasskeyService", () => {
  it("creates the passkey store with owner-only permissions", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "mc-passkeys-test-"));
    try {
      const storeFile = path.join(tempDir, "passkeys.json");
      const service = new PasskeyService({
        enabled: true,
        rpName: "MC LXD Manager",
        storeFile,
        challengeTtlMs: 5 * 60 * 1000,
        sessionTtlMs: 12 * 60 * 60 * 1000,
        userVerification: "preferred",
      });

      service.registrationOptions({ host: "gateway.example.test", origin: "https://gateway.example.test" }, "Admin");

      expect(statSync(storeFile).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
