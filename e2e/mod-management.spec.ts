import { expect, type Page, type Route, test } from '@playwright/test';

const fabricServer = {
  name: 'mc-fabric',
  status: 'Running',
  local_ip: '10.70.48.21',
  local_port: 25565,
  host_ip: '192.168.0.170',
  host_proxy_port: 34567,
  public_port: 25565,
  public_domain: 'play.example.test',
  memory_mb: 4096,
  cpu_limit: '2',
  edition: 'fabric',
  mc_version: '1.21.1',
  minecraft: {
    online: true,
    players: { online: 1, max: 20 },
    description: 'Fabric test server',
    version: '1.21.1',
    latency: 12,
  },
};

const paperServer = {
  ...fabricServer,
  name: 'mc-paper',
  edition: 'paper',
  public_domain: 'paper.example.test',
};

const installedMods = [
  {
    fileName: 'sodium.jar',
    modId: 'sodium',
    name: 'Sodium',
    version: '0.6.0',
    description: 'Rendering optimization mod',
    authors: ['CaffeineMC'],
    loader: 'fabric',
    enabled: true,
  },
  {
    fileName: 'lithium.jar.disabled',
    modId: 'lithium',
    name: 'Lithium',
    version: '0.14.0',
    description: 'Server optimization mod',
    authors: ['CaffeineMC'],
    loader: 'fabric',
    enabled: false,
  },
];

const publicFabricServer = {
  name: fabricServer.name,
  status: 'Running',
  edition: fabricServer.edition,
  mc_version: fabricServer.mc_version,
  public_address: 'play.example.test',
  players: { online: 1, max: 20 },
  description: 'Fabric test server',
  version: '1.21.1',
  latency: 12,
  requires_client_mods: true,
  modpack_url: '/public/mc-fabric/modpack',
  mrpack_url: '/public/mc-fabric/modpack.mrpack',
  modlist_url: '/public/mc-fabric/modlist.txt',
};

async function fulfillMethod(route: Route, method: string, options: Parameters<Route['fulfill']>[0]) {
  const actual = route.request().method();
  if (actual !== method) {
    await route.fulfill({ status: 405, json: { error: `Expected ${method}, received ${actual}` } });
    expect(actual).toBe(method);
    return;
  }

  await route.fulfill(options);
}

async function mockAuthenticatedConsole(page: Page) {
  let worlds = [
    { name: 'world', size: 1024, lastPlayed: '2026-05-18T00:00:00.000Z', isActive: true },
    { name: 'old-world', size: 2048, lastPlayed: '2026-05-17T00:00:00.000Z', isActive: false },
  ];
  let plugins = [
    {
      fileName: 'luckperms.jar',
      pluginId: 'luckperms',
      name: 'LuckPerms',
      version: '5.4.0',
      description: 'Permissions management',
      authors: ['Luck'],
      enabled: true,
    },
  ];

  await page.route('**/api/auth/config', async (route) => {
    await fulfillMethod(route, 'GET', {
      json: {
        authMethods: ['passkey'],
        passkeys: {
          enabled: true,
          hasPasskeys: true,
          registrationCodesAvailable: false,
        },
      },
    });
  });

  await page.route('**/api/auth/session', async (route) => {
    await fulfillMethod(route, 'GET', { status: 200, json: { authenticated: true } });
  });

  await page.route('**/api/servers', async (route) => {
    await fulfillMethod(route, 'GET', { json: [fabricServer, paperServer] });
  });

  await page.route('**/api/server-lifecycle', async (route) => {
    await fulfillMethod(route, 'GET', {
      json: {
        configured: true,
        maxActiveServers: 3,
        activeServers: 1,
        slotsAvailable: 2,
        archives: [],
      },
    });
  });

  await page.route('**/api/servers/mc-fabric/mods/installed', async (route) => {
    await fulfillMethod(route, 'GET', { json: { mods: installedMods } });
  });

  await page.route('**/api/servers/mc-fabric/logs', async (route) => {
    await fulfillMethod(route, 'GET', {
      contentType: 'text/plain',
      body: '[00:00:00] [Server thread/INFO]: Server running',
    });
  });

  await page.route('**/api/servers/mc-fabric/tps', async (route) => {
    await fulfillMethod(route, 'GET', { json: { raw: 'TPS command unavailable' } });
  });

  await page.route('**/api/servers/mc-fabric/check-public', async (route) => {
    await fulfillMethod(route, 'GET', { json: { accessible: true } });
  });

  await page.route('**/api/servers/mc-fabric/mods/manifest', async (route) => {
    await fulfillMethod(route, 'GET', {
      json: {
        server: {
          name: fabricServer.name,
          edition: fabricServer.edition,
          mc_version: fabricServer.mc_version,
          public_address: 'play.example.test',
          local_address: '192.168.0.170:34567',
        },
        mods: installedMods,
      },
    });
  });

  await page.route('**/api/servers/mc-fabric/mods/*/icon', async (route) => {
    await fulfillMethod(route, 'GET', { status: 404, body: '' });
  });

  await page.route('**/api/servers/mc-fabric/mods/*/toggle', async (route) => {
    await fulfillMethod(route, 'PATCH', { json: { success: true, newFileName: 'sodium.jar.disabled' } });
  });

  await page.route('**/api/servers/mc-fabric/mods/sodium/configs', async (route) => {
    await fulfillMethod(route, 'GET', { json: { configs: [] } });
  });

  await page.route('**/api/servers/mc-fabric/worlds/details', async (route) => {
    await fulfillMethod(route, 'GET', { json: worlds });
  });

  await page.route('**/api/servers/mc-fabric/worlds/generate', async (route) => {
    if (route.request().method() !== 'POST') {
      await fulfillMethod(route, 'POST', { json: { ok: false } });
      return;
    }

    const body = route.request().postDataJSON() as { name: string };
    worlds = worlds.map((world) => ({ ...world, isActive: false }));
    worlds.push({ name: body.name, size: 4096, lastPlayed: '2026-05-18T01:00:00.000Z', isActive: true });
    await route.fulfill({ json: { ok: true, message: `World '${body.name}' generated` } });
  });

  await page.route('**/api/servers/mc-fabric/worlds/*/backup', async (route) => {
    await fulfillMethod(route, 'POST', { json: { ok: true, backupPath: '/var/backups/minecraft/worlds/old-world.tar.gz' } });
  });

  await page.route('**/api/servers/mc-fabric/worlds/*/download', async (route) => {
    await fulfillMethod(route, 'GET', {
      headers: { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="old-world.zip"' },
      body: 'zip-data',
    });
  });

  await page.route('**/api/servers/mc-fabric/worlds/*', async (route) => {
    if (route.request().method() === 'DELETE') {
      const worldName = route.request().url().split('/').pop() || '';
      worlds = worlds.filter((world) => world.name !== decodeURIComponent(worldName));
      await route.fulfill({ json: { ok: true, message: 'World deleted' } });
      return;
    }
    await route.fallback();
  });

  await page.route('**/api/servers/mc-paper/plugins/installed', async (route) => {
    await fulfillMethod(route, 'GET', { json: { plugins } });
  });

  await page.route('**/api/servers/mc-paper/plugins/*/toggle', async (route) => {
    plugins = plugins.map((plugin) => ({ ...plugin, enabled: false, fileName: 'luckperms.jar.disabled' }));
    await fulfillMethod(route, 'PATCH', {
      json: { ok: true, message: 'Plugin disabled', newFileName: 'luckperms.jar.disabled' },
    });
  });

  await page.route('**/api/servers/mc-paper/plugins/*', async (route) => {
    if (route.request().method() === 'DELETE') {
      plugins = [];
      await route.fulfill({ json: { ok: true, message: 'Plugin removed' } });
      return;
    }
    await route.fallback();
  });
}

async function mockPublicDirectory(page: Page) {
  const state = {
    generatedAt: '2026-05-18T00:00:00.000Z',
    servers: [publicFabricServer],
  };

  await page.route('**/api/auth/config', async (route) => {
    await fulfillMethod(route, 'GET', {
      json: {
        authMethods: ['passkey'],
        passkeys: {
          enabled: true,
          hasPasskeys: true,
          registrationCodesAvailable: false,
        },
      },
    });
  });

  await page.route('**/api/auth/session', async (route) => {
    await fulfillMethod(route, 'GET', { status: 200, json: { authenticated: false } });
  });

  await page.route('**/api/public/servers', async (route) => {
    await fulfillMethod(route, 'GET', { json: state.servers });
  });

  await page.route('**/api/public/servers/events', async (route) => {
    await fulfillMethod(route, 'GET', {
      contentType: 'text/event-stream',
      body: `event: public-server-state\ndata: ${JSON.stringify(state)}\n\n`,
    });
  });
}

async function mockDevAdminLogin(page: Page) {
  let authenticated = false;

  await page.route('**/api/auth/config', async (route) => {
    await fulfillMethod(route, 'GET', {
      json: {
        authMethods: ['passkey'],
        devLogin: { enabled: true },
        passkeys: {
          enabled: true,
          hasPasskeys: true,
          registrationCodesAvailable: false,
        },
      },
    });
  });

  await page.route('**/api/auth/session', async (route) => {
    await fulfillMethod(route, 'GET', { status: 200, json: { authenticated } });
  });

  await page.route('**/api/auth/dev/login', async (route) => {
    authenticated = true;
    await fulfillMethod(route, 'POST', { json: { ok: true, expiresAt: '2026-05-18T12:00:00.000Z' } });
  });

  await page.route('**/api/servers', async (route) => {
    await fulfillMethod(route, 'GET', { json: [fabricServer] });
  });

  await page.route('**/api/server-lifecycle', async (route) => {
    await fulfillMethod(route, 'GET', {
      json: {
        configured: true,
        maxActiveServers: 3,
        activeServers: 1,
        slotsAvailable: 2,
        archives: [],
      },
    });
  });

  await page.route('**/api/servers/events', async (route) => {
    await fulfillMethod(route, 'GET', {
      contentType: 'text/event-stream',
      body: `event: server-state\ndata: ${JSON.stringify({ servers: [fabricServer], lifecycle: null })}\n\n`,
    });
  });
}

test.describe('Migrated management UI', () => {
  test('renders a read-only public server directory for signed-out players', async ({ page }) => {
    await mockPublicDirectory(page);
    await page.goto('/');

    await expect(page.locator('h1', { hasText: 'Server List' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Server List' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Login' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'mc-fabric' })).toBeVisible();
    await expect(page.getByText('play.example.test')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Copy IP' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create Server' })).not.toBeVisible();
  });

  test('keeps the admin login behind the admin route', async ({ page }) => {
    await mockPublicDirectory(page);
    await page.goto('/admin');

    await expect(page.locator('h1', { hasText: 'Sign In' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Passkey' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Hide Passkey Setup' })).not.toBeVisible();
  });

  test('supports dev admin login without a passkey', async ({ page }) => {
    await mockDevAdminLogin(page);
    await page.goto('/admin');

    await expect(page.getByRole('heading', { name: 'Dev Login' })).toBeVisible();
    await page
      .locator('section')
      .filter({ hasText: 'Dev Login' })
      .getByRole('button', { name: 'Sign In', exact: true })
      .click();
    await expect(page.getByRole('main').getByRole('button', { name: 'Sign Out' })).toBeVisible();
  });

  test('opens the preserved mod management panel from the new content workspace', async ({ page }) => {
    await mockAuthenticatedConsole(page);
    await page.goto('/');

    await expect(page.locator('h1', { hasText: 'Servers' })).toBeVisible();
    await page.getByRole('button', { name: /mc-fabric/i }).click();
    await expect(page.getByRole('heading', { name: 'mc-fabric' })).toBeVisible();

    await page.getByRole('tab', { name: /Content/i }).click();
    await expect(page.getByRole('heading', { name: 'Installed Mods' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Share Modpack' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Friend Setup' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Browse Mods' })).toBeVisible();
    await expect(page.getByText('Sodium')).toBeVisible();
  });

  test('keeps the overview usable when TPS is unavailable', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await mockAuthenticatedConsole(page);
    const tpsResponse = page.waitForResponse((response) =>
      response.url().includes('/api/servers/mc-fabric/tps') && response.status() === 200
    );
    await page.goto('/server/mc-fabric');
    await tpsResponse;

    await expect(page.getByRole('heading', { name: 'mc-fabric' })).toBeVisible();
    await expect(page.getByText('TPS')).toBeVisible();
    await expect(page.getByText('N/A')).toBeVisible();
    expect(pageErrors).toEqual([]);
  });

  test('keeps installed-mod filtering and toggle feedback working', async ({ page }) => {
    await mockAuthenticatedConsole(page);
    await page.goto('/server/mc-fabric/content');

    await expect(page.getByRole('heading', { name: 'Installed Mods' })).toBeVisible();
    await page.getByPlaceholder('Search installed mods...').fill('sodium');
    await expect(page.getByText('Sodium')).toBeVisible();
    await expect(page.getByText('Lithium')).not.toBeVisible();

    const toggle = page.getByRole('switch').first();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await toggle.click();
    await expect(page.getByText('Mod disabled. Restart server to apply.')).toBeVisible();
  });

  test('implements world generation, backup, download, and deletion controls', async ({ page }) => {
    await mockAuthenticatedConsole(page);
    await page.goto('/server/mc-fabric/worlds');

    await expect(page.getByRole('heading', { name: 'Worlds' })).toBeVisible();
    await expect(page.getByText('old-world')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Download' }).nth(1)).toBeVisible();

    await page.getByRole('button', { name: 'Backup' }).nth(1).click();
    await expect(page.getByText(/World backup created/)).toBeVisible();

    await page.getByRole('button', { name: 'Generate' }).click();
    await page.getByPlaceholder('survival-season-2').fill('new-world');
    await page.getByRole('dialog').getByRole('button', { name: 'Generate' }).click();
    await expect(page.getByRole('tabpanel', { name: 'Worlds' }).getByText('new-world')).toBeVisible();

    await page.getByRole('button', { name: 'Delete old-world' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByRole('tabpanel', { name: 'Worlds' }).getByText('old-world')).not.toBeVisible();
  });

  test('implements installed plugin inventory, toggle, and removal for plugin servers', async ({ page }) => {
    await mockAuthenticatedConsole(page);
    await page.goto('/server/mc-paper/content');

    await expect(page.getByRole('heading', { name: 'Server Plugins' })).toBeVisible();
    await expect(page.getByText('Permissions management')).toBeVisible();

    await page.getByRole('button', { name: 'Disable' }).click();
    await expect(page.getByText('Plugin disabled')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Enable' })).toBeVisible();

    await page.getByRole('button', { name: 'Delete LuckPerms' }).click();
    await expect(page.getByText('No plugins installed.')).toBeVisible();
  });
});
