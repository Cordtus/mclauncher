import { describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';

vi.mock('./modrinth.js', () => ({
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

import { generateDownloadPage, generateMrpack } from './modpack.js';

describe('modpack service', () => {
  it('generates mrpack indexes with Modrinth hashes and loader dependency IDs', async () => {
    const result = await generateMrpack(
      {
        name: 'Test Pack',
        summary: 'Test',
        versionId: '1.0.0',
        mcVersion: '1.20.1',
        loader: 'fabric',
        loaderVersion: '0.16.9',
      },
      [
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
      ]
    );

    const zip = await JSZip.loadAsync(result.buffer);
    const index = JSON.parse(await zip.file('modrinth.index.json')!.async('string'));

    expect(result.unmatchedMods).toEqual([]);
    expect(index.dependencies).toEqual({
      minecraft: '1.20.1',
      'fabric-loader': '0.16.9',
    });
    expect(index.files[0].hashes.sha1).toBe('a'.repeat(40));
    expect(index.files[0].hashes.sha512).toBe('b'.repeat(128));
  });

  it('escapes player-facing HTML metadata', async () => {
    const html = await generateDownloadPage(
      '<script>alert(1)</script>',
      'mc.example.test',
      {
        name: 'Pack',
        summary: 'Test',
        versionId: '1.0.0',
        mcVersion: '1.20.1',
        loader: 'fabric',
      },
      [
        {
          fileName: 'evil.jar',
          modId: 'evil',
          name: '<img src=x onerror=alert(1)>',
          version: '1.0.0',
          description: '<script>alert(2)</script>',
          loader: 'fabric',
          enabled: true,
        },
      ]
    );

    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('rejects modded mrpack exports when the loader version is unknown', async () => {
    await expect(generateMrpack(
      {
        name: 'Broken Pack',
        summary: 'Test',
        versionId: '1.0.0',
        mcVersion: '1.20.1',
        loader: 'fabric',
      },
      [
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
      ]
    )).rejects.toThrow('loader version');
  });
});
