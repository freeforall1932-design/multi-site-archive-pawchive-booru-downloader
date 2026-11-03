import { afterEach, describe, expect, it, vi } from 'vitest';
import { HYDRUS_KEY_PARAM, hydrusAdapter } from '../../src/adapters/hydrus.js';
import { ChromeDownloader, postDownloadAuth, type DownloadRequest } from '../../src/core/downloads.js';
import { DownloadHistoryStore, historyKey } from '../../src/core/history.js';
import { createServerConfig } from '../../src/core/servers.js';
import { MemoryStorageArea, STORAGE_KEYS } from '../../src/core/storage.js';
import { describeRequest, HttpClient, type FetchLike } from '../../src/shared/http.js';
import { DEFAULT_SETTINGS, type DownloadHistoryEntry, type QueueItem, type ServerConfig } from '../../src/shared/types.js';
import { redactHeaders } from '../../src/shared/util.js';
import { createHarness, jsonResponse } from '../helpers.js';

const secret = 'hydrus-secret-test-key';
const baseUrl = 'http://127.0.0.1:45869';
const legacyUrl = `${baseUrl}/get_files/file?file_id=42&Hydrus-Client-API-Access-Key=${secret}`;
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

function hydrusServer(): ServerConfig {
  return createServerConfig({ siteType: 'hydrus', baseUrl, apiKey: secret, ratingFilterEnabled: false });
}

function backend(calls: Array<{ url: string; init?: RequestInit }>): FetchLike {
  return async (input, init) => {
    calls.push({ url: input, init });
    const url = new URL(input);
    const headers = new Headers(init?.headers);
    if (url.pathname !== '/api_version' && headers.get(HYDRUS_KEY_PARAM) !== secret) return jsonResponse({ error: 'missing key' }, 401);
    if (url.pathname === '/api_version') return jsonResponse({ version: 78, hydrus_version: 600 });
    if (url.pathname === '/verify_access_key') return jsonResponse({ basic_permissions: [3], human_description: 'test key' });
    if (url.pathname === '/get_files/search_files') return jsonResponse({ file_ids: [42, 43] });
    if (url.pathname === '/get_files/file_metadata') {
      const id = JSON.parse(url.searchParams.get('file_ids') ?? '[]')[0];
      return jsonResponse({ metadata: [{ file_id: id, ext: 'png', mime: 'image/png', size: 100 }] });
    }
    if (url.pathname === '/get_files/thumbnail') return new Response(png, { headers: { 'content-type': 'image/png' } });
    return jsonResponse({}, 404);
  };
}

async function setup() {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const harness = createHarness({ fetchImpl: backend(calls), settings: { minRequestIntervalMs: 0, maxRetries: 1, maxConcurrency: 1 } });
  const server = hydrusServer();
  await harness.seed({ seedServers: [server] });
  return { harness, server, calls };
}

function entry(): DownloadHistoryEntry {
  return { key: historyKey('srv', '42'), serverId: 'srv', siteType: 'hydrus', postId: '42', label: '#42', filename: '42.png',
    postUrl: legacyUrl, bytes: 100, at: '2026-10-30T00:00:00.000Z', quality: 'original', completion: 'browser-complete' };
}

function row(kind: 'post' | 'link'): QueueItem {
  return { id: kind, serverId: 'srv', postId: kind === 'post' ? '42' : 'mega', label: kind,
    postUrl: kind === 'post' ? legacyUrl : 'https://mega.nz/file/abc#decryption-key',
    kind, url: kind === 'link' ? 'https://mega.nz/file/abc#decryption-key' : null,
    rating: null, status: 'pending', attempts: 0, error: null, errorKind: null, filename: null, bytes: null,
    createdAt: '2026-10-30T00:00:00.000Z', updatedAt: '2026-10-30T00:00:00.000Z',
    historyEntry: kind === 'post' ? entry() : null };
}

afterEach(() => vi.unstubAllGlobals());

describe('Hydrus header authentication and persisted URLs', () => {
  it('uses secret-free URLs for validation, listings, metadata and thumbnails', async () => {
    const { harness, server, calls } = await setup();
    const validation = await harness.client.validateServer(server.id);
    expect(validation.ok).toBe(true);
    expect(validation.warnings.join(' ')).not.toMatch(/no credentials/i);
    const result = await harness.client.search(server.id, { tags: 'cat', page: 1, limit: 10 });
    const post = await harness.client.getPost(server.id, '42');
    const thumbnail = await harness.router({ type: 'posts/thumbnail', payload: { serverId: server.id, postId: '42' } });
    expect(thumbnail).toEqual({ ok: true, data: { dataUrl: `data:image/png;base64,${btoa(String.fromCharCode(...png))}` } });
    expect(JSON.stringify([validation, result, post, thumbnail])).not.toContain(secret);
    for (const { url, init } of calls) {
      expect(url).not.toContain(secret);
      if (!url.endsWith('/api_version')) {
        expect(new Headers(init?.headers).get(HYDRUS_KEY_PARAM)).toBe(secret);
        expect(init?.redirect).toBe('error');
      }
    }
    expect(post.fileUrl).toBe(`${baseUrl}/get_files/file?file_id=42`);
    expect(post.previewUrl).toBe(`${baseUrl}/get_files/thumbnail?file_id=42`);
  });

  it('passes the key only transiently to direct and queued original downloads', async () => {
    const { harness, server } = await setup();
    const download = vi.spyOn(harness.downloader, 'download');
    const direct = await harness.router({ type: 'posts/download', payload: { serverId: server.id, postId: '42' } });
    expect(direct.ok).toBe(true);
    await harness.queue.enqueuePosts(server.id, [{ id: '43' }]);
    await harness.queue.run();
    expect(download).toHaveBeenCalledTimes(2);
    for (const [request] of download.mock.calls) {
      expect(request.url).toMatch(/\/get_files\/file\?file_id=4[23]$/);
      expect(request.url).not.toContain(secret);
      expect(request.headers).toEqual({ [HYDRUS_KEY_PARAM]: secret });
    }
    expect(JSON.stringify(direct)).not.toContain(secret);
    expect(JSON.stringify(await harness.area.get(STORAGE_KEYS.queue))).not.toContain(secret);
    expect(JSON.stringify(await harness.area.get(STORAGE_KEYS.history))).not.toContain(secret);
    expect(JSON.stringify(harness.downloader.log)).not.toContain(secret);
    expect((await harness.history.list()).map((item) => item.quality)).toEqual(['original', 'original']);
  });

  it('refuses unexpected file targets, different IDs, and missing keys', async () => {
    const { harness, server } = await setup();
    const post = await harness.client.getPost(server.id, '42');
    for (const bad of [`http://evil.example/get_files/file?file_id=42`, `${post.fileUrl}&other=1`, `${baseUrl}/get_files/thumbnail?file_id=42`]) {
      expect(() => postDownloadAuth(server, post, bad)).toThrow(/refusing/i);
    }
    expect(() => postDownloadAuth(server, { ...post, id: '43' }, post.fileUrl)).toThrow(/refusing/i);
    expect(() => postDownloadAuth({ ...server, apiKey: '' }, post, post.fileUrl)).toThrow(/access key/i);
    expect(() => hydrusAdapter.buildPostRequest({ server, baseUrl, settings: DEFAULT_SETTINGS, userAgent: 'test' }, '12/../x')).toThrow(/invalid hydrus file id/i);
  });

  it('scrubs legacy post/history URLs in storage while preserving Mega link keys', async () => {
    const { harness } = await setup();
    const area = harness.area;
    await area.set(STORAGE_KEYS.queue, { items: [row('post'), row('link')], paused: false });
    await area.set(STORAGE_KEYS.history, [entry()]);
    const history = new DownloadHistoryStore(area);
    // A fresh queue reads legacy rows just like a restarted worker.
    const { DownloadQueue } = await import('../../src/core/queue.js');
    const queue = new DownloadQueue({ storage: area, client: harness.client, servers: harness.servers,
      settings: harness.settings, downloader: harness.downloader, history });
    await Promise.all([queue.refresh(), history.list(), history.list()]);
    const storedQueue = JSON.stringify(await area.get(STORAGE_KEYS.queue));
    const storedHistory = JSON.stringify(await area.get(STORAGE_KEYS.history));
    expect(storedQueue).not.toContain(secret);
    expect(storedHistory).not.toContain(secret);
    expect(queue.list()[0]?.postUrl).toBe(`${baseUrl}/get_files/file?file_id=42`);
    expect(queue.list()[1]?.url).toBe('https://mega.nz/file/abc#decryption-key');
    expect(queue.list()[1]?.postUrl).toBe('https://mega.nz/file/abc#decryption-key');
    expect((await history.list())[0]?.postUrl).toBe(`${baseUrl}/get_files/file?file_id=42`);
  });

  it('does not fetch arbitrary URLs or non-Hydrus thumbnails', async () => {
    const { harness, server, calls } = await setup();
    const before = calls.length;
    const invalid = await harness.router({ type: 'posts/thumbnail', payload: { serverId: server.id, postId: 'https://evil.example' } });
    expect(invalid.ok).toBe(false);
    const other = await harness.servers.save({ siteType: 'e621', baseUrl: 'https://e621.net' });
    const wrongFamily = await harness.router({ type: 'posts/thumbnail', payload: { serverId: other.id, postId: '42' } });
    expect(wrongFamily.ok).toBe(false);
    expect(calls).toHaveLength(before);
  });
});

describe('bounded thumbnail fetch and header-safe diagnostics', () => {
  it('rejects HTML/SVG, empty and oversized responses, including dishonest lengths', async () => {
    const responses = [
      new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } }),
      new Response('', { headers: { 'content-type': 'image/png' } }),
      new Response(png, { headers: { 'content-type': 'image/png', 'content-length': '9999' } }),
      new Response(png, { headers: { 'content-type': 'image/png', 'content-length': '1' } }),
    ];
    const http = new HttpClient({ fetchImpl: async () => responses.shift()! });
    for (let i = 0; i < 4; i += 1) {
      await expect(http.requestImage({ url: `${baseUrl}/thumbnail` }, { rateKey: 'h', maxBytes: 4 })).rejects.toBeDefined();
    }
  });

  it('masks the access-key header in diagnostics and exception text', async () => {
    const headers = { [HYDRUS_KEY_PARAM]: secret };
    expect(redactHeaders(headers)[HYDRUS_KEY_PARAM]).toBe('***');
    expect(describeRequest({ url: baseUrl, headers })).not.toContain(secret);
    const events: string[] = [];
    const http = new HttpClient({ fetchImpl: async () => { throw new Error(`header rejected: ${secret}`); }, maxRetries: 1,
      onEvent: (event) => events.push(event.message ?? '') });
    const error = await http.request({ url: baseUrl, headers, redirect: 'error' }).catch((e: Error) => e);
    expect(String(error)).not.toContain(secret);
    expect(events.join(' ')).not.toContain(secret);
  });

  it('passes allowed headers to chrome.downloads without placing them in the URL', async () => {
    const download = vi.fn(async (_options: { url: string }) => 7);
    vi.stubGlobal('chrome', { downloads: { download } });
    const request: DownloadRequest = { url: `${baseUrl}/get_files/file?file_id=42`, filename: '42.png', headers: { [HYDRUS_KEY_PARAM]: secret } };
    const result = await new ChromeDownloader().download(request);
    expect(result.downloadId).toBe(7);
    expect(download).toHaveBeenCalledWith(expect.objectContaining({ url: request.url, headers: [{ name: HYDRUS_KEY_PARAM, value: secret }] }));
    expect(download.mock.calls[0]?.[0].url).not.toContain(secret);
  });

  it('reports and retries a failed history migration rather than caching unredacted data', async () => {
    class FailingArea extends MemoryStorageArea {
      fail = true;
      override async set(key: string, value: unknown): Promise<void> {
        if (this.fail && key === STORAGE_KEYS.history) { this.fail = false; throw new Error('write failed'); }
        await super.set(key, value);
      }
    }
    const area = new FailingArea({ [STORAGE_KEYS.history]: [entry()] });
    const history = new DownloadHistoryStore(area);
    await expect(history.list()).rejects.toThrow('write failed');
    expect(JSON.stringify(await history.list())).not.toContain(secret);
    expect(JSON.stringify(await area.get(STORAGE_KEYS.history))).not.toContain(secret);
  });
});
