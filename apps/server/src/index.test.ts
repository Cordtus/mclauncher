import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createServer, type Server } from 'http';
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
    delete process.env.ALLOW_CIDRS;
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
          memory_mb: 4096,
          edition: 'fabric',
          mc_version: '1.20.1',
        },
      ],
    }));

    process.env.REGISTRY_FILE = registryFile;
    process.env.ADMIN_TOKEN = 'test-token';
    process.env.ALLOW_CIDRS = '127.0.0.0/8';
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
