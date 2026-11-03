/**
 * Mirror-link rules, export/import round-trip, the link store, and the queue's
 * `link` rows - the machinery behind the Links tab.
 *
 * Everything here runs against the offline mock archive API; no live site is
 * contacted. The collection flow is exercised exactly as the panel drives it:
 * `links/posts` for one listing page, then `links/scanPost` per post.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createHarness } from '../helpers.js';
import { createServerConfig } from '../../src/core/servers.js';
import {
  classifyMirrorLink,
  collectMirrorLinks,
  extractUrlsFromHtml,
  extractUrlsFromPayload,
  formatLinkExport,
  linkLabel,
  mirrorLinkId,
  parseLinkExport,
} from '../../src/core/links.js';
import { MirrorLinkStore } from '../../src/core/link-store.js';
import { MemoryStorageArea } from '../../src/core/storage.js';
import { buildMirrorPath } from '../../src/core/naming.js';
import { DEFAULT_MIRROR_FOLDER, type MirrorLink, type ServerConfig } from '../../src/shared/types.js';
import type { UiRequest } from '../../src/core/messages.js';
import { MOCK_CREATOR, MOCK_CREATOR_POSTS } from '../../src/preview/mock-data.js';

type Harness = ReturnType<typeof createHarness>;

function pawchiveServer(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return createServerConfig({
    siteType: 'pawchive',
    baseUrl: 'https://pawchive.pw',
    label: 'Pawchive test',
    ratingFilterEnabled: false,
    ...overrides,
  });
}

async function ok<T = any>(harness: Harness, request: UiRequest): Promise<T> {
  const response = await harness.router(request);
  if (!response.ok) throw new Error(`expected ok, got ${JSON.stringify(response.error)}`);
  return response.data as T;
}

// ---------------------------------------------------------------------- rules

describe('mirror link rules', () => {
  const ownHosts = ['pawchive.pw'];

  it('keeps known providers', () => {
    const verdict = classifyMirrorLink('https://mega.nz/file/AbCdEf12#key', { ownHosts });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.provider).toBe('Mega');
      expect(verdict.reason).toBe('provider');
    }
  });

  it('matches provider subdomains', () => {
    const verdict = classifyMirrorLink('https://www.dropbox.com/s/abc/file.cbz?dl=0', { ownHosts });
    expect(verdict.ok && verdict.provider).toBe('Dropbox');
  });

  it('keeps file-looking URLs even on an unknown host', () => {
    expect(classifyMirrorLink('https://files.example.net/pack/summer.zip', { ownHosts })).toMatchObject({ ok: true, reason: 'extension' });
    expect(classifyMirrorLink('https://files.example.net/get?id=1&download=1', { ownHosts })).toMatchObject({ ok: true, reason: 'download-path' });
    expect(classifyMirrorLink('https://files.example.net/api/attachment/99', { ownHosts })).toMatchObject({ ok: true, reason: 'download-path' });
    expect(classifyMirrorLink('https://cdn.example.net/9f8e7d6c5b4a39281706f5e4d3c2b1a0', { ownHosts })).toMatchObject({ ok: true });
  });

  it('skips the site the profile belongs to, including its storage nodes', () => {
    expect(classifyMirrorLink('https://pawchive.pw/fanbox/user/1/post/2', { ownHosts })).toEqual({ ok: false, reason: 'own-host' });
    expect(classifyMirrorLink('https://n1.pawchive.pw/data/ab/cd/file.zip', { ownHosts })).toEqual({ ok: false, reason: 'own-host' });
  });

  it('filters plain external pages unless the filter says otherwise', () => {
    const strict = classifyMirrorLink('https://example.com/gallery/1234', { ownHosts, filter: 'downloads' });
    expect(strict).toEqual({ ok: false, reason: 'filtered' });
    expect(classifyMirrorLink('https://example.com/gallery/1234', { ownHosts, filter: 'any' })).toMatchObject({ ok: true, reason: 'external' });
  });

  it('honours extra provider hosts from the settings', () => {
    expect(classifyMirrorLink('https://mydrive.example/x/y', { ownHosts, extraHosts: ['mydrive.example'] })).toMatchObject({
      ok: true,
      provider: 'mydrive.example',
    });
  });

  it('rejects non-http and unparseable input', () => {
    expect(classifyMirrorLink('not a url', { ownHosts }).ok).toBe(false);
    expect(classifyMirrorLink('ftp://example.com/file.zip', { ownHosts }).ok).toBe(false);
  });

  it('normalises entities and preserves share-link fragments', () => {
    const urls = extractUrlsFromHtml('<a href="https://mega.nz/file/x&amp;y#frag">x</a>.');
    expect(urls).toEqual(['https://mega.nz/file/x&y#frag']);
  });
});

// ------------------------------------------------------------------ extraction

describe('payload extraction', () => {
  it('reads hrefs and bare text URLs out of a post body', () => {
    const urls = extractUrlsFromHtml('<p><a href="https://mega.nz/file/a">M</a> and https://pixeldrain.com/u/b</p>');
    expect(urls).toContain('https://mega.nz/file/a');
    expect(urls).toContain('https://pixeldrain.com/u/b');
  });

  it('walks nested API payloads without duplicates', () => {
    const payload = {
      post: { content: '<a href="https://mega.nz/file/a">x</a>' },
      attachments: [{ url: 'https://mega.nz/file/a' }, { url: 'https://catbox.moe/1.psd' }],
      sources: ['https://example.org/gallery/9'],
    };
    const urls = extractUrlsFromPayload(payload);
    expect(urls.filter((url) => url.includes('mega.nz'))).toHaveLength(1);
    expect(urls).toContain('https://catbox.moe/1.psd');
  });

  it('drops the site\'s own hosts and applies the filter', () => {
    const links = collectMirrorLinks(
      { content: `<a href="https://n2.pawchive.pw/data/x.zip">own</a> <a href="https://mega.nz/file/a">m</a> <a href="https://example.com/g/1">g</a>` },
      { postId: '1', postUrl: 'https://pawchive.pw/fanbox/user/1/post/1' },
      { ownHosts: ['pawchive.pw'] },
    );
    expect(links.map((link) => link.url)).toEqual(['https://mega.nz/file/a']);
  });

  it('gives the same link the same id, whatever the post', () => {
    expect(mirrorLinkId('https://mega.nz/file/a')).toBe(mirrorLinkId('https://mega.nz/file/a'));
    expect(mirrorLinkId('https://mega.nz/file/a')).not.toBe(mirrorLinkId('https://mega.nz/file/b'));
  });
});

// ---------------------------------------------------------------- export/import

describe('export and import', () => {
  const links: MirrorLink[] = [
    {
      id: 'a', url: 'https://mega.nz/file/a', host: 'mega.nz', provider: 'Mega',
      serverId: 'srv_1', siteType: 'pawchive', postId: 'fanbox/1/10', postTitle: 'Post ten',
      postUrl: 'https://pawchive.pw/fanbox/user/1/post/10', creator: 'fanbox/1',
      addedAt: '2026-09-01T00:00:00.000Z', status: 'new', attempts: 0, error: null,
      filename: null, bytes: null, updatedAt: '2026-09-01T00:00:00.000Z',
    },
    {
      id: 'b', url: 'https://pixeldrain.com/u/b', host: 'pixeldrain.com', provider: 'Pixeldrain',
      serverId: 'srv_1', siteType: 'pawchive', postId: 'fanbox/1/11', postTitle: 'Post eleven',
      postUrl: 'https://pawchive.pw/fanbox/user/1/post/11', creator: 'fanbox/1',
      addedAt: '2026-09-01T00:00:00.000Z', status: 'done', attempts: 1, error: null,
      filename: 'mirrors/pixeldrain.com/b.jpg', bytes: 1234, updatedAt: '2026-09-01T00:00:00.000Z',
    },
  ];

  it('writes a grouped file that reads back with its post context', () => {
    const text = formatLinkExport(links, { grouping: 'post', creator: 'fanbox/1', server: 'Pawchive test' });
    expect(text).toContain('# Creator: fanbox/1');
    expect(text).toContain('# Post: Post ten — https://pawchive.pw/fanbox/user/1/post/10');
    expect(text).toContain('- https://mega.nz/file/a');

    const parsed = parseLinkExport(text);
    expect(new Set(parsed.links)).toEqual(new Set(['https://mega.nz/file/a', 'https://pixeldrain.com/u/b']));
    expect(parsed.contexts.get('https://mega.nz/file/a')?.postTitle).toBe('Post ten');
    expect(parsed.contexts.get('https://pixeldrain.com/u/b')?.creator).toBe('fanbox/1');
  });

  it('writes a plain list when asked, and still reads it back', () => {
    const text = formatLinkExport(links, { grouping: 'plain' });
    expect(text).toContain('https://mega.nz/file/a');
    expect(text).not.toContain('- https://mega.nz/file/a');
    expect(parseLinkExport(text).links).toHaveLength(2);
  });

  it('groups by provider too', () => {
    const text = formatLinkExport(links, { grouping: 'provider' });
    expect(text).toContain('# Provider: Mega');
    expect(text).toContain('# Provider: Pixeldrain');
  });

  it('reads a hand-written or userscript-style file', () => {
    const parsed = parseLinkExport(
      [
        'Creator: Some Artist',
        'Collected: 2026-09-29 10:00',
        'Total unique links: 2',
        '',
        'https://mega.nz/file/a',
        '• https://drive.google.com/file/d/abc/view',
        'not a link',
        'https://mega.nz/file/a',
      ].join('\n'),
    );
    expect(parsed.links).toHaveLength(2);
  });
});

// ------------------------------------------------------------------- the store

describe('mirror link store', () => {
  const base = (overrides: Partial<MirrorLink> = {}): MirrorLink => ({
    id: mirrorLinkId('https://mega.nz/file/a'),
    url: 'https://mega.nz/file/a',
    host: 'mega.nz',
    provider: 'Mega',
    serverId: null,
    siteType: null,
    postId: null,
    postTitle: null,
    postUrl: null,
    creator: null,
    addedAt: '2026-09-01T00:00:00.000Z',
    status: 'new',
    attempts: 0,
    error: null,
    filename: null,
    bytes: null,
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  });

  it('merges a re-scanned link instead of duplicating it, keeping the outcome', async () => {
    const store = new MirrorLinkStore(new MemoryStorageArea());
    await store.add([base()]);
    await store.mark(mirrorLinkId('https://mega.nz/file/a'), 'done', { filename: 'mirrors/mega.nz/a.zip', bytes: 9 });
    const result = await store.add([base({ postTitle: 'Newer post', postUrl: 'https://pawchive.pw/fanbox/user/1/post/99' })]);
    expect(result.added).toBe(0);
    expect(result.updated).toBe(1);
    const stored = (await store.list())[0]!;
    expect(stored.postTitle).toBe('Newer post');
    expect(stored.status).toBe('done');
    expect(stored.filename).toBe('mirrors/mega.nz/a.zip');
  });

  it('reports stats and clears by scope', async () => {
    const store = new MirrorLinkStore(new MemoryStorageArea());
    await store.add([base(), base({ url: 'https://pixeldrain.com/u/b', id: mirrorLinkId('https://pixeldrain.com/u/b') })]);
    await store.mark(mirrorLinkId('https://mega.nz/file/a'), 'done');
    expect(await store.stats()).toMatchObject({ total: 2, done: 1, new: 1 });
    await store.clear('done');
    expect(await store.stats()).toMatchObject({ total: 1, done: 0 });
  });
});

// ------------------------------------------------------------------- the queue

describe('link queue rows', () => {
  it('downloads a link row without a server or a post lookup', async () => {
    const harness = createHarness({ settings: { minRequestIntervalMs: 0, maxConcurrency: 1, mirrorFolderTemplate: 'mirrors/{host}' } });
    await harness.seed();
    const added = await harness.queue.enqueueLinks([{ url: 'https://catbox.moe/pack.zip?x=1', label: 'pack.zip' }]);
    expect(added).toMatchObject({ added: 1, skipped: 0, invalid: 0 });
    await harness.queue.run();
    const [item] = harness.queue.list();
    expect(item?.status).toBe('done');
    expect(harness.downloader.log[0]?.url).toBe('https://catbox.moe/pack.zip?x=1');
    expect(harness.downloader.log[0]?.filename).toContain('mirrors/catbox.moe/');
  });

  it('de-duplicates by URL, not by post id', async () => {
    const harness = createHarness({ settings: { minRequestIntervalMs: 0 } });
    await harness.seed();
    await harness.queue.enqueueLinks([{ url: 'https://mega.nz/file/a', serverId: 'srv_a' }]);
    const second = await harness.queue.enqueueLinks([{ url: 'https://mega.nz/file/a', serverId: 'srv_b' }]);
    expect(second).toMatchObject({ added: 0, skipped: 1 });
  });

  it('rejects a URL that is not http(s)', async () => {
    const harness = createHarness({ settings: { minRequestIntervalMs: 0 } });
    await harness.seed();
    const result = await harness.queue.enqueueLinks([{ url: 'ftp://example.com/x' }]);
    expect(result).toMatchObject({ added: 0, invalid: 1 });
  });

  it('marks the stored link done when the row finishes', async () => {
    const harness = createHarness({ settings: { minRequestIntervalMs: 0, maxConcurrency: 1 } });
    await harness.seed();
    const url = 'https://catbox.moe/8f3a2b1c.psd';
    const collected = collectMirrorLinks({ content: url }, { postId: 'fanbox/1/2' }, { ownHosts: [] });
    await harness.links.add(collected);
    await ok(harness, { type: 'links/queue', payload: { ids: collected.map((link) => link.id) } });
    await harness.queue.run();
    const stored = (await harness.links.byUrl(url))!;
    expect(stored.status).toBe('done');
    expect(stored.filename).toContain('catbox.moe');
  });

  it('builds the mirror path from the URL and the template tokens', () => {
    const path = buildMirrorPath({
      url: 'https://mega.nz/file/AbCdEf12',
      provider: 'Mega',
      settings: { mirrorFolderTemplate: 'mirrors/{provider}/{date}' },
      now: new Date('2026-09-29T00:00:00.000Z'),
    });
    expect(path.folder).toBe('mirrors/Mega/2026-09-29');
    expect(path.filename).toBe('AbCdEf12');

    const fallback = buildMirrorPath({ url: 'https://mega.nz/', settings: { mirrorFolderTemplate: DEFAULT_MIRROR_FOLDER } });
    expect(fallback.fullPath.startsWith('mirrors/mega.nz/')).toBe(true);
  });
});

// ------------------------------------------------------------- router end-to-end

describe('links router flow', () => {
  let harness: Harness;
  let server: ServerConfig;
  let refs: Array<{ id: string; postUrl: string }>;

  /** Scan one post of the demo creator, the way the panel walks a listing. */
  const scan = (index: number, postTitle: string | null = null) =>
    ok<{ added: MirrorLink[]; duplicates: number; total: number }>(harness, {
      type: 'links/scanPost',
      payload: { serverId: server.id, postId: refs[index]!.id, postUrl: refs[index]!.postUrl, postTitle, creator: `${MOCK_CREATOR.service}/${MOCK_CREATOR.user}` },
    });

  beforeEach(async () => {
    harness = createHarness({ settings: { minRequestIntervalMs: 0, maxConcurrency: 1 } });
    await harness.seed({ seedServers: [pawchiveServer()] });
    server = (await harness.servers.getDefault())!;
    const listing = await ok<{ posts: Array<{ id: string; postUrl: string }> }>(harness, {
      type: 'links/posts',
      payload: { serverId: server.id, query: `${MOCK_CREATOR.service}/${MOCK_CREATOR.user}`, page: 1 },
    });
    // One row per attachment in the API, but one entry per *post* here.
    expect(listing.posts).toHaveLength(MOCK_CREATOR_POSTS.length);
    refs = listing.posts;
  });

  it('lists a creator page and keeps every mirror link its posts point at', async () => {
    for (let index = 0; index < refs.length; index += 1) await scan(index, 'x');

    const { links, stats } = await ok<{ links: MirrorLink[]; stats: { total: number } }>(harness, { type: 'links/list' });
    // Six distinct off-site files across the fixture, re-linked from later posts.
    expect(stats.total).toBe(6);
    expect(links.every((link) => link.host !== 'pawchive.pw' && !link.host.endsWith('.pawchive.pw'))).toBe(true);
    expect(links.map((link) => link.provider)).toContain('Mega');
    expect(links.find((link) => link.url.includes('pixeldrain'))?.postTitle).toBe('x');

    // Re-scanning the same creator finds nothing new (the store merges by URL).
    for (let index = 0; index < refs.length; index += 1) expect((await scan(index)).duplicates).toBeGreaterThanOrEqual(0);
    expect((await harness.links.stats()).total).toBe(6);
  });

  it('keeps only download-looking URLs by default and everything external with the "any" filter', async () => {
    const strict = await scan(0);
    expect(strict.added).toHaveLength(3);
    expect(strict.added.map((link) => link.url)).not.toContain('https://example.com/gallery/1234');

    await harness.links.clear('all');
    await harness.settings.save({ mirrorLinksFilter: 'any' });
    const loose = await scan(0);
    expect(loose.added.map((link) => link.url)).toContain('https://example.com/gallery/1234');
  });

  it('queues the collected links, exports them, and re-imports the file into the queue', async () => {
    const { added } = await scan(0);
    const queued = await ok<{ queued: number }>(harness, { type: 'links/queue', payload: { ids: added.map((link) => link.id) } });
    expect(queued.queued).toBe(added.length);
    expect(harness.queue.list().every((row) => row.kind === 'link' && !!row.url)).toBe(true);

    const exported = await ok<{ text: string; filename: string; count: number }>(harness, {
      type: 'links/export',
      payload: { grouping: 'post' },
    });
    expect(exported.count).toBe(added.length);
    expect(exported.filename.endsWith('_download_links.txt')).toBe(true);

    // Start over - empty list, empty queue - until only the saved file is left.
    await harness.queue.clear('all');
    await harness.links.clear('all');
    expect((await harness.links.stats()).total).toBe(0);

    const imported = await ok<{ parsed: number; added: number; queued: number }>(harness, {
      type: 'links/import',
      payload: { text: exported.text, serverId: server.id, queue: true },
    });
    expect(imported.parsed).toBe(exported.count);
    expect(imported.added).toBe(exported.count);
    expect(imported.queued).toBe(exported.count);

    await harness.queue.run();
    expect(harness.queue.list().every((row) => row.status === 'failed')).toBe(true);
    expect(harness.queue.list().every((row) => row.error?.includes('provider downloader'))).toBe(true);
    expect((await harness.links.stats()).failed).toBe(exported.count);
  });

  it('downloads an imported URL even with no profile configured at all', async () => {
    const bare = createHarness({ settings: { minRequestIntervalMs: 0, maxConcurrency: 1 } });
    const imported = await ok<{ queued: number }>(bare, {
      type: 'links/import',
      payload: { text: 'https://catbox.moe/file.zip\n', queue: true },
    });
    expect(imported.queued).toBe(1);
    await bare.queue.run();
    expect(bare.queue.list()[0]?.status).toBe('done');
  });

  it('removes links and their pending queue rows together', async () => {
    const { added } = await scan(2);
    await ok(harness, { type: 'links/queue', payload: { ids: added.map((link) => link.id) } });
    expect(harness.queue.list().filter((row) => row.status === 'pending')).toHaveLength(added.length);

    const removed = await ok<{ removed: number }>(harness, { type: 'links/remove', payload: { ids: added.map((link) => link.id) } });
    expect(removed.removed).toBe(added.length);
    expect(harness.queue.list().filter((row) => row.kind === 'link' && row.status === 'pending')).toHaveLength(0);
    expect((await harness.links.stats()).total).toBe(0);
  });

  it("keeps a failed row's message on the link instead of dropping it", async () => {
    const harness2 = createHarness({ settings: { minRequestIntervalMs: 0, maxConcurrency: 1 } });
    await harness2.seed();
    const url = 'https://catbox.moe/broken.zip';
    await harness2.links.add(collectMirrorLinks({ content: url }, { postId: 'fanbox/1/9' }, { ownHosts: [] }));
    await ok(harness2, { type: 'links/queue', payload: { ids: [(await harness2.links.byUrl(url))!.id] } });
    harness2.downloader.failNext = new Error('HTTP 403 - the hosting page refused the request');
    await harness2.queue.run();
    const stored = (await harness2.links.byUrl(url))!;
    expect(stored.status).toBe('failed');
    expect(stored.error).toContain('403');
    expect(stored.attempts).toBe(1);
  });

  it('labels a row from the post title, else the provider', () => {
    expect(linkLabel({ postTitle: 'Chapter 12', provider: 'Dropbox', host: 'dropbox.com', url: 'https://www.dropbox.com/s/x/y.cbz' })).toBe('Chapter 12');
    expect(linkLabel({ postTitle: null, provider: 'Dropbox', host: 'dropbox.com', url: 'https://www.dropbox.com/s/x/y.cbz' })).toContain('Dropbox');
  });
});
