import { describe, expect, it, vi } from 'vitest';
import { registerBuiltinAdapters } from '../../src/adapters/index.js';
import { requireOriginalFile } from '../../src/core/downloads.js';
import { DownloadHistoryStore, historyKey } from '../../src/core/history.js';
import { createAdapterContext, getAdapter } from '../../src/core/registry.js';
import { createServerConfig } from '../../src/core/servers.js';
import { normalizeSettings, SettingsStore } from '../../src/core/settings.js';
import { MemoryStorageArea, STORAGE_KEYS } from '../../src/core/storage.js';
import { DEFAULT_SETTINGS, type BooruPost, type DownloadHistoryEntry } from '../../src/shared/types.js';
import { createHarness, danbooruServer, e621Server, httpSnapshot } from '../helpers.js';

registerBuiltinAdapters();

const original = 'https://cdn.example/data/original/file.webm';
const sample = 'https://cdn.example/data/sample/file.jpg';
const preview = 'https://cdn.example/data/preview/file.jpg';

function normalized(siteType: string, raw: unknown): BooruPost {
  const adapter = getAdapter(siteType)!;
  const server = createServerConfig({
    siteType,
    baseUrl: siteType === 'hydrus' ? 'http://127.0.0.1:45869' : 'https://site.example',
    ratingFilterEnabled: false,
  });
  return adapter.normalizePost(raw, createAdapterContext(adapter, server, DEFAULT_SETTINGS));
}

describe('original-file selection across all booru families', () => {
  it.each<[string, unknown]>([
    ['e621', { id: 1, rating: 's', file: { url: original, ext: 'webm' }, sample: { has: true, url: sample }, preview: { url: preview } }],
    ['danbooru', { id: 1, rating: 'g', file_url: original, file_ext: 'webm', large_file_url: sample, preview_file_url: preview }],
    ...['gelbooru', 'rule34', 'safebooru-org', 'xbooru', 'tbib', 'hypnohub', 'realbooru'].map((site) =>
      [site, { id: 1, file_url: original, file_ext: 'webm', sample_url: sample, preview_url: preview }] as [string, unknown]),
    ...['yandere', 'konachan'].map((site) =>
      [site, { id: 1, file_url: original, file_ext: 'webm', sample_url: sample, jpeg_url: 'https://cdn.example/jpeg/file.jpg', preview_url: preview }] as [string, unknown]),
    ...['derpibooru', 'furbooru', 'ponybooru'].map((site) =>
      [site, { id: 1, view_url: original, format: 'webm', mime_type: 'video/webm', representations: { full: original, large: sample, thumb: preview } }] as [string, unknown]),
  ])('%s uses the API original rather than its video/image sample', (site, raw) => {
    const post = normalized(site, raw);
    expect(post.fileUrl).toBe(original);
    expect(post.sampleUrl).toBe(sample);
    expect(requireOriginalFile(post)).toBe(original);
  });

  it('uses Hydrus get_files/file, not its thumbnail endpoint', () => {
    const post = normalized('hydrus', { file_id: 42, ext: 'webm', mime: 'video/webm' });
    expect(requireOriginalFile(post)).toContain('/get_files/file?');
    expect(post.previewUrl).toContain('/get_files/thumbnail?');
  });

  it.each<[string, unknown]>([
    ['e621', { id: 1, file: { url: null }, sample: { url: sample }, preview: { url: preview } }],
    ['danbooru', { id: 1, file_url: null, large_file_url: sample, preview_file_url: preview }],
    ['gelbooru', { id: 1, sample_url: sample, preview_url: preview }],
    ['yandere', { id: 1, sample_url: sample, jpeg_url: 'https://cdn.example/jpeg/file.jpg', preview_url: preview }],
    ['derpibooru', { id: 1, representations: { large: sample, thumb: preview } }],
  ])('%s reports an unavailable original rather than falling back', (site, raw) => {
    const post = normalized(site, raw);
    expect(post.fileUrl).toBe('');
    expect(() => requireOriginalFile(post)).toThrow(/Original file.*unavailable/i);
  });

  it('rejects obvious reduced paths even if returned as an original field, but allows identical unchanged renditions', () => {
    const post = normalized('e621', { id: 1, file: { url: original }, sample: { url: sample }, preview: { url: preview } });
    for (const url of [sample, preview, 'https://cdn.example/samples/aaa/sample_image.jpg', 'https://cdn.example/thumbnails/abc.jpg']) {
      expect(() => requireOriginalFile({ ...post, fileUrl: url })).toThrow(/reduced rendition/);
    }
    expect(requireOriginalFile({ ...post, sampleUrl: original, previewUrl: original })).toBe(original);
    const moe = normalized('yandere', { id: 1, file_url: 'https://cdn.example/jpeg/file.jpg', sample_url: sample });
    expect(() => requireOriginalFile(moe)).toThrow(/reduced rendition/);
  });
});

describe('original-only policy on real router and queue paths', () => {
  it('migrates a legacy sample setting and rejects future sample updates', async () => {
    expect(normalizeSettings({ filePreference: 'sample' }).filePreference).toBe('original');
    const area = new MemoryStorageArea({ [STORAGE_KEYS.settings]: { filePreference: 'sample' } });
    const settings = new SettingsStore(area);
    expect((await settings.get()).filePreference).toBe('original');
    expect((await settings.save({ filePreference: 'sample' })).filePreference).toBe('original');
    expect((await area.get<{ filePreference: string }>(STORAGE_KEYS.settings))?.filePreference).toBe('original');
  });

  it('chooses the original for direct and queued downloads even with an injected legacy sample preference', async () => {
    const harness = createHarness({ settings: { minRequestIntervalMs: 0, maxConcurrency: 1 } });
    const server = e621Server({ ratingFilterEnabled: false });
    await harness.seed({ seedServers: [server] });
    const raw = { id: 42, rating: 's', file: { url: original, ext: 'webm' }, sample: { has: true, url: sample }, preview: { url: preview } };
    vi.spyOn(harness.http, 'request').mockResolvedValue(httpSnapshot({ post: raw }));
    vi.spyOn(harness.settings, 'get').mockResolvedValue({ ...DEFAULT_SETTINGS, filePreference: 'sample', minRequestIntervalMs: 0, maxConcurrency: 1 });

    const direct = await harness.router({ type: 'posts/download', payload: { serverId: server.id, postId: '42' } });
    expect(direct.ok).toBe(true);
    await harness.queue.enqueuePosts(server.id, [{ id: '42' }]);
    // Direct downloads now have a tracked queue row as well.
    expect((await harness.queue.run()).done).toBe(2);
    expect(harness.downloader.log.map((item) => item.url)).toEqual([original, original]);
    expect((await harness.history.list())[0]?.quality).toBe('original');
  });

  it('refuses a missing Danbooru original on both paths without recording a download', async () => {
    const harness = createHarness({ settings: { minRequestIntervalMs: 0, maxConcurrency: 1 } });
    const server = danbooruServer({ ratingFilterEnabled: false });
    await harness.seed({ seedServers: [server] });
    vi.spyOn(harness.http, 'request').mockResolvedValue(httpSnapshot({ id: 42, rating: 'g', file_url: null, large_file_url: sample, preview_file_url: preview }));
    const direct = await harness.router({ type: 'posts/download', payload: { serverId: server.id, postId: '42' } });
    expect(direct.ok).toBe(false);
    await harness.queue.enqueuePosts(server.id, [{ id: '42' }]);
    expect((await harness.queue.run()).failed).toBe(1);
    expect(harness.queue.list()[0]?.error).toMatch(/original file.*unavailable/i);
    expect(harness.downloader.log).toEqual([]);
    expect(await harness.history.list()).toEqual([]);
  });

  it('retains old history but never uses unknown-quality entries to hide originals', async () => {
    const old: DownloadHistoryEntry = {
      key: historyKey('s', '1'), serverId: 's', siteType: 'e621', postId: '1', label: 'old',
      filename: 'old.jpg', postUrl: 'https://e621.net/posts/1', bytes: null, at: '2026-01-01T00:00:00Z',
    };
    const area = new MemoryStorageArea({ [STORAGE_KEYS.history]: [old] });
    const history = new DownloadHistoryStore(area);
    expect(await history.list()).toHaveLength(1);
    expect(await history.has('s', '1')).toBe(false);
    expect((await history.index()).has(old.key)).toBe(false);
    await history.add({ ...old, quality: 'original' });
    expect(await history.has('s', '1')).toBe(false); // old original-quality starts are still unverified
    await history.add({ ...old, quality: 'original', completion: 'browser-complete' });
    expect(await history.has('s', '1')).toBe(true);
    expect((await history.index()).get(old.key)?.quality).toBe('original');
  });
});
