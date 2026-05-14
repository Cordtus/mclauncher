import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
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

  it('lets authenticated admins generate one-time passkey setup codes', async () => {
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
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json();
    expect(created.code.label).toBe('Bob phone');
    expect(created.code.code).toEqual(expect.any(String));

    const listResponse = await fetch(`${baseUrl(gateway)}/api/auth/passkeys/registration-codes`, {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(listResponse.status).toBe(200);
    const list = await listResponse.json();
    expect(list.codes).toEqual([
      expect.objectContaining({
        id: created.code.id,
        label: 'Bob phone',
        usedAt: null,
      }),
    ]);
    expect(JSON.stringify(list)).not.toContain(created.code.code);
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
