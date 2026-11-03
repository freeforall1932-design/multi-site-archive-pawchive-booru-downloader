import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServerConfig } from '../../src/core/servers.js';
import { PreviewDownloader, PreviewPlatform, previewMediaUrl } from '../../src/platform/preview.js';
import { MemoryStorageArea } from '../../src/core/storage.js';
import { withPreviewMedia } from '../../src/preview/preview.js';
import type { SearchResult } from '../../src/shared/types.js';
import { createHarness } from '../helpers.js';

afterEach(() => vi.unstubAllGlobals());

describe('offline preview media', () => {
  it('uses local placeholders for mock Pawchive thumbnails', async () => {
    const harness = createHarness();
    const server = createServerConfig({ siteType: 'pawchive', baseUrl: 'https://pawchive.pw' });
    await harness.seed({ seedServers: [server] });
    const request = { type: 'browse/search', payload: { serverId: server.id, spec: { tags: 'fanbox/1245946' } } } as const;
    const raw = await harness.router(request);
    expect(raw.ok).toBe(true);
    if (!raw.ok) return;
    expect((raw.data as SearchResult).posts[1]?.previewUrl).toMatch(/^https:\/\/img\.pawchive\.pw/);
    const preview = withPreviewMedia(request, raw);
    expect(preview.ok).toBe(true);
    if (preview.ok) expect((preview.data as SearchResult).posts[1]?.previewUrl).toMatch(/^\/mock\/media\/\d+\.jpg$/);
  });

  it('opens the preview options and panel at their built routes', async () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    vi.stubGlobal('location', { search: '?tab=https%3A%2F%2Fe621.net%2Fposts%2F1' });
    const platform = new PreviewPlatform({ handler: async () => ({ ok: true, data: null }), storage: new MemoryStorageArea() });
    platform.openOptions('queue');
    await platform.openPanel();
    expect(open).toHaveBeenCalledWith('/dist/options/options.html#queue', '_blank', 'noopener');
    expect(open).toHaveBeenCalledWith('/dist/panel/panel.html?tab=https%3A%2F%2Fe621.net%2Fposts%2F1', '_blank', 'noopener');
  });

  it('never starts a live download from the preview, including off-site links', async () => {
    let clicked = '';
    const anchor = { href: '', download: '', target: '', rel: '', click: () => { clicked = anchor.href; }, remove: () => {} };
    vi.stubGlobal('document', { createElement: () => anchor, body: { append: () => {} } });
    const downloader = new PreviewDownloader();
    const external = 'https://file.pawchive.pw/data/a/b?token=secret';
    await downloader.download({ url: external, filename: 'archive.zip' });
    expect(clicked).toMatch(/^\/mock\/media\/\d+\.jpg$/);
    expect(downloader.log[0]?.url).toBe(external);
    expect(previewMediaUrl('/mock/media/42.png')).toBe('/mock/media/42.png');
    expect(previewMediaUrl('//example.com/test')).toMatch(/^\/mock\/media\/\d+\.jpg$/);
  });
});
