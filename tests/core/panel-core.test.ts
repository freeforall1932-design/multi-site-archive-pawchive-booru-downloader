/**
 * Tests for the pure logic the side panel is built on:
 * page ranges, query composition, the name-template editor, the two history
 * notebooks and the new settings keys.
 *
 * Everything here runs without a DOM: the panel's own wiring is covered by the
 * built-bundle smoke test and by docs/MANUAL_TESTS.md.
 */
import { describe, expect, it } from 'vitest';
import { MemoryStorageArea } from '../../src/core/storage.js';
import { DownloadHistoryStore, SearchHistoryStore, historyKey } from '../../src/core/history.js';
import { batchRange, fromToRange, parsePageRange } from '../../src/core/pages.js';
import { composeSearchTags, countFilters } from '../../src/core/search.js';
import { DEFAULT_SETTINGS, type DownloadHistoryEntry } from '../../src/shared/types.js';
import { normalizeSettings, SettingsStore } from '../../src/core/settings.js';
import { TEMPLATE_TOKENS, buildTemplate, isCanonicalTemplate, isTokenOnlyTemplate, previewNaming, templateTokensInUse } from '../../src/core/template.js';
import { postMatchesMedia } from '../../src/ui/panel-listing.js';

describe('page ranges', () => {
  const options = { maxPages: 150 };

  it('defaults to every page when the box is empty', () => {
    const result = parsePageRange('', options);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.selection).toEqual({ kind: 'all' });
  });

  it('accepts a single page number', () => {
    const result = parsePageRange('7', options);
    expect(result.ok && result.selection).toEqual({ kind: 'list', pages: [7] });
    expect(result.ok && result.label).toBe('page 7');
  });

  it('parses lists and ranges together', () => {
    const result = parsePageRange('2,4,6-10', options);
    expect(result.ok).toBe(true);
    if (!result.ok || result.selection.kind !== 'list') throw new Error('expected a list');
    expect(result.selection.pages).toEqual([2, 4, 6, 7, 8, 9, 10]);
  });

  it('de-duplicates and sorts page numbers', () => {
    const result = parsePageRange('5,3,3,4', options);
    if (!result.ok || result.selection.kind !== 'list') throw new Error('expected a list');
    expect(result.selection.pages).toEqual([3, 4, 5]);
  });

  it('treats "50-" as an open range', () => {
    const result = parsePageRange('50-', options);
    expect(result.ok && result.selection).toEqual({ kind: 'open', start: 50 });
  });

  it('explains a backwards range instead of guessing', () => {
    const result = parsePageRange('9-3', options);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/write it as 3-9/);
  });

  it('rejects nonsense input with the offending chunk', () => {
    const result = parsePageRange('abc', options);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('abc');
  });

  it('refuses a range wider than the configured cap', () => {
    const result = parsePageRange('1-999', { maxPages: 50 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('the limit is 50');
  });

  it('builds the advanced syntax from the From/To row', () => {
    expect(fromToRange('1', '')).toBe('1-');
    expect(fromToRange('', '5')).toBe('1-5');
    expect(fromToRange('2', '9')).toBe('2-9');
    expect(fromToRange('', '')).toBe('');
  });

  it('fills a reviewable batch from the current page', () => {
    expect(batchRange('10', 5)).toBe('10-14');
    expect(batchRange('', 3)).toBe('1-3');
  });
});

describe('search composition', () => {
  it('leaves a plain query untouched', () => {
    const composed = composeSearchTags({ tags: 'cat solo' });
    expect(composed.tags).toBe('cat solo');
    expect(countFilters(composed)).toBe(0);
  });

  it('appends the global suffix', () => {
    const composed = composeSearchTags({ tags: 'cat', globalSuffix: 'rating:safe' });
    expect(composed.tags).toBe('cat rating:safe');
    expect(composed.appended).toEqual(['rating:safe']);
  });

  it('spells blacklisted tags as exclusions', () => {
    const composed = composeSearchTags({ tags: 'cat', blacklist: 'guro, vore' });
    expect(composed.tags).toBe('cat -guro -vore');
    expect(composed.excluded).toEqual(['guro', 'vore']);
  });

  it('drops a positive tag that is blacklisted', () => {
    const composed = composeSearchTags({ tags: 'cat guro', blacklist: 'guro' });
    expect(composed.tags).toBe('cat -guro');
  });

  it('accepts a blacklist the user typed with minus signs', () => {
    const composed = composeSearchTags({ tags: '-guro', blacklist: '-guro' });
    expect(composed.tags).toBe('-guro');
  });

  it('never duplicates a token', () => {
    const composed = composeSearchTags({ tags: 'cat cat', globalSuffix: 'cat rating:safe rating:safe' });
    expect(composed.tags).toBe('cat rating:safe');
  });
});

describe('name template editor', () => {
  it('rebuilds a template from the ticked tokens in catalog order', () => {
    const tokens: Record<string, boolean> = { md5: true, id: true };
    expect(buildTemplate(tokens)).toBe('{id}_{md5}');
  });

  it('detects which tokens a stored template uses', () => {
    const used = templateTokensInUse('{artist} - {id}');
    expect(used.artist).toBe(true);
    expect(used.id).toBe(true);
    expect(used.md5).toBe(false);
  });

  it('recognises a canonical template and rejects a custom one', () => {
    expect(isCanonicalTemplate('{id}_{md5}')).toBe('{id}_{md5}');
    expect(isCanonicalTemplate('')).toBe('');
    expect(isCanonicalTemplate('{id}-{md5}')).toBeNull();
    expect(isCanonicalTemplate('post-{id}')).toBeNull();
    expect(isTokenOnlyTemplate('post-{id}')).toBe(false);
    expect(isTokenOnlyTemplate('{id}_{md5}')).toBe(true);
  });

  it('documents every token with a label and a hint', () => {
    for (const token of TEMPLATE_TOKENS) {
      expect(token.label.length).toBeGreaterThan(0);
      expect(token.hint.length).toBeGreaterThan(0);
    }
  });

  it('renders a believable preview path from the templates', () => {
    const preview = previewNaming({
      settings: { ...DEFAULT_SETTINGS, folderTemplate: 'booru/{siteType}/{artist}', filenameTemplate: '{id}_{rating}' },
    });
    expect(preview.folder).toBe('booru/e621/artist_name');
    expect(preview.filename).toBe('1500000_safe.jpg');
  });
});

describe('download history', () => {
  function entry(overrides: Partial<DownloadHistoryEntry> = {}): DownloadHistoryEntry {
    return {
      key: historyKey('server-1', '1500000'),
      serverId: 'server-1',
      siteType: 'e621',
      postId: '1500000',
      label: '#1500000 cat',
      filename: 'booru/e621/1500000_4f2a.jpg',
      postUrl: 'https://e621.net/posts/1500000',
      bytes: 524288,
      at: new Date('2024-05-06T07:08:09.000Z').toISOString(),
      quality: 'original',
      completion: 'browser-complete',
      ...overrides,
    };
  }

  it('remembers a download and answers membership questions', async () => {
    const store = new DownloadHistoryStore(new MemoryStorageArea());
    await store.add(entry());
    expect(await store.size()).toBe(1);
    expect(await store.has('server-1', '1500000')).toBe(true);
    expect(await store.has('server-1', '999')).toBe(false);
    expect((await store.index()).get('server-1:1500000')?.filename).toBe('booru/e621/1500000_4f2a.jpg');
  });

  it('refreshes an entry instead of duplicating it', async () => {
    const store = new DownloadHistoryStore(new MemoryStorageArea());
    await store.add(entry());
    await store.add(entry({ filename: 'booru/e621/new.jpg' }));
    const entries = await store.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.filename).toBe('booru/e621/new.jpg');
  });

  it('survives a reload of the store (it is only a cache)', async () => {
    const area = new MemoryStorageArea();
    await new DownloadHistoryStore(area).add(entry());
    const reloaded = new DownloadHistoryStore(area);
    expect(await reloaded.size()).toBe(1);
  });

  it('removes a single entry and clears everything', async () => {
    const store = new DownloadHistoryStore(new MemoryStorageArea());
    await store.add(entry());
    await store.add(entry({ key: historyKey('server-2', '42'), serverId: 'server-2', postId: '42' }));
    expect(await store.remove('server-1', '1500000')).toBe(1);
    expect(await store.size()).toBe(1);
    expect(await store.clear()).toBe(1);
    expect(await store.size()).toBe(0);
  });

  it('ignores malformed stored entries', async () => {
    const area = new MemoryStorageArea({ 'bsm.history': [{ key: 'x' }, null, 'nope', entry()] });
    expect(await new DownloadHistoryStore(area).size()).toBe(1);
  });
});

describe('search history', () => {
  it('does not lose simultaneous searches', async () => {
    const area = new MemoryStorageArea();
    const store = new SearchHistoryStore(area);
    await Promise.all(['cat', 'dog', 'bird'].map((query) => store.add('server-1', query, 5)));
    expect((await new SearchHistoryStore(area).list('server-1')).map((entry) => entry.query).sort()).toEqual(['bird', 'cat', 'dog']);
  });

  it('keeps the newest query first and de-duplicates case-insensitively', async () => {
    const store = new SearchHistoryStore(new MemoryStorageArea());
    await store.add('server-1', 'cat', 5);
    await store.add('server-1', 'dog', 5);
    await store.add('server-1', 'CAT', 5);
    const entries = await store.list('server-1');
    expect(entries.map((entry) => entry.query)).toEqual(['CAT', 'dog']);
  });

  it('does not remember a query when the limit is zero', async () => {
    const store = new SearchHistoryStore(new MemoryStorageArea());
    await store.add('server-1', 'cat', 0);
    expect(await store.list()).toEqual([]);
  });

  it('keeps a per-server limit', async () => {
    const store = new SearchHistoryStore(new MemoryStorageArea());
    for (const query of ['a', 'b', 'c', 'd']) await store.add('server-1', query, 2);
    expect((await store.list('server-1')).map((entry) => entry.query)).toEqual(['d', 'c']);
    await store.add('server-2', 'other', 2);
    expect(await store.list('server-2')).toHaveLength(1);
    expect(await store.list()).toHaveLength(3);
  });

  it('ignores an empty query', async () => {
    const store = new SearchHistoryStore(new MemoryStorageArea());
    await store.add('server-1', '   ', 5);
    expect(await store.list('server-1')).toEqual([]);
  });

  it('clears one server or all of them', async () => {
    const store = new SearchHistoryStore(new MemoryStorageArea());
    await store.add('server-1', 'cat', 5);
    await store.add('server-2', 'dog', 5);
    expect(await store.clear('server-1')).toBe(1);
    expect(await store.list()).toHaveLength(1);
    expect(await store.clear()).toBe(1);
    expect(await store.list()).toEqual([]);
  });
});

describe('panel settings keys', () => {
  it('preserves simultaneous updates to different settings', async () => {
    const area = new MemoryStorageArea();
    const store = new SettingsStore(area);
    await Promise.all([store.save({ theme: 'light' }), store.save({ maxConcurrency: 5 })]);
    const saved = await new SettingsStore(area).get();
    expect(saved.theme).toBe('light');
    expect(saved.maxConcurrency).toBe(5);
  });
  it('fills in the panel defaults', () => {
    const settings = normalizeSettings({});
    expect(settings.uiMode).toBe('sidepanel');
    expect(settings.panelDefaultTab).toBe('browse');
    expect(settings.mediaFilter).toBe('all');
    expect(settings.skipDownloaded).toBe(false);
    expect(settings.pageRangeLimit).toBe(150);
    expect(settings.queueRowLimit).toBe(60);
    expect(settings.filePreference).toBe('original');
    expect(settings.duplicateBehaviour).toBe('uniquify');
    expect(settings.searchHistoryEnabled).toBe(true);
    expect(settings.searchHistoryLimit).toBe(12);
  });

  it('rejects unknown option values instead of storing them', () => {
    const settings = normalizeSettings({ uiMode: 'hologram', panelDefaultTab: 'nope', mediaFilter: 'audio', duplicateBehaviour: 'explode' });
    expect(settings.uiMode).toBe('sidepanel');
    expect(settings.panelDefaultTab).toBe('browse');
    expect(settings.mediaFilter).toBe('all');
    expect(settings.duplicateBehaviour).toBe('uniquify');
  });

  it('clamps the numeric knobs', () => {
    const settings = normalizeSettings({ pageRangeLimit: 99_999, queueRowLimit: 1, searchHistoryLimit: -4, maxConcurrency: 42 });
    expect(settings.pageRangeLimit).toBe(500);
    expect(settings.queueRowLimit).toBe(10);
    expect(settings.searchHistoryLimit).toBe(0);
    expect(settings.maxConcurrency).toBe(8);
  });

  it('normalises the blacklist into plain tag tokens', () => {
    const settings = normalizeSettings({ tagBlacklist: '  -guro,\n  vore   scat ' });
    expect(settings.tagBlacklist).toBe('guro vore scat');
    expect(normalizeSettings({ globalTagSuffix: '-scat  rating:safe' }).globalTagSuffix).toBe('scat rating:safe');
  });
});

describe('media filter', () => {
  it('matches posts against the panel filter', () => {
    expect(postMatchesMedia({ isVideo: true }, 'all')).toBe(true);
    expect(postMatchesMedia({ isVideo: true }, 'video')).toBe(true);
    expect(postMatchesMedia({ isVideo: true }, 'image')).toBe(false);
    expect(postMatchesMedia({ isVideo: false }, 'video')).toBe(false);
    expect(postMatchesMedia({ isVideo: false }, 'image')).toBe(true);
  });
});
