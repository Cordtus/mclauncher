import { test, expect } from '@playwright/test';

test.describe('Mod Management', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to the app
    await page.goto('/');

    // Wait for the page to load
    await page.waitForSelector('text=MC LXD Manager');
  });

  test('should display mods tab for modded servers', async ({ page }) => {
    // Find a Forge/Fabric/NeoForge server card
    const serverCard = page.locator('text=Forge').or(page.locator('text=Fabric')).or(page.locator('text=NeoForge')).first();

    if (await serverCard.count() > 0) {
      // Click server settings button
      await page.click('button:has-text("Server Settings")');

      // Check if Mods tab exists
      await expect(page.locator('button[role="tab"]:has-text("Mods")')).toBeVisible();
    }
  });

  test('should show installed mods list', async ({ page }) => {
    // Find a modded server
    const serverCard = page.locator('text=Forge').or(page.locator('text=Fabric')).first();

    if (await serverCard.count() > 0) {
      // Open server settings
      await page.click('button:has-text("Server Settings")');

      // Click Mods tab
      await page.click('button[role="tab"]:has-text("Mods")');

      // Wait for mods panel to load
      await page.waitForSelector('text=Installed Mods');

      // Check for key elements
      await expect(page.locator('text=Browse Mods')).toBeVisible();
      await expect(page.locator('input[placeholder*="Search"]')).toBeVisible();
    }
  });

  test('should open mod browser', async ({ page }) => {
    const serverCard = page.locator('text=Forge').or(page.locator('text=Fabric')).first();

    if (await serverCard.count() > 0) {
      await page.click('button:has-text("Server Settings")');
      await page.click('button[role="tab"]:has-text("Mods")');

      // Click Browse Mods button
      await page.click('button:has-text("Browse Mods")');

      // Wait for mod browser dialog
      await page.waitForSelector('text=Mod Browser');
      await page.waitForSelector('text=Search and install mods from Modrinth');

      // Check for search elements
      await expect(page.locator('input[placeholder*="Search mods"]')).toBeVisible();
      await expect(page.locator('text=All Categories')).toBeVisible();
    }
  });

  test('should search for mods in browser', async ({ page }) => {
    const serverCard = page.locator('text=Forge').or(page.locator('text=Fabric')).first();

    if (await serverCard.count() > 0) {
      await page.click('button:has-text("Server Settings")');
      await page.click('button[role="tab"]:has-text("Mods")');
      await page.click('button:has-text("Browse Mods")');

      // Wait for browser to open
      await page.waitForSelector('input[placeholder*="Search mods"]');

      // Search for "Sodium"
      await page.fill('input[placeholder*="Search mods"]', 'Sodium');

      // Wait for results (debounce delay)
      await page.waitForTimeout(600);

      // Should show results or "searching" state
      const hasResults = await page.locator('text=Sodium').count() > 0;
      const isSearching = await page.locator('text=Searching').count() > 0;
      expect(hasResults || isSearching).toBeTruthy();
    }
  });

  test('should filter mods by status', async ({ page }) => {
    const serverCard = page.locator('text=Forge').or(page.locator('text=Fabric')).first();

    if (await serverCard.count() > 0) {
      await page.click('button:has-text("Server Settings")');
      await page.click('button[role="tab"]:has-text("Mods")');

      // Wait for mods list
      await page.waitForSelector('text=Installed Mods');

      // Check if there are any mods installed
      const modCards = await page.locator('[class*="InstalledModCard"]').count();

      if (modCards > 0) {
        // Click filter dropdown
        await page.click('button:has-text("All Mods")');

        // Select "Enabled Only"
        await page.click('text=Enabled Only');

        // Verify filter was applied
        await expect(page.locator('button:has-text("Enabled Only")')).toBeVisible();
      }
    }
  });

  test('should toggle mod enable/disable', async ({ page }) => {
    const serverCard = page.locator('text=Forge').or(page.locator('text=Fabric')).first();

    if (await serverCard.count() > 0) {
      await page.click('button:has-text("Server Settings")');
      await page.click('button[role="tab"]:has-text("Mods")');

      await page.waitForSelector('text=Installed Mods');

      // Find a mod card with a toggle switch
      const toggleSwitch = page.locator('[role="switch"]').first();

      if (await toggleSwitch.count() > 0) {
        const initialState = await toggleSwitch.getAttribute('aria-checked');

        // Click the toggle
        await toggleSwitch.click();

        // Wait for state change
        await page.waitForTimeout(500);

        // Verify state changed
        const newState = await toggleSwitch.getAttribute('aria-checked');
        expect(newState).not.toBe(initialState);

        // Should show restart message
        await expect(page.locator('text=Restart server to apply')).toBeVisible();
      }
    }
  });

  test('should open mod configuration', async ({ page }) => {
    const serverCard = page.locator('text=Forge').or(page.locator('text=Fabric')).first();

    if (await serverCard.count() > 0) {
      await page.click('button:has-text("Server Settings")');
      await page.click('button[role="tab"]:has-text("Mods")');

      await page.waitForSelector('text=Installed Mods');

      // Find and click a Configure button
      const configureButton = page.locator('button:has-text("Configure")').first();

      if (await configureButton.count() > 0) {
        await configureButton.click();

        // Should open config editor dialog or show "no config files" message
        const hasConfigEditor = await page.locator('text=Configure Mod').count() > 0;
        const hasNoConfigMessage = await page.locator('text=no configuration files').count() > 0;
        expect(hasConfigEditor || hasNoConfigMessage).toBeTruthy();
      }
    }
  });

  test('should display mod removal confirmation', async ({ page }) => {
    const serverCard = page.locator('text=Forge').or(page.locator('text=Fabric')).first();

    if (await serverCard.count() > 0) {
      await page.click('button:has-text("Server Settings")');
      await page.click('button[role="tab"]:has-text("Mods")');

      await page.waitForSelector('text=Installed Mods');

      // Find and click a trash/remove button
      const removeButton = page.locator('button:has([class*="Trash"])').first();

      if (await removeButton.count() > 0) {
        await removeButton.click();

        // Should show confirmation dialog
        await expect(page.locator('text=Remove')).toBeVisible();
        await expect(page.locator('text=Cancel')).toBeVisible();

        // Close dialog without removing
        await page.click('button:has-text("Cancel")');
      }
    }
  });

  test('should display mod details on click', async ({ page }) => {
    const serverCard = page.locator('text=Forge').or(page.locator('text=Fabric')).first();

    if (await serverCard.count() > 0) {
      await page.click('button:has-text("Server Settings")');
      await page.click('button[role="tab"]:has-text("Mods")');
      await page.click('button:has-text("Browse Mods")');

      await page.waitForSelector('input[placeholder*="Search mods"]');
      await page.fill('input[placeholder*="Search mods"]', 'JEI');
      await page.waitForTimeout(600);

      // Click on a mod card if available
      const modCard = page.locator('[class*="Card"]').first();

      if (await modCard.count() > 0) {
        await modCard.click();

        // Should show mod details dialog
        const hasModDialog = await page.locator('text=by').count() > 0;
        expect(hasModDialog).toBeTruthy();
      }
    }
  });

  test('should show compatibility warnings', async ({ page }) => {
    const serverCard = page.locator('text=Forge').or(page.locator('text=Fabric')).first();

    if (await serverCard.count() > 0) {
      await page.click('button:has-text("Server Settings")');
      await page.click('button[role="tab"]:has-text("Mods")');
      await page.click('button:has-text("Browse Mods")');

      await page.waitForSelector('input[placeholder*="Search mods"]');
      await page.fill('input[placeholder*="Search mods"]', 'Sodium');
      await page.waitForTimeout(600);

      const modCard = page.locator('text=Sodium').first();

      if (await modCard.count() > 0) {
        await modCard.click();

        // Should show resource impact or compatibility info
        const hasResourceInfo = await page.locator('text=Resource Impact').count() > 0;
        const hasCompatInfo = await page.locator('text=Compatible').or(page.locator('text=Warning')).count() > 0;
        expect(hasResourceInfo || hasCompatInfo).toBeTruthy();
      }
    }
  });
});
