import fs from "fs";
import path from "path";
import {
  createHash,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify as verifySignature,
} from "crypto";

export interface PasskeyRequestContext {
  host?: string;
  origin?: string;
}

export interface PasskeyServiceConfig {
  enabled: boolean;
  rpName: string;
  rpId?: string;
  origin?: string;
  storeFile: string;
  challengeTtlMs: number;
  sessionTtlMs: number;
  userVerification: "preferred" | "required" | "discouraged";
  registrationCodes?: PasskeyRegistrationCodeInput[];
}

export interface PasskeyRegistrationCodeInput {
  code: string;
  label?: string;
}

export type PasskeyRegistrationAuthorization =
  | { type: "admin-session" }
  | { type: "registration-code"; code: string };

interface PasskeyCredential {
  id: string;
  name: string;
  rpId: string;
  origin: string;
  publicKeyPem: string;
  algorithm?: "ES256";
  curve?: "P-256";
  counter: number;
  transports: string[];
  createdAt: string;
  lastUsedAt?: string;
}

interface PasskeyChallenge {
  type: "registration" | "authentication";
  challenge: string;
  rpId: string;
  origin: string;
  name?: string;
  userId?: string;
  authorizedBy?: "admin-session" | "registration-code";
  registrationCodeId?: string;
  expiresAt: number;
}

interface PasskeySession {
  credentialId: string;
  createdAt: number;
  expiresAt: number;
}

interface StoredRegistrationCode {
  id: string;
  codeHash: string;
  hashAlgorithm?: typeof REGISTRATION_CODE_HASH_ALGORITHM;
  label?: string;
  source: "env" | "generated";
  createdAt: string;
  usedAt?: string;
  usedByCredentialId?: string;
}

interface PasskeyStore {
  credentials: PasskeyCredential[];
  challenges: Record<string, PasskeyChallenge>;
  sessions: Record<string, PasskeySession>;
  registrationCodes: Record<string, StoredRegistrationCode>;
}

const PASSKEY_ALGORITHM = "ES256" as const;
const PASSKEY_COSE_ALG = -7;
const PASSKEY_CURVE = "P-256" as const;
const PASSKEY_NAMED_CURVE = "secp256r1";
const REGISTRATION_CODE_HASH_ALGORITHM = "sha256" as const;
const EMPTY_STORE: PasskeyStore = {
  credentials: [],
  challenges: {},
  sessions: {},
  registrationCodes: {},
};

function base64url(buffer: Buffer | Uint8Array): string {
  return Buffer.from(buffer)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromBase64url(value: string): Buffer {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Buffer.from(padded, "base64");
}

function sha256(buffer: Buffer | string): Buffer {
  return createHash("sha256").update(buffer).digest();
}

function normalizeRegistrationCode(code: string): string {
  return code.trim();
}

function hashRegistrationCode(code: string): string {
  return base64url(sha256(normalizeRegistrationCode(code)));
}

function registrationCodeHashMatches(entry: StoredRegistrationCode, codeHash: string): boolean {
  const algorithm = entry.hashAlgorithm || REGISTRATION_CODE_HASH_ALGORITHM;
  return algorithm === REGISTRATION_CODE_HASH_ALGORITHM && sameString(entry.codeHash, codeHash);
}

function sameBase64url(a: string, b: string): boolean {
  const left = fromBase64url(a);
  const right = fromBase64url(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function sameString(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing ${label}`);
  }
  return value;
}

function readUInt(data: Buffer, offset: number, additionalInfo: number) {
  if (additionalInfo < 24) return { value: additionalInfo, offset };
  if (additionalInfo === 24) return { value: data.readUInt8(offset), offset: offset + 1 };
  if (additionalInfo === 25) return { value: data.readUInt16BE(offset), offset: offset + 2 };
  if (additionalInfo === 26) return { value: data.readUInt32BE(offset), offset: offset + 4 };
  throw new Error("Unsupported CBOR integer length");
}

function parseCbor(data: Buffer, offset = 0): { value: any; offset: number } {
  const initial = data.readUInt8(offset++);
  const major = initial >> 5;
  const additionalInfo = initial & 0x1f;
  const length = readUInt(data, offset, additionalInfo);
  offset = length.offset;

  if (major === 0) return { value: length.value, offset };
  if (major === 1) return { value: -1 - length.value, offset };
  if (major === 2) {
    return { value: data.subarray(offset, offset + length.value), offset: offset + length.value };
  }
  if (major === 3) {
    return { value: data.subarray(offset, offset + length.value).toString("utf8"), offset: offset + length.value };
  }
  if (major === 4) {
    const values = [];
    for (let i = 0; i < length.value; i += 1) {
      const parsed = parseCbor(data, offset);
      values.push(parsed.value);
      offset = parsed.offset;
    }
    return { value: values, offset };
  }
  if (major === 5) {
    const map = new Map<any, any>();
    for (let i = 0; i < length.value; i += 1) {
      const key = parseCbor(data, offset);
      const val = parseCbor(data, key.offset);
      map.set(key.value, val.value);
      offset = val.offset;
    }
    return { value: map, offset };
  }
  if (major === 6) return parseCbor(data, offset);
  if (major === 7) {
    if (additionalInfo === 20) return { value: false, offset };
    if (additionalInfo === 21) return { value: true, offset };
    if (additionalInfo === 22) return { value: null, offset };
  }

  throw new Error("Unsupported CBOR value");
}

function credentialPublicKeyToPem(coseKey: Map<any, any>) {
  const kty = coseKey.get(1);
  const alg = coseKey.get(3);
  const crv = coseKey.get(-1);
  const x = coseKey.get(-2);
  const y = coseKey.get(-3);

  if (kty !== 2 || alg !== PASSKEY_COSE_ALG || crv !== 1 || !Buffer.isBuffer(x) || !Buffer.isBuffer(y)) {
    throw new Error("Only ES256 secp256r1/P-256 passkeys are supported");
  }

  return createPublicKey({
    key: {
      kty: "EC",
      crv: PASSKEY_CURVE,
      x: base64url(x),
      y: base64url(y),
      ext: true,
    },
    format: "jwk",
  }).export({ format: "pem", type: "spki" }).toString();
}

function parseAuthenticatorData(authData: Buffer) {
  if (authData.length < 37) throw new Error("Invalid authenticator data");
  return {
    rpIdHash: authData.subarray(0, 32),
    flags: authData.readUInt8(32),
    counter: authData.readUInt32BE(33),
    attestedCredentialData: authData.subarray(37),
  };
}

function parseAttestation(authData: Buffer) {
  const parsed = parseAuthenticatorData(authData);
  if ((parsed.flags & 0x40) === 0) {
    throw new Error("Passkey registration missing attested credential data");
  }

  let offset = 16;
  const credentialIdLength = parsed.attestedCredentialData.readUInt16BE(offset);
  offset += 2;
  const credentialId = parsed.attestedCredentialData.subarray(offset, offset + credentialIdLength);
  offset += credentialIdLength;
  const coseKey = parseCbor(parsed.attestedCredentialData.subarray(offset)).value;
  if (!(coseKey instanceof Map)) {
    throw new Error("Invalid passkey public key");
  }

  return {
    ...parsed,
    credentialId,
    publicKeyPem: credentialPublicKeyToPem(coseKey),
  };
}

function assertUserFlags(flags: number, userVerification: PasskeyServiceConfig["userVerification"]) {
  if ((flags & 0x01) === 0) throw new Error("Passkey response did not prove user presence");
  if (userVerification === "required" && (flags & 0x04) === 0) {
    throw new Error("Passkey response did not prove user verification");
  }
}

export class PasskeyService {
  constructor(private readonly config: PasskeyServiceConfig) {
    this.syncConfiguredRegistrationCodes();
  }

  isEnabled() {
    return this.config.enabled;
  }

  publicConfig(context: PasskeyRequestContext) {
    const store = this.readStore();
    const rp = this.resolveRp(context, false);
    return {
      enabled: this.config.enabled,
      rpName: this.config.rpName,
      rpId: rp?.rpId || this.config.rpId || null,
      origin: rp?.origin || this.config.origin || null,
      userVerification: this.config.userVerification,
      algorithm: {
        name: PASSKEY_ALGORITHM,
        coseAlg: PASSKEY_COSE_ALG,
        curve: PASSKEY_CURVE,
        namedCurve: PASSKEY_NAMED_CURVE,
      },
      hasPasskeys: store.credentials.length > 0,
      registrationCodesAvailable: Object.values(store.registrationCodes).some((code) => !code.usedAt),
    };
  }

  hasCredentials() {
    return this.readStore().credentials.length > 0;
  }

  hasRegistrationCodes() {
    return Object.values(this.readStore().registrationCodes).some((code) => !code.usedAt);
  }

  registrationOptions(
    context: PasskeyRequestContext,
    name: string,
    authorization: PasskeyRegistrationAuthorization = { type: "admin-session" }
  ) {
    this.assertEnabled();
    const { rpId, origin } = this.resolveRp(context, true);
    const store = this.readStore();
    const challenge = base64url(randomBytes(32));
    const userId = base64url(randomBytes(16));
    const registrationCode =
      authorization.type === "registration-code" ? this.findRegistrationCode(store, authorization.code) : null;

    store.challenges[challenge] = {
      type: "registration",
      challenge,
      rpId,
      origin,
      name,
      userId,
      authorizedBy: authorization.type,
      registrationCodeId: registrationCode?.id,
      expiresAt: Date.now() + this.config.challengeTtlMs,
    };
    this.writeStore(store);

    return {
      challenge,
      rp: { name: this.config.rpName, id: rpId },
      user: {
        id: userId,
        name: "admin",
        displayName: "Server Admin",
      },
      pubKeyCredParams: [{ type: "public-key", alg: PASSKEY_COSE_ALG }],
      timeout: this.config.challengeTtlMs,
      attestation: "none",
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: this.config.userVerification,
      },
      excludeCredentials: store.credentials
        .filter((credential) => credential.rpId === rpId)
        .map((credential) => ({
          id: credential.id,
          type: "public-key",
          transports: credential.transports,
        })),
    };
  }

  verifyRegistration(context: PasskeyRequestContext, body: any) {
    this.assertEnabled();
    const clientData = fromBase64url(requireString(body?.response?.clientDataJSON, "clientDataJSON"));
    const attestationObject = fromBase64url(requireString(body?.response?.attestationObject, "attestationObject"));
    const client = JSON.parse(clientData.toString("utf8"));
    const store = this.readStore();
    const challenge = this.consumeChallenge(store, client.challenge, "registration");
    this.assertClientData(context, client, challenge, "webauthn.create");

    const attestation = parseCbor(attestationObject).value;
    if (!(attestation instanceof Map) || !Buffer.isBuffer(attestation.get("authData"))) {
      throw new Error("Invalid passkey attestation object");
    }

    const parsed = parseAttestation(attestation.get("authData"));
    this.assertRpIdHash(parsed.rpIdHash, challenge.rpId);
    assertUserFlags(parsed.flags, this.config.userVerification);

    const credentialId = base64url(parsed.credentialId);
    if (!sameBase64url(requireString(body.rawId || body.id, "credential id"), credentialId)) {
      throw new Error("Passkey credential ID mismatch");
    }

    if (store.credentials.some((credential) => credential.id === credentialId)) {
      throw new Error("Passkey is already registered");
    }

    const registrationCode = challenge.registrationCodeId
      ? store.registrationCodes[challenge.registrationCodeId]
      : null;
    if (challenge.registrationCodeId && (!registrationCode || registrationCode.usedAt)) {
      throw new Error("Invalid or already used passkey setup code");
    }

    const now = Date.now();
    store.credentials.push({
      id: credentialId,
      name: challenge.name || "Admin passkey",
      rpId: challenge.rpId,
      origin: challenge.origin,
      publicKeyPem: parsed.publicKeyPem,
      algorithm: PASSKEY_ALGORITHM,
      curve: PASSKEY_CURVE,
      counter: parsed.counter,
      transports: Array.isArray(body?.response?.transports) ? body.response.transports : [],
      createdAt: new Date(now).toISOString(),
    });
    if (registrationCode) {
      registrationCode.usedAt = new Date(now).toISOString();
      registrationCode.usedByCredentialId = credentialId;
    }
    const sessionToken = base64url(randomBytes(32));
    store.sessions[sessionToken] = {
      credentialId,
      createdAt: now,
      expiresAt: now + this.config.sessionTtlMs,
    };
    this.writeStore(store);

    return {
      ok: true,
      credentialId,
      sessionToken,
      expiresAt: new Date(store.sessions[sessionToken].expiresAt).toISOString(),
    };
  }

  authenticationOptions(context: PasskeyRequestContext) {
    this.assertEnabled();
    const { rpId, origin } = this.resolveRp(context, true);
    const store = this.readStore();
    const challenge = base64url(randomBytes(32));

    store.challenges[challenge] = {
      type: "authentication",
      challenge,
      rpId,
      origin,
      expiresAt: Date.now() + this.config.challengeTtlMs,
    };
    this.writeStore(store);

    return {
      challenge,
      rpId,
      timeout: this.config.challengeTtlMs,
      userVerification: this.config.userVerification,
      allowCredentials: store.credentials
        .filter((credential) => credential.rpId === rpId)
        .map((credential) => ({
          id: credential.id,
          type: "public-key",
        })),
    };
  }

  verifyAuthentication(context: PasskeyRequestContext, body: any) {
    this.assertEnabled();
    const clientData = fromBase64url(requireString(body?.response?.clientDataJSON, "clientDataJSON"));
    const authenticatorData = fromBase64url(requireString(body?.response?.authenticatorData, "authenticatorData"));
    const signature = fromBase64url(requireString(body?.response?.signature, "signature"));
    const client = JSON.parse(clientData.toString("utf8"));
    const store = this.readStore();
    const challenge = this.consumeChallenge(store, client.challenge, "authentication");
    this.assertClientData(context, client, challenge, "webauthn.get");

    const credentialId = requireString(body.rawId || body.id, "credential id");
    const credential = store.credentials.find((candidate) => candidate.id === credentialId);
    if (!credential) throw new Error("Unknown passkey");
    if (credential.origin !== challenge.origin) {
      throw new Error("Passkey origin does not match registered credential origin");
    }

    const parsed = parseAuthenticatorData(authenticatorData);
    this.assertRpIdHash(parsed.rpIdHash, credential.rpId);
    assertUserFlags(parsed.flags, this.config.userVerification);

    const signedData = Buffer.concat([authenticatorData, sha256(clientData)]);
    const verified = verifySignature("sha256", signedData, credential.publicKeyPem, signature);
    if (!verified) throw new Error("Invalid passkey signature");

    if (credential.counter !== 0 && parsed.counter !== 0 && parsed.counter <= credential.counter) {
      throw new Error("Passkey signature counter did not advance");
    }

    credential.counter = parsed.counter || credential.counter;
    credential.lastUsedAt = new Date().toISOString();
    const sessionToken = base64url(randomBytes(32));
    store.sessions[sessionToken] = {
      credentialId: credential.id,
      createdAt: Date.now(),
      expiresAt: Date.now() + this.config.sessionTtlMs,
    };
    this.writeStore(store);

    return {
      ok: true,
      sessionToken,
      expiresAt: new Date(store.sessions[sessionToken].expiresAt).toISOString(),
      credential: {
        id: credential.id,
        name: credential.name,
      },
    };
  }

  validateSession(sessionToken: string) {
    if (!this.config.enabled || !sessionToken) return false;
    const store = this.readStore();
    const session = store.sessions[sessionToken];
    if (!session || session.expiresAt <= Date.now()) {
      if (session) {
        delete store.sessions[sessionToken];
        this.writeStore(store);
      }
      return false;
    }
    return store.credentials.some((credential) => credential.id === session.credentialId);
  }

  revokeSession(sessionToken: string) {
    const store = this.readStore();
    delete store.sessions[sessionToken];
    this.writeStore(store);
  }

  listCredentials() {
    const store = this.readStore();
    return store.credentials.map((credential) => ({
      id: credential.id,
      name: credential.name,
      rpId: credential.rpId,
      algorithm: credential.algorithm || PASSKEY_ALGORITHM,
      curve: credential.curve || PASSKEY_CURVE,
      createdAt: credential.createdAt,
      lastUsedAt: credential.lastUsedAt || null,
    }));
  }

  deleteCredential(id: string) {
    const store = this.readStore();
    const before = store.credentials.length;
    store.credentials = store.credentials.filter((credential) => credential.id !== id);
    for (const [token, session] of Object.entries(store.sessions)) {
      if (session.credentialId === id) delete store.sessions[token];
    }
    this.writeStore(store);
    return store.credentials.length !== before;
  }

  listRegistrationCodes() {
    const store = this.readStore();
    return Object.values(store.registrationCodes)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((code) => ({
        id: code.id,
        label: code.label || null,
        source: code.source,
        createdAt: code.createdAt,
        usedAt: code.usedAt || null,
        usedByCredentialId: code.usedByCredentialId || null,
      }));
  }

  createRegistrationCode(label?: string) {
    this.assertEnabled();
    const store = this.readStore();
    const code = base64url(randomBytes(18));
    const createdAt = new Date().toISOString();
    const id = base64url(randomBytes(12));
    store.registrationCodes[id] = {
      id,
      codeHash: hashRegistrationCode(code),
      hashAlgorithm: REGISTRATION_CODE_HASH_ALGORITHM,
      label: label?.trim() || undefined,
      source: "generated",
      createdAt,
    };
    this.writeStore(store);
    return {
      id,
      code,
      label: store.registrationCodes[id].label || null,
      source: "generated" as const,
      createdAt,
      usedAt: null,
      usedByCredentialId: null,
    };
  }

  deleteRegistrationCode(id: string) {
    const store = this.readStore();
    if (!store.registrationCodes[id]) return false;
    delete store.registrationCodes[id];
    this.writeStore(store);
    return true;
  }

  private assertEnabled() {
    if (!this.config.enabled) throw new Error("Passkey authentication is disabled");
  }

  private resolveRp(context: PasskeyRequestContext, required: true): { rpId: string; origin: string };
  private resolveRp(context: PasskeyRequestContext, required: false): { rpId: string; origin: string } | null;
  private resolveRp(context: PasskeyRequestContext, required: boolean) {
    const origin = this.config.origin || context.origin;
    if (this.config.rpId && !this.config.origin) {
      if (required) {
        throw new Error("PASSKEY_ORIGIN must be configured when PASSKEY_RP_ID is configured");
      }
      return null;
    }

    if (!origin) {
      if (required) throw new Error("Passkey origin is not configured and request Origin is missing");
      return null;
    }

    const parsedOrigin = new URL(origin);
    const rpId = this.config.rpId || parsedOrigin.hostname;
    return { rpId, origin: parsedOrigin.origin };
  }

  private assertClientData(
    context: PasskeyRequestContext,
    client: any,
    challenge: PasskeyChallenge,
    expectedType: "webauthn.create" | "webauthn.get"
  ) {
    if (client.type !== expectedType) throw new Error("Unexpected passkey response type");
    if (!sameBase64url(client.challenge, challenge.challenge)) throw new Error("Passkey challenge mismatch");
    const expected = this.resolveRp(context, true);
    if (client.origin !== challenge.origin || client.origin !== expected.origin) {
      throw new Error("Passkey origin mismatch");
    }
  }

  private assertRpIdHash(rpIdHash: Buffer, rpId: string) {
    const expected = sha256(rpId);
    if (rpIdHash.length !== expected.length || !timingSafeEqual(rpIdHash, expected)) {
      throw new Error("Passkey RP ID mismatch");
    }
  }

  private findRegistrationCode(store: PasskeyStore, code: string) {
    const normalized = normalizeRegistrationCode(code);
    if (!normalized) throw new Error("Missing passkey setup code");
    const codeHash = hashRegistrationCode(normalized);
    const entry = Object.values(store.registrationCodes).find(
      (candidate) => !candidate.usedAt && registrationCodeHashMatches(candidate, codeHash)
    );
    if (!entry) throw new Error("Invalid or already used passkey setup code");
    return entry;
  }

  private consumeChallenge(store: PasskeyStore, challengeValue: string, type: PasskeyChallenge["type"]) {
    const challenge = store.challenges[challengeValue];
    if (!challenge || challenge.type !== type) throw new Error("Passkey challenge not found");
    delete store.challenges[challengeValue];
    if (challenge.expiresAt <= Date.now()) {
      this.writeStore(store);
      throw new Error("Passkey challenge expired");
    }
    return challenge;
  }

  private syncConfiguredRegistrationCodes() {
    const configuredCodes = this.config.registrationCodes || [];
    if (configuredCodes.length === 0) return;

    const store = this.readStore();
    let changed = false;
    for (const configured of configuredCodes) {
      const code = normalizeRegistrationCode(configured.code);
      if (!code) continue;
      const codeHash = hashRegistrationCode(code);
      const exists = Object.values(store.registrationCodes).some((entry) =>
        registrationCodeHashMatches(entry, codeHash)
      );
      if (exists) continue;

      const id = base64url(randomBytes(12));
      store.registrationCodes[id] = {
        id,
        codeHash,
        hashAlgorithm: REGISTRATION_CODE_HASH_ALGORITHM,
        label: configured.label?.trim() || undefined,
        source: "env",
        createdAt: new Date().toISOString(),
      };
      changed = true;
    }

    if (changed) this.writeStore(store);
  }

  private readStore(): PasskeyStore {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.config.storeFile, "utf8"));
      const normalizedRegistrationCodes = this.normalizeStoredRegistrationCodes(parsed.registrationCodes || {});
      const store: PasskeyStore = {
        credentials: Array.isArray(parsed.credentials) ? parsed.credentials : [],
        challenges: parsed.challenges || {},
        sessions: parsed.sessions || {},
        registrationCodes: normalizedRegistrationCodes.registrationCodes,
      };
      const cleaned = this.cleanupStore(store);
      if (normalizedRegistrationCodes.changed) {
        try {
          this.writeStore(cleaned);
        } catch {
          // Best effort migration; keep using the normalized in-memory store.
        }
      }
      return cleaned;
    } catch {
      return { ...EMPTY_STORE, challenges: {}, sessions: {}, credentials: [], registrationCodes: {} };
    }
  }

  private normalizeStoredRegistrationCodes(input: Record<string, any>) {
    const registrationCodes: Record<string, StoredRegistrationCode> = {};
    let changed = false;

    for (const [key, value] of Object.entries(input)) {
      if (!value || typeof value !== "object") {
        changed = true;
        continue;
      }

      const id = typeof value.id === "string" && value.id ? value.id : key;
      const codeHash = typeof value.codeHash === "string" && value.codeHash
        ? value.codeHash
        : typeof value.code === "string" && value.code.trim()
          ? hashRegistrationCode(value.code)
          : "";

      if (!codeHash) {
        changed = true;
        continue;
      }

      const hashAlgorithm = value.hashAlgorithm === REGISTRATION_CODE_HASH_ALGORITHM
        ? value.hashAlgorithm
        : REGISTRATION_CODE_HASH_ALGORITHM;

      const normalized: StoredRegistrationCode = {
        id,
        codeHash,
        hashAlgorithm,
        label: typeof value.label === "string" && value.label.trim() ? value.label.trim() : undefined,
        source: value.source === "env" ? "env" : "generated",
        createdAt: typeof value.createdAt === "string" && value.createdAt
          ? value.createdAt
          : new Date().toISOString(),
        usedAt: typeof value.usedAt === "string" ? value.usedAt : undefined,
        usedByCredentialId: typeof value.usedByCredentialId === "string" ? value.usedByCredentialId : undefined,
      };

      registrationCodes[id] = normalized;
      changed ||= key !== id
        || value.id !== id
        || value.codeHash !== normalized.codeHash
        || value.hashAlgorithm !== normalized.hashAlgorithm
        || "code" in value
        || value.label !== normalized.label
        || value.source !== normalized.source
        || value.createdAt !== normalized.createdAt
        || value.usedAt !== normalized.usedAt
        || value.usedByCredentialId !== normalized.usedByCredentialId;
    }

    return { registrationCodes, changed };
  }

  private cleanupStore(store: PasskeyStore) {
    const now = Date.now();
    for (const [challenge, entry] of Object.entries(store.challenges)) {
      if (entry.expiresAt <= now) delete store.challenges[challenge];
    }
    for (const [session, entry] of Object.entries(store.sessions)) {
      if (entry.expiresAt <= now) delete store.sessions[session];
    }
    return store;
  }

  private writeStore(store: PasskeyStore) {
    const dir = path.dirname(this.config.storeFile);
    fs.mkdirSync(dir, { recursive: true });
    const tempFile = path.join(dir, `.${path.basename(this.config.storeFile)}.${process.pid}.${Date.now()}.tmp`);
    let existingOwner: { uid: number; gid: number } | null = null;
    try {
      const existing = fs.statSync(this.config.storeFile);
      existingOwner = { uid: existing.uid, gid: existing.gid };
    } catch {
      try {
        const parent = fs.statSync(dir);
        existingOwner = { uid: parent.uid, gid: parent.gid };
      } catch {
        existingOwner = null;
      }
    }

    try {
      fs.writeFileSync(tempFile, JSON.stringify(this.cleanupStore(store), null, 2), { mode: 0o600 });
      if (existingOwner && typeof process.getuid === "function" && process.getuid() === 0) {
        try {
          fs.chownSync(tempFile, existingOwner.uid, existingOwner.gid);
        } catch {
          // Best effort; owner preservation only works when permitted.
        }
      }
      try {
        fs.chmodSync(tempFile, 0o600);
      } catch {
        // Best effort; some filesystems do not support chmod.
      }
      fs.renameSync(tempFile, this.config.storeFile);
      try {
        fs.chmodSync(this.config.storeFile, 0o600);
      } catch {
        // Best effort; some filesystems do not support chmod.
      }
    } finally {
      try {
        if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
      } catch {
        // Best effort cleanup.
      }
    }
  }
}
