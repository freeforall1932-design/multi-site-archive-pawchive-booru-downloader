import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { registerBuiltinAdapters } from '../../src/adapters/index.js';
import { PawchivePacedDownloader, type Downloader } from '../../src/core/downloads.js';
import { ServerStore, createServerConfig } from '../../src/core/servers.js';
import { MemoryStorageArea, STORAGE_KEYS } from '../../src/core/storage.js';
import { buildUserAgentRules } from '../../src/core/userAgent.js';
import { RateLimiter } from '../../src/shared/http.js';
import { DEFAULT_SETTINGS } from '../../src/shared/types.js';
import { redactUrl } from '../../src/shared/util.js';
import { createHarness, e621Server, httpSnapshot } from '../helpers.js';

registerBuiltinAdapters();
const pawchiveServer = () => createServerConfig({ siteType: 'pawchive', baseUrl: 'https://pawchive.pw', label: 'Pawchive' });

describe('archive scope and existing data', () => {
  it('removes archive host and content-script access while retaining Pawchive and booru permissions', () => {
    const manifest = JSON.parse(readFileSync('src/manifest.json', 'utf8')) as {
      host_permissions: string[];
      content_scripts: Array<{ matches: string[] }>;
    };
    const declared = [...manifest.host_permissions, ...manifest.content_scripts.flatMap((entry) => entry.matches)];
    expect(declared.some((entry) => /kemono|coomer/i.test(entry))).toBe(false);
    expect(declared).toEqual(expect.arrayContaining([
      'https://pawchive.pw/*', 'https://*.pawchive.pw/*', 'https://pawchive.st/*',
      'https://e621.net/*', 'https://*.donmai.us/*', 'https://gelbooru.com/*',
      'https://rule34.xxx/*', 'https://yande.re/*', 'https://derpibooru.org/*',
    ]));
    expect(declared).toEqual(expect.arrayContaining([
      'https://pawchive.pw/*/user/*/post/*', 'https://www.pawchive.pw/*/user/*/post/*',
      'https://pawchive.st/*/user/*/post/*', 'https://www.pawchive.st/*/user/*/post/*',
    ]));
  });

  it('preserves legacy profiles for export/deletion but selects a supported default', async () => {
    const old = createServerConfig({ id: 'old', siteType: 'kemono', baseUrl: 'https://kemono.cr', isDefault: true, apiKey: 'old-secret' });
    const booru = e621Server({ id: 'booru', isDefault: false, apiKey: 'booru-secret' });
    const paw = pawchiveServer();
    const area = new MemoryStorageArea({ [STORAGE_KEYS.servers]: [old, booru, paw] });
    const store = new ServerStore(area);
    const listed = await store.list();
    expect(listed).toHaveLength(3);
    expect(listed.find((entry) => entry.id === 'old')?.isDefault).toBe(false);
    expect((await store.getDefault())?.id).toBe('booru');
    expect(JSON.stringify(await area.get(STORAGE_KEYS.servers))).toContain('old-secret'); // load did not delete anything
    expect(await store.exportServers({ includeSecrets: true })).toContain('old-secret');
    expect(await store.exportServers()).not.toContain('old-secret');
    await expect(store.setDefault('old')).rejects.toMatchObject({ kind: 'unsupported-site' });
    await store.remove('old');
    expect((await store.list()).map((entry) => entry.id)).toEqual(expect.arrayContaining(['booru', paw.id]));
  });

  it('lets a newly added Pawchive/booru profile become default when only old profiles remain', async () => {
    const old = createServerConfig({ id: 'old', siteType: 'coomer', baseUrl: 'https://coomer.st', isDefault: true });
    const store = new ServerStore(new MemoryStorageArea({ [STORAGE_KEYS.servers]: [old] }));
    expect(await store.getDefault()).toBeNull();
    const saved = await store.save({ siteType: 'pawchive', baseUrl: 'https://pawchive.pw' });
    expect(saved.isDefault).toBe(true);
    expect((await store.getDefault())?.id).toBe(saved.id);
  });

  it('rejects discontinued archive imports without rejecting booru and Pawchive profiles', async () => {
    const store = new ServerStore(new MemoryStorageArea());
    const result = await store.importServers(JSON.stringify({ servers: [
      { siteType: 'kemono', baseUrl: 'https://kemono.cr' },
      { siteType: 'coomer', baseUrl: 'https://coomer.st' },
      { siteType: 'pawchive', baseUrl: 'https://pawchive.pw' },
      { siteType: 'danbooru', baseUrl: 'https://danbooru.donmai.us' },
    ] }));
    expect(result).toMatchObject({ imported: 2, skipped: 2 });
    expect((await store.list()).map((entry) => entry.siteType).sort()).toEqual(['danbooru', 'pawchive']);
    await expect(store.save({ siteType: 'pawchive', baseUrl: 'https://coomer.st' })).rejects.toMatchObject({ kind: 'unsupported-site' });
  });

  it('keeps an invalid legacy Pawchive URL visible but will not send it network requests', async () => {
    const harness = createHarness();
    const bad = createServerConfig({ id: 'bad', siteType: 'pawchive', baseUrl: 'https://kemono.cr', isDefault: true });
    const booru = e621Server({ id: 'valid-default' });
    await harness.area.set(STORAGE_KEYS.servers, [bad, booru]);
    const request = vi.spyOn(harness.http, 'request');
    const profiles = await harness.servers.list();
    expect(profiles[0]).toMatchObject({ baseUrl: 'https://kemono.cr', isDefault: false });
    expect(profiles[1]?.isDefault).toBe(true);
    const rules = buildUserAgentRules(profiles, DEFAULT_SETTINGS);
    expect(rules.some((rule) => rule.domains.includes('kemono.cr'))).toBe(false);
    expect(rules.some((rule) => rule.domains.includes('e621.net'))).toBe(true);
    await expect(harness.servers.setDefault('bad')).rejects.toThrow(/official Pawchive/);
    await expect(harness.client.search('bad', { tags: 'fanbox/1' })).rejects.toMatchObject({ kind: 'unsupported-site' });
    const validation = await harness.validation.validate(bad, DEFAULT_SETTINGS);
    expect(validation).toMatchObject({ ok: false, kind: 'unsupported-site' });
    expect(request).not.toHaveBeenCalled();
  });

  it('skips old queued archive posts without sending requests or affecting booru queue rows', async () => {
    const harness = createHarness({ settings: { minRequestIntervalMs: 0, maxConcurrency: 1 } });
    const old = createServerConfig({ id: 'old', siteType: 'kemono', baseUrl: 'https://kemono.cr', isDefault: true });
    const booru = e621Server({ id: 'booru' });
    await harness.area.set(STORAGE_KEYS.servers, [old, booru]);
    await harness.queue.enqueue([
      { serverId: old.id, postId: 'fanbox/1/2' },
      { serverId: booru.id, postId: '1500000' },
    ]);
    const summary = await harness.queue.run();
    expect(summary.skipped).toBe(1);
    expect(harness.queue.list().find((row) => row.serverId === old.id)?.errorKind).toBe('unsupported-site');
    expect(harness.downloader.log.every((entry) => !entry.url.includes('kemono.cr'))).toBe(true);
    expect(harness.queue.list().find((row) => row.serverId === booru.id)?.status).toBe('done');
  });

  it('keeps old task packages as direct link lists without remapping their creators to Pawchive', async () => {
    const harness = createHarness();
    const paw = pawchiveServer();
    await harness.seed({ seedServers: [paw] });
    const oldPackage = JSON.stringify({
      format: 'booru-server-manager.task',
      task: { id: 'kemono:fanbox:1', name: 'Old creator', siteType: 'kemono', service: 'fanbox', creator: '1', query: 'fanbox/1' },
      files: [{ url: 'https://mega.nz/file/example', postUrl: 'https://kemono.cr/fanbox/user/1/post/2' }],
    });
    const imported = await harness.router({ type: 'tasks/import', payload: { text: oldPackage, serverId: paw.id } });
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    const task = (imported.data as { task: { task: { id: string; serverId: string | null; siteType: string } } }).task.task;
    expect(task).toMatchObject({ siteType: 'kemono', serverId: null });
    const spy = vi.spyOn(harness.http, 'request');
    const rescan = await harness.router({ type: 'tasks/rescan', payload: { taskId: task.id } });
    expect(rescan.ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    const run = await harness.router({ type: 'tasks/run', payload: { taskId: task.id, start: false } });
    expect(run.ok).toBe(true); // explicit off-site links can still be recovered
  });

  it('uses a saved Pawchive profile for www and former-domain post routes', async () => {
    const harness = createHarness();
    const paw = pawchiveServer();
    await harness.seed({ seedServers: [paw] });
    for (const url of [
      'https://www.pawchive.pw/fanbox/user/1245946/post/12674481',
      'https://pawchive.st/fanbox/user/1245946/post/12674481',
      'https://www.pawchive.st/fanbox/user/1245946/post/12674481',
    ]) {
      const route = await harness.client.resolveRoute(url);
      expect(route).toMatchObject({ kind: 'post', serverId: paw.id, server: { id: paw.id } });
      expect((await harness.client.resolvePostFromUrl(url)).post.siteType).toBe('pawchive');
    }
  });

  it('keeps booru blacklist settings from corrupting Pawchive creator queries', async () => {
    const harness = createHarness({ settings: { tagBlacklist: 'guro', globalTagSuffix: 'solo', minRequestIntervalMs: 0 } });
    const paw = pawchiveServer();
    await harness.seed({ seedServers: [paw] });
    const request = vi.spyOn(harness.http, 'request');
    const browse = await harness.router({ type: 'browse/search', payload: { serverId: paw.id, spec: { tags: 'fanbox/1245946' } } });
    const collect = await harness.router({ type: 'links/posts', payload: { serverId: paw.id, query: 'fanbox/1245946', page: 1 } });
    expect(browse.ok && (browse.data as { posts: unknown[] }).posts.length).toBeGreaterThan(0);
    expect(collect.ok && (collect.data as { posts: unknown[] }).posts.length).toBeGreaterThan(0);
    expect(request.mock.calls.map(([spec]) => spec.url)).toEqual([
      'https://pawchive.pw/api/v1/fanbox/user/1245946/posts?o=0',
      'https://pawchive.pw/api/v1/fanbox/user/1245946/posts?o=0',
    ]);
  });

  it('does not let a booru or discontinued archive profile start a creator-link collection', async () => {
    const harness = createHarness();
    const booru = e621Server();
    await harness.seed({ seedServers: [booru] });
    const denied = await harness.router({ type: 'tasks/begin', payload: { serverId: booru.id, query: 'fanbox/1' } });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.kind).toBe('unsupported-site');
    const normal = await harness.router({ type: 'browse/search', payload: { serverId: booru.id, spec: { tags: 'cat' } } });
    expect(normal.ok).toBe(true);
    const paw = await harness.servers.save(pawchiveServer());
    const wrongUrl = await harness.router({ type: 'tasks/begin', payload: { serverId: paw.id, query: 'https://coomer.st/onlyfans/user/1' } });
    expect(wrongUrl.ok).toBe(false);
  });
});

describe('Pawchive collection and responsible request handling', () => {
  it('collects links from a text-only post and does not rescan old attachment-index ids', async () => {
    const harness = createHarness({ settings: { minRequestIntervalMs: 0 } });
    const server = pawchiveServer();
    await harness.seed({ seedServers: [server] });
    const rawPost = {
      id: '42', user: '123', service: 'fanbox', title: 'Link-only post',
      file: { name: 'waiting.zip', deferred: true }, attachments: [],
      content: '<a href="https://mega.nz/file/abc">download</a> <a href="https://t1.pawchive.st/f/old.zip?s=secret">own storage</a>',
    };
    vi.spyOn(harness.http, 'request').mockImplementation(async (spec) => {
      if (spec.url.includes('/post/42')) return httpSnapshot(rawPost);
      return httpSnapshot([rawPost]);
    });
    const begun = await harness.router({ type: 'tasks/begin', payload: { serverId: server.id, query: 'fanbox/123' } });
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;
    const taskId = (begun.data as { task: { task: { id: string } } }).task.task.id;
    const listing = await harness.router({ type: 'links/posts', payload: { serverId: server.id, query: 'fanbox/123', page: 1 } });
    expect(listing.ok).toBe(true);
    if (!listing.ok) return;
    const refs = (listing.data as { posts: Array<{ id: string; label: string; postUrl: string }> }).posts;
    expect(refs).toEqual([{ id: 'fanbox/123/42', label: 'Link-only post', postUrl: 'https://pawchive.pw/fanbox/user/123/post/42' }]);
    await harness.tasks.attachMembers(taskId, [], ['fanbox/123/42/0']);
    const rescanned = await harness.router({ type: 'tasks/rescan', payload: { taskId, maxPosts: 50 } });
    expect(rescanned.ok).toBe(true);
    if (rescanned.ok) expect((rescanned.data as { scannedPosts: number }).scannedPosts).toBe(0);
    const scanned = await harness.router({ type: 'links/scanPost', payload: { serverId: server.id, postId: refs[0]!.id, postUrl: refs[0]!.postUrl, taskId } });
    expect(scanned.ok).toBe(true);
    if (scanned.ok) expect((scanned.data as { added: unknown[] }).added).toHaveLength(1);
  });

  it('updates a queued preview label when the full file becomes available', async () => {
    const harness = createHarness({ settings: { minRequestIntervalMs: 0, maxConcurrency: 1 } });
    const server = pawchiveServer();
    await harness.seed({ seedServers: [server] });
    vi.spyOn(harness.http, 'request').mockResolvedValue(httpSnapshot({
      id: '42', user: '123', service: 'fanbox', title: 'Now complete',
      file: { name: 'cover.png', path: '/ab/cd/cover.png' }, attachments: [],
    }));
    await harness.queue.enqueuePosts(server.id, [{ id: 'fanbox/123/42/0', label: 'cover [preview only]' }]);
    await harness.queue.run();
    expect(harness.queue.list()[0]?.label).toBe('cover');
    expect((await harness.history.list())).toHaveLength(1);
  });

  it('reports preview-only files without downloading them or recording history', async () => {
    const harness = createHarness({ settings: { minRequestIntervalMs: 0, maxConcurrency: 1 } });
    const server = pawchiveServer();
    await harness.seed({ seedServers: [server] });
    const rawPost = {
      id: '42', user: '123', service: 'fanbox', title: 'Preview',
      file: { name: 'cover.png', path: '/ab/cd/cover.png', preview_only: true }, attachments: [],
    };
    vi.spyOn(harness.http, 'request').mockResolvedValue(httpSnapshot(rawPost));
    await harness.queue.enqueuePosts(server.id, [{ id: 'fanbox/123/42/0' }]);
    const summary = await harness.queue.run();
    expect(summary.failed).toBe(1);
    expect(harness.downloader.log).toHaveLength(0);
    expect(harness.queue.list()[0]!.error).toContain('Original file');
    expect(harness.queue.list()[0]!.label).toContain('[preview only]');
    const direct = await harness.router({ type: 'posts/download', payload: { serverId: server.id, postId: 'fanbox/123/42/0' } });
    expect(direct.ok).toBe(false);
    if (!direct.ok) expect(direct.error.message).toContain('Original file');
    expect(await harness.history.list()).toHaveLength(0);
  });

  it('shares metadata spacing across Pawchive profiles and validation, without merging booru budgets', async () => {
    const harness = createHarness({ settings: { minRequestIntervalMs: 0 } });
    const first = pawchiveServer();
    const second = pawchiveServer();
    const booru = e621Server();
    await harness.seed({ seedServers: [first, second, booru] });
    const spy = vi.spyOn(harness.http, 'request');
    await harness.client.search(first.id, { tags: 'fanbox/1245946' });
    await harness.client.search(second.id, { tags: 'fanbox/1245946' });
    await harness.validation.validate(first, DEFAULT_SETTINGS);
    await harness.client.search(booru.id, { tags: 'cat' });
    const policies = spy.mock.calls.map((call) => call[1]);
    expect(policies.slice(0, 3).map((policy) => policy?.rateKey)).toEqual(['site:pawchive', 'site:pawchive', 'site:pawchive']);
    expect(policies.slice(0, 3).every((policy) => (policy?.minIntervalMs ?? 0) >= 1500)).toBe(true);
    expect(policies[3]?.rateKey).toBe(`server:${booru.id}`);
  });

  it('spaces Pawchive file starts by one second across its hosts, without delaying booru downloads', async () => {
    let now = 0;
    const starts: Array<{ url: string; at: number }> = [];
    const inner: Downloader = {
      async download(request) {
        starts.push({ url: request.url, at: now });
        return { downloadId: 1, viaFallback: false, bytes: null };
      },
      async getState() { return null; },
      async cancel() {},
    };
    const limiter = new RateLimiter(0, () => now, async (ms) => { now += ms; });
    const paced = new PawchivePacedDownloader(inner, limiter);
    await paced.download({ url: 'https://file.pawchive.pw/data/a', filename: 'a' });
    await paced.download({ url: 'https://e621.net/data/b', filename: 'b' });
    await paced.download({ url: 'https://t1.pawchive.pw/f/c?s=signature', filename: 'c' });
    expect(starts.map((entry) => entry.at)).toEqual([0, 0, 1000]);
  });

  it('redacts Pawchive signatures without hiding the DAPI s=post parameter', () => {
    expect(redactUrl('https://t1.pawchive.pw/f/1/a?e=9&s=secret')).not.toContain('secret');
    expect(redactUrl('https://gelbooru.com/index.php?s=post')).toContain('s=post');
  });
});
