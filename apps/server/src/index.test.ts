import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createServer, type Server } from 'http';
import { createECDH, createHash } from 'crypto';
import JSZip from 'jszip';

vi.mock('./services/modrinth.js', () => ({
  downloadMod: vi.fn(),
  getModVersions: vi.fn(async () => [
    {
      id: 'version-1',
      files: [
        {
          filename: 'example.jar',
          url: 'https://cdn.modrinth.com/data/example.jar',
          primary: true,
          size: 1234,
          hashes: {
            sha1: 'a'.repeat(40),
            sha512: 'b'.repeat(128),
          },
        },
      ],
    },
  ]),
  getModDetails: vi.fn(async () => ({
    slug: 'example',
    client_side: 'required',
  })),
  searchMods: vi.fn(async () => ({ hits: [] })),
}));

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });
}

function baseUrl(server: Server): string {
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Server is not listening on a TCP port');
  }
  return `http://127.0.0.1:${address.port}`;
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => err ? reject(err) : resolve());
  });
}

function base64url(value: Buffer | string): string {
  return Buffer.from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function cborUnsigned(value: number): Buffer {
  if (value < 24) return Buffer.from([value]);
  if (value < 256) return Buffer.from([0x18, value]);
  throw new Error('Test CBOR encoder only supports small integers');
}

function cborNegative(value: number): Buffer {
  return cborUnsigned(-1 - value).map((byte, index) => index === 0 ? byte | 0x20 : byte);
}

function cborBytes(value: Buffer): Buffer {
  if (value.length < 24) return Buffer.concat([Buffer.from([0x40 | value.length]), value]);
  if (value.length < 256) return Buffer.concat([Buffer.from([0x58, value.length]), value]);
  throw new Error('Test CBOR encoder only supports short byte strings');
}

function cborText(value: string): Buffer {
  const bytes = Buffer.from(value);
  if (bytes.length < 24) return Buffer.concat([Buffer.from([0x60 | bytes.length]), bytes]);
  if (bytes.length < 256) return Buffer.concat([Buffer.from([0x78, bytes.length]), bytes]);
  throw new Error('Test CBOR encoder only supports short text strings');
}

function cborMap(entries: Array<[Buffer, Buffer]>): Buffer {
  return Buffer.concat([Buffer.from([0xa0 | entries.length]), ...entries.flat()]);
}

function buildRegistrationCredential(publicKey: any, rpId: string, origin: string) {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const publicKeyBytes = ecdh.getPublicKey();
  const x = publicKeyBytes.subarray(1, 33);
  const y = publicKeyBytes.subarray(33, 65);
  const credentialId = Buffer.from('test-passkey-credential');
  const coseKey = cborMap([
    [cborUnsigned(1), cborUnsigned(2)],
    [cborUnsigned(3), cborNegative(-7)],
    [cborNegative(-1), cborUnsigned(1)],
    [cborNegative(-2), cborBytes(x)],
    [cborNegative(-3), cborBytes(y)],
  ]);
  const credentialIdLength = Buffer.alloc(2);
  credentialIdLength.writeUInt16BE(credentialId.length);
  const attestedCredentialData = Buffer.concat([
    Buffer.alloc(16),
    credentialIdLength,
    credentialId,
    coseKey,
  ]);
  const counter = Buffer.alloc(4);
  const authData = Buffer.concat([
    createHash('sha256').update(rpId).digest(),
    Buffer.from([0x45]),
    counter,
    attestedCredentialData,
  ]);
  const attestationObject = cborMap([
    [cborText('fmt'), cborText('none')],
    [cborText('authData'), cborBytes(authData)],
    [cborText('attStmt'), cborMap([])],
  ]);
  const clientData = Buffer.from(JSON.stringify({
    type: 'webauthn.create',
    challenge: publicKey.challenge,
    origin,
  }));

  return {
    id: base64url(credentialId),
    rawId: base64url(credentialId),
    type: 'public-key',
    response: {
      clientDataJSON: base64url(clientData),
      attestationObject: base64url(attestationObject),
      transports: ['internal'],
    },
  };
}

describe('management gateway routes', () => {
  const servers: Server[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => close(server)));
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    delete process.env.REGISTRY_FILE;
    delete process.env.SERVER_ARCHIVES_FILE;
    delete process.env.SERVER_LIFECYCLE_COMMAND;
    delete process.env.SERVER_LIFECYCLE_USE_SUDO;
    delete process.env.SERVER_LIFECYCLE_CONTROLLER_URL;
    delete process.env.SERVER_LIFECYCLE_CONTROLLER_TOKEN;
    delete process.env.TEST_CONTROLLER_REQUEST_FILE;
    delete process.env.MAX_ACTIVE_SERVERS;
    delete process.env.ADMIN_TOKEN;
    delete process.env.ADMIN_AUTH_METHODS;
    delete process.env.ADMIN_REQUIRE_CIDR;
    delete process.env.ALLOW_CIDRS;
    delete process.env.AGENT_ALLOWED_CIDRS;
    delete process.env.AGENT_ALLOWED_PORTS;
    delete process.env.PASSKEYS_ENABLED;
    delete process.env.PASSKEY_ORIGIN;
    delete process.env.PASSKEY_REGISTRATION_CODES;
    delete process.env.PASSKEY_RP_ID;
    delete process.env.PASSKEY_STORE_FILE;
    delete process.env.PASSKEY_USER_VERIFICATION;
    delete process.env.TRUST_PROXY;
    delete process.env.TRUST_PROXY_CIDRS;
    delete process.env.WEB_DIST_DIR;
    vi.resetModules();
  });

  it('builds public mrpack exports with the loader version from the server agent', async () => {
    const agent = createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.headers['x-agent-token'] !== 'agent-secret') {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: 'unauthorized agent request' }));
        return;
      }

      if (req.url === '/mods/list') {
        res.end(JSON.stringify({
          mods: [
            {
              fileName: 'example.jar',
              modId: 'example',
              name: 'Example',
              version: '1.0.0',
              loader: 'fabric',
              enabled: true,
              modrinthProjectId: 'project-1',
              modrinthVersionId: 'version-1',
            },
          ],
        }));
        return;
      }

      if (req.url === '/version/current') {
        res.end(JSON.stringify({ type: 'fabric', mcVersion: '1.20.1', build: '0.16.9' }));
        return;
      }

      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not found' }));
    });
    await listen(agent);
    servers.push(agent);

    const tempDir = mkdtempSync(path.join(tmpdir(), 'mc-gateway-test-'));
    tempDirs.push(tempDir);
    const registryFile = path.join(tempDir, 'servers.json');
    writeFileSync(registryFile, JSON.stringify({
      servers: [
        {
          name: 'test-server',
          agent_url: baseUrl(agent),
          agent_token: 'agent-secret',
          public_port: 25565,
          public_domain: 'mc.example.test',
          memory_mb: 4096,
          edition: 'fabric',
          mc_version: '1.20.1',
        },
      ],
    }));

    process.env.REGISTRY_FILE = registryFile;
    process.env.ADMIN_TOKEN = 'test-token';
    process.env.ALLOW_CIDRS = '127.0.0.0/8';
    process.env.AGENT_ALLOWED_CIDRS = '127.0.0.0/8';
    process.env.AGENT_ALLOWED_PORTS = String(new URL(baseUrl(agent)).port);
    process.env.WEB_DIST_DIR = tempDir;

    const { app } = await import('./index.js');
    const gateway = createServer(app);
    await listen(gateway);
    servers.push(gateway);

    const response = await fetch(`${baseUrl(gateway)}/public/test-server/modpack.mrpack`);
    expect(response.status).toBe(200);

    const zip = await JSZip.loadAsync(Buffer.from(await response.arrayBuffer()));
    const index = JSON.parse(await zip.file('modrinth.index.json')!.async('string'));
    expect(index.dependencies).toEqual({
      minecraft: '1.20.1',
      'fabric-loader': '0.16.9',
    });
  });

  it('requires admin auth for sensitive server inventory routes', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'mc-gateway-test-'));
    tempDirs.push(tempDir);
    const registryFile = path.join(tempDir, 'servers.json');
    writeFileSync(registryFile, JSON.stringify({ servers: [] }));

    process.env.REGISTRY_FILE = registryFile;
    process.env.ADMIN_TOKEN = 'test-token';
    process.env.ALLOW_CIDRS = '127.0.0.0/8';
    process.env.WEB_DIST_DIR = tempDir;

    const { app } = await import('./index.js');
    const gateway = createServer(app);
    await listen(gateway);
    servers.push(gateway);

    const noAuthResponse = await fetch(`${baseUrl(gateway)}/api/servers`);
    expect(noAuthResponse.status).toBe(401);

    const noIconAuthResponse = await fetch(`${baseUrl(gateway)}/api/servers/test-server/mods/example.jar/icon`);
    expect(noIconAuthResponse.status).toBe(401);

    const badAuthResponse = await fetch(`${baseUrl(gateway)}/api/servers`, {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    expect(badAuthResponse.status).toBe(401);

    const adminResponse = await fetch(`${baseUrl(gateway)}/api/servers`, {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(adminResponse.status).toBe(200);
    expect(await adminResponse.json()).toEqual([]);
  });

  it('allows admin auth attempts from the default WireGuard VPN CIDR', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'mc-gateway-test-'));
    tempDirs.push(tempDir);
    const registryFile = path.join(tempDir, 'servers.json');
    writeFileSync(registryFile, JSON.stringify({ servers: [] }));

    process.env.REGISTRY_FILE = registryFile;
    process.env.ADMIN_TOKEN = 'test-token';
    process.env.ADMIN_REQUIRE_CIDR = 'true';
    process.env.TRUST_PROXY = 'true';
    process.env.WEB_DIST_DIR = tempDir;

    const { app } = await import('./index.js');
    const gateway = createServer(app);
    await listen(gateway);
    servers.push(gateway);

    const response = await fetch(`${baseUrl(gateway)}/api/servers`, {
      headers: { 'X-Forwarded-For': '10.172.19.42' },
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
  });

  it('exchanges an admin token for an HttpOnly cookie session', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'mc-gateway-test-'));
    tempDirs.push(tempDir);
    const registryFile = path.join(tempDir, 'servers.json');
    writeFileSync(registryFile, JSON.stringify({ servers: [] }));

    process.env.REGISTRY_FILE = registryFile;
    process.env.ADMIN_TOKEN = 'test-token';
    process.env.ALLOW_CIDRS = '127.0.0.0/8';
    process.env.WEB_DIST_DIR = tempDir;

    const { app } = await import('./index.js');
    const gateway = createServer(app);
    await listen(gateway);
    servers.push(gateway);

    const loginResponse = await fetch(`${baseUrl(gateway)}/api/auth/token/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'test-token' }),
    });
    expect(loginResponse.status).toBe(200);

    const setCookie = loginResponse.headers.get('set-cookie') || '';
    expect(setCookie).toContain('mclx_admin=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');

    const sessionResponse = await fetch(`${baseUrl(gateway)}/api/auth/session`, {
      headers: { Cookie: setCookie.split(';')[0] },
    });
    expect(sessionResponse.status).toBe(200);
    expect(await sessionResponse.json()).toEqual({ authenticated: true });
  });

  it('offers passkey login without an admin token when a passkey is already registered', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'mc-gateway-test-'));
    tempDirs.push(tempDir);
    const registryFile = path.join(tempDir, 'servers.json');
    const passkeyStoreFile = path.join(tempDir, 'passkeys.json');
    writeFileSync(registryFile, JSON.stringify({ servers: [] }));
    writeFileSync(passkeyStoreFile, JSON.stringify({
      credentials: [
        {
          id: 'cmVnaXN0ZXJlZC1wYXNza2V5',
          name: 'Admin passkey',
          rpId: 'gateway.example.test',
          origin: 'https://gateway.example.test',
          publicKeyPem: 'unused in option generation',
          counter: 0,
          transports: ['internal'],
          createdAt: new Date().toISOString(),
        },
      ],
      challenges: {},
      sessions: {},
    }));

    process.env.REGISTRY_FILE = registryFile;
    process.env.ALLOW_CIDRS = '127.0.0.0/8';
    process.env.WEB_DIST_DIR = tempDir;
    process.env.PASSKEY_ORIGIN = 'https://gateway.example.test';
    process.env.PASSKEY_STORE_FILE = passkeyStoreFile;

    const { app } = await import('./index.js');
    const gateway = createServer(app);
    await listen(gateway);
    servers.push(gateway);

    const sessionResponse = await fetch(`${baseUrl(gateway)}/api/auth/session`);
    expect(sessionResponse.status).toBe(401);

    const optionsResponse = await fetch(`${baseUrl(gateway)}/api/auth/passkeys/login/options`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(optionsResponse.status).toBe(200);
    const body = await optionsResponse.json();
    expect(body.publicKey.rpId).toBe('gateway.example.test');
    expect(body.publicKey.allowCredentials).toEqual([
      {
        id: 'cmVnaXN0ZXJlZC1wYXNza2V5',
        type: 'public-key',
      },
    ]);
  });

  it('allows a one-time setup code to create passkey registration options without admin auth', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'mc-gateway-test-'));
    tempDirs.push(tempDir);
    const registryFile = path.join(tempDir, 'servers.json');
    const passkeyStoreFile = path.join(tempDir, 'passkeys.json');
    writeFileSync(registryFile, JSON.stringify({ servers: [] }));

    process.env.REGISTRY_FILE = registryFile;
    process.env.WEB_DIST_DIR = tempDir;
    process.env.PASSKEY_ORIGIN = 'https://gateway.example.test';
    process.env.PASSKEY_REGISTRATION_CODES = 'alice:setup-secret';
    process.env.PASSKEY_STORE_FILE = passkeyStoreFile;

    const { app } = await import('./index.js');
    const gateway = createServer(app);
    await listen(gateway);
    servers.push(gateway);

    const optionsResponse = await fetch(`${baseUrl(gateway)}/api/auth/passkeys/register/options`, {
      method: 'POST',
      headers: {
        Origin: baseUrl(gateway),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'Alice', setupCode: 'setup-secret' }),
    });
    expect(optionsResponse.status).toBe(200);
    const optionsBody = await optionsResponse.json();
    expect(optionsBody.publicKey.pubKeyCredParams).toEqual([{ type: 'public-key', alg: -7 }]);

    const store = JSON.parse(readFileSync(passkeyStoreFile, 'utf8'));
    const [setupCode] = Object.values(store.registrationCodes) as any[];
    expect(setupCode.label).toBe('alice');
    expect(setupCode.usedAt).toBeUndefined();
    expect(setupCode.codeHash).not.toContain('setup-secret');

    const reusedCodeResponse = await fetch(`${baseUrl(gateway)}/api/auth/passkeys/register/options`, {
      method: 'POST',
      headers: {
        Origin: baseUrl(gateway),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'Alice again', setupCode: 'setup-secret' }),
    });
    expect(reusedCodeResponse.status).toBe(200);

    const adminResponse = await fetch(`${baseUrl(gateway)}/api/servers`);
    expect(adminResponse.status).toBe(503);
  });

  it('spends a one-time setup code only after passkey registration verifies', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'mc-gateway-test-'));
    tempDirs.push(tempDir);
    const registryFile = path.join(tempDir, 'servers.json');
    const passkeyStoreFile = path.join(tempDir, 'passkeys.json');
    writeFileSync(registryFile, JSON.stringify({ servers: [] }));

    process.env.REGISTRY_FILE = registryFile;
    process.env.WEB_DIST_DIR = tempDir;
    process.env.PASSKEY_ORIGIN = 'https://gateway.example.test';
    process.env.PASSKEY_REGISTRATION_CODES = 'alice:setup-secret';
    process.env.PASSKEY_STORE_FILE = passkeyStoreFile;

    const { app } = await import('./index.js');
    const gateway = createServer(app);
    await listen(gateway);
    servers.push(gateway);

    const optionsResponse = await fetch(`${baseUrl(gateway)}/api/auth/passkeys/register/options`, {
      method: 'POST',
      headers: {
        Origin: baseUrl(gateway),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'Alice', setupCode: 'setup-secret' }),
    });
    expect(optionsResponse.status).toBe(200);
    const optionsBody = await optionsResponse.json();
    const credential = buildRegistrationCredential(
      optionsBody.publicKey,
      'gateway.example.test',
      'https://gateway.example.test'
    );

    const verifyResponse = await fetch(`${baseUrl(gateway)}/api/auth/passkeys/register/verify`, {
      method: 'POST',
      headers: {
        Origin: baseUrl(gateway),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(credential),
    });
    expect(verifyResponse.status).toBe(200);
    expect(verifyResponse.headers.get('set-cookie')).toContain('mclx_admin=passkey.');
    expect(await verifyResponse.json()).toEqual({
      ok: true,
      credentialId: credential.id,
      expiresAt: expect.any(String),
    });

    const store = JSON.parse(readFileSync(passkeyStoreFile, 'utf8'));
    const [setupCode] = Object.values(store.registrationCodes) as any[];
    expect(setupCode.usedAt).toEqual(expect.any(String));
    expect(setupCode.usedByCredentialId).toBe(credential.id);
    expect(store.credentials).toEqual([
      expect.objectContaining({
        id: credential.id,
        name: 'Alice',
        algorithm: 'ES256',
        curve: 'P-256',
      }),
    ]);

    const reusedCodeResponse = await fetch(`${baseUrl(gateway)}/api/auth/passkeys/register/options`, {
      method: 'POST',
      headers: {
        Origin: baseUrl(gateway),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'Alice again', setupCode: 'setup-secret' }),
    });
    expect(reusedCodeResponse.status).toBe(401);
  });

  it('requires the root-only host command to generate one-time passkey setup codes', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'mc-gateway-test-'));
    tempDirs.push(tempDir);
    const registryFile = path.join(tempDir, 'servers.json');
    const passkeyStoreFile = path.join(tempDir, 'passkeys.json');
    writeFileSync(registryFile, JSON.stringify({ servers: [] }));

    process.env.REGISTRY_FILE = registryFile;
    process.env.ADMIN_TOKEN = 'test-token';
    process.env.WEB_DIST_DIR = tempDir;
    process.env.PASSKEY_STORE_FILE = passkeyStoreFile;

    const { app } = await import('./index.js');
    const gateway = createServer(app);
    await listen(gateway);
    servers.push(gateway);

    const createResponse = await fetch(`${baseUrl(gateway)}/api/auth/passkeys/registration-codes`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ label: 'Bob phone' }),
    });
    expect(createResponse.status).toBe(405);
    const rejected = await createResponse.json();
    expect(rejected.error).toContain('root-only host command');

    const listResponse = await fetch(`${baseUrl(gateway)}/api/auth/passkeys/registration-codes`, {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(listResponse.status).toBe(200);
    const list = await listResponse.json();
    expect(list.codes).toEqual([]);
  });

  it('lets the root-only operator command generate one-time passkey setup codes', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'mc-gateway-test-'));
    tempDirs.push(tempDir);
    const registryFile = path.join(tempDir, 'servers.json');
    const passkeyStoreFile = path.join(tempDir, 'passkeys.json');
    writeFileSync(registryFile, JSON.stringify({ servers: [] }));

    process.env.REGISTRY_FILE = registryFile;
    process.env.ADMIN_AUTH_METHODS = 'passkey,token';
    process.env.ADMIN_TOKEN = 'test-token';
    process.env.WEB_DIST_DIR = tempDir;
    process.env.PASSKEY_STORE_FILE = passkeyStoreFile;

    const { createPasskeySetupCodeForCommand } = await import('./index.js');

    const blocked = () => createPasskeySetupCodeForCommand(['--label', 'Host invite'], {
      getuid: () => 1000,
    });
    expect(blocked).toThrow('must be run as root');

    const result = createPasskeySetupCodeForCommand(['--label', 'Host invite', '--json'], {
      requireRoot: false,
    });
    expect(result.help).toBe(false);
    if (result.help) throw new Error('unexpected help result');
    expect(result.code.label).toBe('Host invite');
    expect(result.code.code).toEqual(expect.any(String));
    expect(JSON.parse(result.output).code).toBe(result.code.code);

    const storeText = readFileSync(passkeyStoreFile, 'utf8');
    expect(storeText).not.toContain(result.code.code);
    const store = JSON.parse(storeText);
    const [storedCode] = Object.values(store.registrationCodes) as any[];
    expect(storedCode).toEqual(expect.objectContaining({
      id: result.code.id,
      label: 'Host invite',
      source: 'generated',
      hashAlgorithm: 'sha256',
    }));
    expect(storedCode.codeHash).toEqual(expect.any(String));
    expect(storedCode.code).toBeUndefined();
    expect(storedCode.usedAt).toBeUndefined();
  });

  it('blocks cookie-authenticated unsafe API requests without a same-origin header', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'mc-gateway-test-'));
    tempDirs.push(tempDir);
    const registryFile = path.join(tempDir, 'servers.json');
    writeFileSync(registryFile, JSON.stringify({ servers: [] }));

    process.env.REGISTRY_FILE = registryFile;
    process.env.ADMIN_TOKEN = 'test-token';
    process.env.ALLOW_CIDRS = '127.0.0.0/8';
    process.env.WEB_DIST_DIR = tempDir;

    const { app } = await import('./index.js');
    const gateway = createServer(app);
    await listen(gateway);
    servers.push(gateway);

    const loginResponse = await fetch(`${baseUrl(gateway)}/api/auth/token/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'test-token' }),
    });
    const cookie = (loginResponse.headers.get('set-cookie') || '').split(';')[0];

    const blockedResponse = await fetch(`${baseUrl(gateway)}/api/servers/test-server/config`, {
      method: 'PATCH',
      headers: {
        Cookie: cookie,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ public_domain: 'mc.example.test' }),
    });
    expect(blockedResponse.status).toBe(403);

    const allowedResponse = await fetch(`${baseUrl(gateway)}/api/servers/test-server/config`, {
      method: 'PATCH',
      headers: {
        Cookie: cookie,
        Origin: baseUrl(gateway),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ public_domain: 'mc.example.test' }),
    });
    expect(allowedResponse.status).toBe(404);
  });

  it('rejects server registration with an agent URL outside the allowed agent network', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'mc-gateway-test-'));
    tempDirs.push(tempDir);
    const registryFile = path.join(tempDir, 'servers.json');
    writeFileSync(registryFile, JSON.stringify({ servers: [] }));

    process.env.REGISTRY_FILE = registryFile;
    process.env.ADMIN_TOKEN = 'test-token';
    process.env.ALLOW_CIDRS = '127.0.0.0/8';
    process.env.WEB_DIST_DIR = tempDir;

    const { app } = await import('./index.js');
    const gateway = createServer(app);
    await listen(gateway);
    servers.push(gateway);

    const response = await fetch(`${baseUrl(gateway)}/api/servers/register`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'bad-agent',
        agent_url: 'http://169.254.169.254:9090',
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'agent_url host is outside allowed agent CIDRs' });
  });

  it('enforces the active server limit when registering servers', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'mc-gateway-test-'));
    tempDirs.push(tempDir);
    const registryFile = path.join(tempDir, 'servers.json');
    writeFileSync(registryFile, JSON.stringify({
      servers: [1, 2, 3].map((index) => ({
        name: `mc-server-${index}`,
        agent_url: `http://127.0.0.${index}:9090`,
        public_port: 34566 + index,
        memory_mb: 2048,
        edition: 'paper',
        mc_version: '1.21.1',
      })),
    }));

    process.env.REGISTRY_FILE = registryFile;
    process.env.ADMIN_TOKEN = 'test-token';
    process.env.ALLOW_CIDRS = '127.0.0.0/8';
    process.env.AGENT_ALLOWED_CIDRS = '127.0.0.0/8';
    process.env.WEB_DIST_DIR = tempDir;

    const { app } = await import('./index.js');
    const gateway = createServer(app);
    await listen(gateway);
    servers.push(gateway);

    const response = await fetch(`${baseUrl(gateway)}/api/servers/register`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'mc-server-4',
        agent_url: 'http://127.0.0.4:9090',
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Maximum active server limit reached (3)' });
  });

  it('reports lifecycle slots and archives without exposing lifecycle mutation access', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'mc-gateway-test-'));
    tempDirs.push(tempDir);
    const registryFile = path.join(tempDir, 'servers.json');
    const archivesFile = path.join(tempDir, 'server-archives.json');
    writeFileSync(registryFile, JSON.stringify({
      servers: [
        {
          name: 'mc-server-1',
          agent_url: 'http://127.0.0.1:9090',
          public_port: 34567,
          memory_mb: 4096,
          edition: 'paper',
          mc_version: '1.21.1',
        },
      ],
    }));
    writeFileSync(archivesFile, JSON.stringify({
      archives: [
        {
          id: 'mc-server-2-archive',
          sourceName: 'mc-server-2',
          imageAlias: 'mc-archive-mc-server-2',
          createdAt: '2026-05-17T00:00:00.000Z',
          server: {
            name: 'mc-server-2',
            public_port: 34568,
            memory_mb: 4096,
            edition: 'paper',
            mc_version: '1.21.1',
          },
        },
      ],
    }));

    process.env.REGISTRY_FILE = registryFile;
    process.env.SERVER_ARCHIVES_FILE = archivesFile;
    process.env.SERVER_LIFECYCLE_COMMAND = 'echo';
    process.env.ADMIN_TOKEN = 'test-token';
    process.env.ALLOW_CIDRS = '127.0.0.0/8';
    process.env.WEB_DIST_DIR = tempDir;

    const { app } = await import('./index.js');
    const gateway = createServer(app);
    await listen(gateway);
    servers.push(gateway);

    const response = await fetch(`${baseUrl(gateway)}/api/server-lifecycle`, {
      headers: { Authorization: 'Bearer test-token' },
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      configured: true,
      maxActiveServers: 3,
      activeServers: 1,
      slotsAvailable: 2,
    });
    expect(body.archives).toHaveLength(1);
    expect(body.archives[0].id).toBe('mc-server-2-archive');
  });

  it('routes lifecycle mutations through the controller entry point only', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'mc-gateway-test-'));
    tempDirs.push(tempDir);
    const registryFile = path.join(tempDir, 'servers.json');
    const controllerFile = path.join(tempDir, 'controller.cjs');
    const requestFile = path.join(tempDir, 'controller-request.json');
    writeFileSync(registryFile, JSON.stringify({ servers: [] }));
    writeFileSync(controllerFile, [
      '#!/usr/bin/env node',
      'const fs = require("fs");',
      'const request = JSON.parse(fs.readFileSync(0, "utf8"));',
      'fs.writeFileSync(process.env.TEST_CONTROLLER_REQUEST_FILE, JSON.stringify({ argv: process.argv.slice(2), request }, null, 2));',
      'process.stdout.write(JSON.stringify({ ok: true, message: `controlled ${request.action}` }));',
      '',
    ].join('\n'));
    chmodSync(controllerFile, 0o755);

    process.env.REGISTRY_FILE = registryFile;
    process.env.SERVER_LIFECYCLE_COMMAND = controllerFile;
    process.env.TEST_CONTROLLER_REQUEST_FILE = requestFile;
    process.env.ADMIN_TOKEN = 'test-token';
    process.env.ALLOW_CIDRS = '127.0.0.0/8';
    process.env.WEB_DIST_DIR = tempDir;

    const { app } = await import('./index.js');
    const gateway = createServer(app);
    await listen(gateway);
    servers.push(gateway);

    const response = await fetch(`${baseUrl(gateway)}/api/server-lifecycle/create`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'mc-server-2',
        edition: 'paper',
        mc_version: '1.21.1',
        memory_mb: 4096,
        cpu_limit: '2',
        public_port: 34568,
        manager_container: 'not-forwarded',
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, message: 'controlled create' });

    const recorded = JSON.parse(readFileSync(requestFile, 'utf8'));
    expect(recorded.argv).toEqual(['controller', '--json']);
    expect(recorded.request).toEqual({
      action: 'create',
      params: {
        name: 'mc-server-2',
        edition: 'paper',
        mcVersion: '1.21.1',
        memoryMb: 4096,
        cpuLimit: '2',
        publicPort: 34568,
      },
    });
  });

  it('routes lifecycle mutations through a host lifecycle controller URL when configured', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'mc-gateway-test-'));
    tempDirs.push(tempDir);
    const registryFile = path.join(tempDir, 'servers.json');
    const requestFile = path.join(tempDir, 'controller-url-request.json');
    writeFileSync(registryFile, JSON.stringify({ servers: [] }));

    const lifecycleController = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        writeFileSync(requestFile, JSON.stringify({
          method: req.method,
          url: req.url,
          authorization: req.headers.authorization,
          body,
        }, null, 2));
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, message: `url ${body.action}` }));
      });
    });
    await listen(lifecycleController);
    servers.push(lifecycleController);

    process.env.REGISTRY_FILE = registryFile;
    process.env.SERVER_LIFECYCLE_CONTROLLER_URL = baseUrl(lifecycleController);
    process.env.SERVER_LIFECYCLE_CONTROLLER_TOKEN = 'x'.repeat(32);
    process.env.ADMIN_TOKEN = 'test-token';
    process.env.ALLOW_CIDRS = '127.0.0.0/8';
    process.env.WEB_DIST_DIR = tempDir;

    const { app } = await import('./index.js');
    const gateway = createServer(app);
    await listen(gateway);
    servers.push(gateway);

    const response = await fetch(`${baseUrl(gateway)}/api/server-lifecycle/archives/archive-1/restore`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'mc-server-2',
        public_port: 34568,
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, message: 'url restore' });

    const recorded = JSON.parse(readFileSync(requestFile, 'utf8'));
    expect(recorded.method).toBe('POST');
    expect(recorded.url).toBe('/lifecycle');
    expect(recorded.authorization).toBe(`Bearer ${'x'.repeat(32)}`);
    expect(recorded.body).toEqual({
      action: 'restore',
      params: {
        archiveId: 'archive-1',
        name: 'mc-server-2',
        publicPort: 34568,
      },
    });
  });

  it('does not expose agent tokens when saving server config', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'mc-gateway-test-'));
    tempDirs.push(tempDir);
    const registryFile = path.join(tempDir, 'servers.json');
    writeFileSync(registryFile, JSON.stringify({
      servers: [
        {
          name: 'test-server',
          agent_url: 'http://127.0.0.1:9090',
          agent_token: 'agent-secret',
          public_port: 25565,
          memory_mb: 4096,
          edition: 'fabric',
          mc_version: '1.20.1',
        },
      ],
    }), { mode: 0o644 });

    process.env.REGISTRY_FILE = registryFile;
    process.env.ADMIN_TOKEN = 'test-token';
    process.env.ALLOW_CIDRS = '127.0.0.0/8';
    process.env.WEB_DIST_DIR = tempDir;

    const { app } = await import('./index.js');
    const gateway = createServer(app);
    await listen(gateway);
    servers.push(gateway);

    const response = await fetch(`${baseUrl(gateway)}/api/servers/test-server/config`, {
      method: 'PATCH',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ public_domain: 'mc.example.test' }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.server.agent_token).toBeUndefined();

    const saved = JSON.parse(readFileSync(registryFile, 'utf8'));
    expect(saved.servers[0].agent_token).toBe('agent-secret');
    expect(statSync(registryFile).mode & 0o777).toBe(0o600);
  });
});
