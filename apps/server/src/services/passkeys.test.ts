import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
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

  it("does not pin login options to the registration device transports", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "mc-passkeys-test-"));
    try {
      const storeFile = path.join(tempDir, "passkeys.json");
      writeFileSync(storeFile, JSON.stringify({
        credentials: [
          {
            id: "cmVnaXN0ZXJlZC1wYXNza2V5",
            name: "Admin passkey",
            rpId: "gateway.example.test",
            origin: "https://gateway.example.test",
            publicKeyPem: "unused in option generation",
            counter: 0,
            transports: ["internal"],
            createdAt: new Date().toISOString(),
          },
        ],
        challenges: {},
        sessions: {},
      }));
      const service = new PasskeyService({
        enabled: true,
        rpName: "MC LXD Manager",
        storeFile,
        challengeTtlMs: 5 * 60 * 1000,
        sessionTtlMs: 12 * 60 * 60 * 1000,
        userVerification: "preferred",
      });

      const options = service.authenticationOptions({
        host: "gateway.example.test",
        origin: "https://gateway.example.test",
      });

      expect(options.allowCredentials).toEqual([
        {
          id: "cmVnaXN0ZXJlZC1wYXNza2V5",
          type: "public-key",
        },
      ]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("imports one-time registration codes without storing plaintext", () => {
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
        registrationCodes: [{ label: "Alice", code: "setup-secret" }],
      });

      expect(service.hasRegistrationCodes()).toBe(true);
      const config = service.publicConfig({ host: "gateway.example.test", origin: "https://gateway.example.test" });
      expect(config.algorithm).toEqual({
        name: "ES256",
        coseAlg: -7,
        curve: "P-256",
        namedCurve: "secp256r1",
      });
      expect(config.registrationCodesAvailable).toBe(true);

      const storeText = readFileSync(storeFile, "utf8");
      expect(storeText).not.toContain("setup-secret");
      const store = JSON.parse(storeText);
      const [code] = Object.values(store.registrationCodes) as any[];
      expect(code.label).toBe("Alice");
      expect(code.source).toBe("env");
      expect(code.hashAlgorithm).toBe("sha256");
      expect(code.codeHash).toEqual(expect.any(String));
      expect(code.code).toBeUndefined();
      expect(code.usedAt).toBeUndefined();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("migrates legacy plaintext registration codes to sha256 hashes", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "mc-passkeys-test-"));
    try {
      const storeFile = path.join(tempDir, "passkeys.json");
      writeFileSync(storeFile, JSON.stringify({
        credentials: [],
        challenges: {},
        sessions: {},
        registrationCodes: {
          legacy: {
            id: "legacy",
            code: "legacy-secret",
            label: "Legacy Admin",
            source: "generated",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        },
      }));
      const service = new PasskeyService({
        enabled: true,
        rpName: "MC LXD Manager",
        storeFile,
        challengeTtlMs: 5 * 60 * 1000,
        sessionTtlMs: 12 * 60 * 60 * 1000,
        userVerification: "preferred",
      });

      service.registrationOptions(
        { host: "gateway.example.test", origin: "https://gateway.example.test" },
        "Legacy Admin",
        { type: "registration-code", code: "legacy-secret" },
      );

      const storeText = readFileSync(storeFile, "utf8");
      expect(storeText).not.toContain("legacy-secret");
      const store = JSON.parse(storeText);
      const code = store.registrationCodes.legacy;
      expect(code).toEqual(expect.objectContaining({
        id: "legacy",
        label: "Legacy Admin",
        source: "generated",
        hashAlgorithm: "sha256",
      }));
      expect(code.code).toBeUndefined();
      expect(code.codeHash).toEqual(expect.any(String));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not consume a registration code until registration verifies", () => {
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
        registrationCodes: [{ code: "setup-secret" }],
      });

      const context = { host: "gateway.example.test", origin: "https://gateway.example.test" };
      service.registrationOptions(context, "Alice", { type: "registration-code", code: "setup-secret" });
      expect(service.hasRegistrationCodes()).toBe(true);
      service.registrationOptions(context, "Alice", { type: "registration-code", code: "setup-secret" });
      const store = JSON.parse(readFileSync(storeFile, "utf8"));
      const [code] = Object.values(store.registrationCodes) as any[];
      expect(code.usedAt).toBeUndefined();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
