/**
 * Fixture tests for the adapter families added beyond e621 / Danbooru /
 * Gelbooru. Fixtures are trimmed copies of live responses captured on
 * 2026-09-28 (see reference/README.md for how the endpoints were confirmed).
 */
import { describe, expect, it } from 'vitest';
import { registerBuiltinAdapters } from '../../src/adapters/index.js';
import { rule34Adapter, safebooruOrgAdapter } from '../../src/adapters/gelbooru-forks.js';
import { composeHydrusTags, hydrusAdapter } from '../../src/adapters/hydrus.js';
import { konachanAdapter, yandereAdapter } from '../../src/adapters/moebooru.js';
import { composePhilomenaQuery, derpibooruAdapter } from '../../src/adapters/philomena.js';
import { createAdapterContext } from '../../src/core/registry.js';
import { createServerConfig } from '../../src/core/servers.js';
import { BooruError } from '../../src/shared/errors.js';
import { DEFAULT_SETTINGS, type ServerConfig } from '../../src/shared/types.js';
import { redactUrl } from '../../src/shared/util.js';
import { httpSnapshot } from '../helpers.js';

registerBuiltinAdapters();

function ctxFor(adapter: { siteType: string; defaults: { baseUrl: string } }, overrides: Partial<ServerConfig> = {}) {
  const server = createServerConfig({ siteType: adapter.siteType, baseUrl: adapter.defaults.baseUrl, label: 'test', ...overrides });
  return createAdapterContext(adapter as never, server, DEFAULT_SETTINGS);
}

// ---------------------------------------------------------------------------
// Gelbooru 0.1.11 forks
// ---------------------------------------------------------------------------

const safebooruOrgPost = {
  preview_url: 'https://safebooru.org/thumbnails/3921/thumbnail_b2a60d64754c5849836c99480d452860.jpg',
  sample_url: 'https://safebooru.org/images/3921/b2a60d64754c5849836c99480d452860.png',
  file_url: 'https://safebooru.org/images/3921/b2a60d64754c5849836c99480d452860.png',
  directory: 3921,
  hash: 'b2a60d64754c5849836c99480d452860',
  width: 642,
  height: 802,
  id: 7184538,
  image: 'b2a60d64754c5849836c99480d452860.png',
  change: 1790614189,
  owner: 'mioxnorman',
  parent_id: 0,
  rating: 'safe',
  sample: false,
  score: 0,
  tags: 'character_name dress long_hair maihama_ayumu pink_eyes pink_hair',
  source: '',
  status: 'active',
};

describe('Gelbooru 0.1.11 forks (safebooru.org, rule34.xxx)', () => {
  it('parses the bare-array listing that 0.1.11 instances return', () => {
    const ctx = ctxFor(safebooruOrgAdapter);
    const result = safebooruOrgAdapter.parseSearchResponse(httpSnapshot([safebooruOrgPost]), { limit: 100, page: 0 }, ctx);
    expect(result.posts).toHaveLength(1);
    const post = result.posts[0]!;
    expect(post.id).toBe('7184538');
    expect(post.md5).toBe('b2a60d64754c5849836c99480d452860');
    expect(post.ext).toBe('png');
    expect(post.rating).toBe('general');
    expect(post.rawRating).toBe('safe');
    expect(post.postUrl).toBe('https://safebooru.org/index.php?page=post&s=view&id=7184538');
    expect(result.hasMore).toBe(false);
  });

  it('accepts the bare array in the endpoint probe', () => {
    const ctx = ctxFor(safebooruOrgAdapter);
    const probe = safebooruOrgAdapter.buildValidationProbes(ctx).find((entry) => entry.purpose === 'endpoint')!;
    expect(probe.interpret(httpSnapshot([safebooruOrgPost])).ok).toBe(true);
  });

  it('still parses the Gelbooru 0.2 envelope through the same factory', () => {
    const ctx = ctxFor(safebooruOrgAdapter);
    const result = safebooruOrgAdapter.parseSearchResponse(
      httpSnapshot({ '@attributes': { limit: 100, offset: 0, count: 1 }, post: [safebooruOrgPost] }),
      { limit: 100, page: 0 },
      ctx,
    );
    expect(result.totalCount).toBe(1);
  });

  it('classifies rule34.xxx "Missing authentication" as an auth failure and marks credentials required', () => {
    const ctx = ctxFor(rule34Adapter);
    const failure = rule34Adapter.classifyFailure!(httpSnapshot('"Missing authentication. Go to api.rule34.xxx for more information"'));
    expect(failure?.kind).toBe('auth-failure');
    expect(rule34Adapter.capabilities.supportsAnonymousAccess).toBe(false);
    expect(rule34Adapter.credentialFields().find((field) => field.key === 'apiKey')?.required).toBe(true);
    expect(rule34Adapter.credentialFields().find((field) => field.key === 'userId')?.required).toBe(true);
    expect(() => rule34Adapter.parseSearchResponse(httpSnapshot('"Missing authentication."'), {}, ctx)).toThrow(BooruError);
  });

  it('runs the rule34 endpoint probe with credentials when the profile has them', () => {
    const ctx = ctxFor(rule34Adapter, { apiKey: 'k', userId: '7' });
    const probe = rule34Adapter.buildValidationProbes(ctx).find((entry) => entry.purpose === 'endpoint')!;
    const url = new URL(probe.request.url);
    expect(url.searchParams.get('api_key')).toBe('k');
    expect(url.searchParams.get('user_id')).toBe('7');
  });

  it('detects post and list routes on fork hosts', () => {
    expect(rule34Adapter.matchRoute('https://rule34.xxx/index.php?page=post&s=view&id=1234')?.postId).toBe('1234');
    expect(safebooruOrgAdapter.matchRoute('https://safebooru.org/index.php?page=post&s=list&tags=cat')?.kind).toBe('search');
    expect(safebooruOrgAdapter.matchRoute('https://safebooru.donmai.us/posts/1')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Moebooru
// ---------------------------------------------------------------------------

const yanderePost = {
  id: 1269670,
  tags: 'heels maid skirt_lift tagme the_idolm@ster the_idolm@ster_cinderella_girls',
  created_at: 1790601138,
  updated_at: 1790601148,
  creator_id: 200442,
  author: 'moonian',
  source: 'https://idolmaster-official.jp/live_event/cg_apai/',
  score: 5,
  md5: '07fa0ef4b443263ce4dac33fb5feedb1',
  file_size: 277720,
  file_ext: 'webp',
  file_url: 'https://files.yande.re/image/07fa0ef4b443263ce4dac33fb5feedb1/yande.re%201269670.webp',
  preview_url: 'https://assets.yande.re/data/preview/07/fa/07fa0ef4b443263ce4dac33fb5feedb1.jpg',
  sample_url: 'https://files.yande.re/sample/07fa0ef4b443263ce4dac33fb5feedb1/yande.re%201269670%20sample.jpg',
  jpeg_url: 'https://files.yande.re/jpeg/07fa0ef4b443263ce4dac33fb5feedb1/yande.re%201269670.jpg',
  rating: 's',
  has_children: false,
  parent_id: null,
  status: 'active',
  width: 2000,
  height: 1420,
};

describe('Moebooru adapter (yande.re / konachan)', () => {
  it('builds /post.json requests with optional login + password_hash', () => {
    const anon = new URL(yandereAdapter.buildSearchRequest(ctxFor(yandereAdapter), { tags: 'maid', limit: 20, page: 3 }).url);
    expect(anon.pathname).toBe('/post.json');
    expect(anon.searchParams.get('tags')).toBe('maid');
    expect(anon.searchParams.get('limit')).toBe('20');
    expect(anon.searchParams.get('page')).toBe('3');
    expect(anon.searchParams.has('login')).toBe(false);

    const authed = new URL(yandereAdapter.buildSearchRequest(ctxFor(yandereAdapter, { username: 'u', apiKey: 'deadbeef' }), { tags: 'maid' }).url);
    expect(authed.searchParams.get('login')).toBe('u');
    expect(authed.searchParams.get('password_hash')).toBe('deadbeef');
    expect(redactUrl(authed.toString())).not.toContain('deadbeef');
  });

  it('applies the s/q/e rating exclusions', () => {
    const url = new URL(
      yandereAdapter.buildSearchRequest(ctxFor(yandereAdapter), { tags: 'maid', ratingFilter: { enabled: true, allowed: ['safe'] } }).url,
    );
    expect(url.searchParams.get('tags')).toBe('maid -rating:q -rating:e');
  });

  it('normalizes the live yande.re post shape', () => {
    const ctx = ctxFor(yandereAdapter);
    const result = yandereAdapter.parseSearchResponse(httpSnapshot([yanderePost]), { limit: 40, page: 1 }, ctx);
    const post = result.posts[0]!;
    expect(post.id).toBe('1269670');
    expect(post.ext).toBe('webp');
    expect(post.rating).toBe('safe');
    expect(post.sampleUrl).toContain('/sample/');
    expect(post.createdAt).toBe(new Date(1790601138 * 1000).toISOString());
    expect(post.postUrl).toBe('https://yande.re/post/show/1269670');
    expect(post.sources).toEqual(['https://idolmaster-official.jp/live_event/cg_apai/']);
    expect(post.sizeBytes).toBe(277720);
  });

  it('fetches a single post through tags=id:N and picks the matching entry', () => {
    const ctx = ctxFor(konachanAdapter);
    const request = konachanAdapter.buildPostRequest(ctx, '1269670');
    expect(new URL(request.url).searchParams.get('tags')).toBe('id:1269670');
    const post = konachanAdapter.parsePostResponse(httpSnapshot([yanderePost]), '1269670', ctx);
    expect(post.id).toBe('1269670');
    expect(() => konachanAdapter.parsePostResponse(httpSnapshot([]), '1', ctx)).toThrow(/no post 1/);
  });

  it('detects Moebooru routes', () => {
    expect(yandereAdapter.matchRoute('https://yande.re/post/show/1269670')?.postId).toBe('1269670');
    expect(yandereAdapter.matchRoute('https://yande.re/post?tags=maid&page=2')).toMatchObject({ kind: 'search', tags: 'maid', page: 2 });
    expect(konachanAdapter.matchRoute('https://konachan.net/post/show/5')?.siteType).toBe('konachan');
    expect(konachanAdapter.matchRoute('https://yande.re/post/show/5')).toBeNull();
  });

  it('rejects a Danbooru-shaped array in the endpoint probe', () => {
    const probe = yandereAdapter.buildValidationProbes(ctxFor(yandereAdapter)).find((entry) => entry.purpose === 'endpoint')!;
    expect(probe.interpret(httpSnapshot([yanderePost])).ok).toBe(true);
    expect(probe.interpret(httpSnapshot({ posts: [] })).kind).toBe('endpoint-mismatch');
  });
});

// ---------------------------------------------------------------------------
// Philomena
// ---------------------------------------------------------------------------

const derpiImage = {
  id: 3903231,
  tag_ids: [988, 2373],
  description: 'A drawthread gif',
  source_url: 'https://desuarchive.org/mlp/thread/12721672#12725353',
  source_urls: ['https://desuarchive.org/mlp/thread/12721672#12725353'],
  size: 79945,
  score: 3,
  animated: true,
  name: '1376111821871.gif',
  width: 640,
  height: 360,
  tags: ['animated', 'artist:anonymous', 'earth pony', 'female', 'food', 'gif', 'pony', 'safe', 'oc:filly anon'],
  created_at: '2026-09-28T16:43:50Z',
  mime_type: 'image/gif',
  duration: 0.48,
  format: 'gif',
  duplicate_of: null,
  view_url: 'https://derpicdn.net/img/view/2026/9/28/3903231__safe_artist-colon-anonymous.gif',
  sha512_hash: '0dc97d8b',
  representations: {
    full: 'https://derpicdn.net/img/view/2026/9/28/3903231.gif',
    small: 'https://derpicdn.net/img/2026/9/28/3903231/small.gif',
    thumb: 'https://derpicdn.net/img/2026/9/28/3903231/thumb.gif',
    large: 'https://derpicdn.net/img/2026/9/28/3903231/full.gif',
  },
};

describe('Philomena adapter (Derpibooru)', () => {
  it('composes comma-separated queries with rating tags as plain exclusions', () => {
    expect(composePhilomenaQuery('pinkie pie, cute', ['-explicit'], '-tagme')).toBe('pinkie pie, cute, -explicit, -tagme');
    expect(composePhilomenaQuery('', [], '')).toBe('*');
    const { tags } = derpibooruAdapter.ratingQueryTags(['safe', 'sensitive']);
    expect(tags).toEqual(['-questionable', '-explicit', '-semi-grimdark', '-grimdark', '-grotesque']);
  });

  it('builds the search request with per_page, page, key and the Everything filter', () => {
    const url = new URL(
      derpibooruAdapter.buildSearchRequest(ctxFor(derpibooruAdapter, { apiKey: 'secret' }), {
        tags: 'pinkie pie',
        limit: 50,
        page: 2,
        ratingFilter: { enabled: true, allowed: ['safe'] },
      }).url,
    );
    expect(url.pathname).toBe('/api/v1/json/search/images');
    expect(url.searchParams.get('q')).toBe('pinkie pie, -suggestive, -questionable, -explicit, -semi-grimdark, -grimdark, -grotesque');
    expect(url.searchParams.get('per_page')).toBe('50');
    expect(url.searchParams.get('page')).toBe('2');
    expect(url.searchParams.get('key')).toBe('secret');
    expect(url.searchParams.get('filter_id')).toBe('56027');
    expect(redactUrl(url.toString())).not.toContain('secret');
  });

  it('lets the profile override the filter id through the User ID field', () => {
    const url = new URL(derpibooruAdapter.buildSearchRequest(ctxFor(derpibooruAdapter, { userId: '100073' }), { tags: 'safe' }).url);
    expect(url.searchParams.get('filter_id')).toBe('100073');
  });

  it('normalizes the live Derpibooru image shape', () => {
    const ctx = ctxFor(derpibooruAdapter);
    const result = derpibooruAdapter.parseSearchResponse(httpSnapshot({ total: 2486119, images: [derpiImage], interactions: [] }), { limit: 50, page: 1 }, ctx);
    expect(result.totalCount).toBe(2486119);
    expect(result.hasMore).toBe(true);
    const post = result.posts[0]!;
    expect(post.id).toBe('3903231');
    expect(post.fileUrl).toBe(derpiImage.view_url);
    expect(post.previewUrl).toBe(derpiImage.representations.thumb);
    expect(post.sampleUrl).toBe(derpiImage.representations.large);
    expect(post.rating).toBe('safe');
    expect(post.rawRating).toBe('safe');
    expect(post.ext).toBe('gif');
    expect(post.isAnimated).toBe(true);
    expect(post.artistTags).toEqual(['anonymous']);
    expect(post.characterTags).toEqual(['oc:filly anon']);
    expect(post.postUrl).toBe('https://derpibooru.org/images/3903231');
    expect(post.md5).toBeNull();
  });

  it('parses the single-image envelope and maps grimdark ratings', () => {
    const ctx = ctxFor(derpibooruAdapter);
    const post = derpibooruAdapter.parsePostResponse(httpSnapshot({ image: { ...derpiImage, tags: ['pony', 'grimdark'] } }), '3903231', ctx);
    expect(post.rating).toBe('explicit');
    expect(post.rawRating).toBe('grimdark');
    expect(new URL(derpibooruAdapter.buildPostRequest(ctx, '3903231').url).pathname).toBe('/api/v1/json/images/3903231');
  });

  it('detects Philomena routes including the short /{id} form', () => {
    expect(derpibooruAdapter.matchRoute('https://derpibooru.org/images/3903231')?.postId).toBe('3903231');
    expect(derpibooruAdapter.matchRoute('https://derpibooru.org/3903231')?.postId).toBe('3903231');
    expect(derpibooruAdapter.matchRoute('https://derpibooru.org/search?q=pinkie+pie&page=3')).toMatchObject({ kind: 'search', tags: 'pinkie pie', page: 3 });
    expect(derpibooruAdapter.matchRoute('https://furbooru.org/images/1')).toBeNull();
  });

  it('validates the API key through /filters/user', () => {
    const ctx = ctxFor(derpibooruAdapter, { apiKey: 'secret' });
    const probes = derpibooruAdapter.buildValidationProbes(ctx);
    const auth = probes.find((entry) => entry.purpose === 'auth')!;
    expect(auth.enabled).toBe(true);
    expect(new URL(auth.request.url).pathname).toBe('/api/v1/json/filters/user');
    expect(auth.interpret(httpSnapshot({ filters: [{ id: 1 }] })).ok).toBe(true);
    expect(auth.interpret(httpSnapshot({ error: 'nope' })).kind).toBe('auth-failure');
    expect(probes.find((entry) => entry.purpose === 'endpoint')!.interpret(httpSnapshot({ images: [], total: 0 })).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Hydrus
// ---------------------------------------------------------------------------

const hydrusMetadata = {
  file_id: 42,
  hash: 'ad6d3599a6c489a575eb19c026face97a9cd6579e74728b0ce94a601d232f3c3',
  size: 63405,
  mime: 'image/png',
  filetype_human: 'png',
  ext: '.png',
  width: 1200,
  height: 800,
  duration: null,
  has_audio: false,
  time_imported: 1700000000,
  known_urls: ['https://e621.net/posts/1'],
  tags: {
    '6c6f63616c2074616773': {
      name: 'my tags',
      type: 5,
      storage_tags: { '0': ['creator:someone', 'blue eyes'] },
      display_tags: { '0': ['creator:someone', 'blue eyes', 'character:someone else', 'series:thing'] },
    },
  },
};

describe('Hydrus adapter', () => {
  const ctx = ctxFor(hydrusAdapter, { apiKey: 'abc123' });

  it('normalizes the base URL to plain http on localhost', () => {
    expect(hydrusAdapter.normalizeBaseUrl!('127.0.0.1:45869/')).toBe('http://127.0.0.1:45869');
    expect(ctx.baseUrl).toBe('http://127.0.0.1:45869');
  });

  it('builds search_files with a JSON tag list and the key as a query parameter', () => {
    const url = new URL(hydrusAdapter.buildSearchRequest(ctx, { tags: 'blue eyes, -tagme', limit: 100, page: 1 }).url);
    expect(url.pathname).toBe('/get_files/search_files');
    expect(JSON.parse(url.searchParams.get('tags')!)).toEqual(['blue eyes', '-tagme']);
    expect(url.searchParams.get('Hydrus-Client-API-Access-Key')).toBe('abc123');
    expect(redactUrl(url.toString())).not.toContain('abc123');
    expect(composeHydrusTags('', '')).toEqual(['system:everything']);
  });

  it('pages the id list locally and yields lightweight rows', () => {
    const ids = Array.from({ length: 130 }, (_, index) => index + 1);
    const page2 = hydrusAdapter.parseSearchResponse(httpSnapshot({ file_ids: ids }), { limit: 100, page: 2 }, ctx);
    expect(page2.posts).toHaveLength(30);
    expect(page2.totalCount).toBe(130);
    expect(page2.hasMore).toBe(false);
    expect(page2.posts[0]!.id).toBe('101');
    expect(page2.posts[0]!.fileUrl).toContain('/get_files/file?file_id=101');
    expect(page2.posts[0]!.previewUrl).toContain('/get_files/thumbnail?file_id=101');
    const page1 = hydrusAdapter.parseSearchResponse(httpSnapshot({ file_ids: ids }), { limit: 100, page: 1 }, ctx);
    expect(page1.hasMore).toBe(true);
  });

  it('fills in extension, size and namespaced tags from file_metadata', () => {
    const request = hydrusAdapter.buildPostRequest(ctx, '42');
    expect(JSON.parse(new URL(request.url).searchParams.get('file_ids')!)).toEqual([42]);
    const post = hydrusAdapter.parsePostResponse(httpSnapshot({ metadata: [hydrusMetadata] }), '42', ctx);
    expect(post.ext).toBe('png');
    expect(post.sizeBytes).toBe(63405);
    expect(post.width).toBe(1200);
    expect(post.artistTags).toEqual(['someone']);
    expect(post.characterTags).toEqual(['someone else']);
    expect(post.tagCategories.copyright).toEqual(['thing']);
    expect(post.sources).toEqual(['https://e621.net/posts/1']);
    expect(post.createdAt).toBe(new Date(1700000000 * 1000).toISOString());
  });

  it('interprets version and access-key probes', () => {
    const [endpoint, auth] = hydrusAdapter.buildValidationProbes(ctx);
    expect(endpoint!.interpret(httpSnapshot({ version: 78, hydrus_version: 600 })).ok).toBe(true);
    expect(endpoint!.interpret(httpSnapshot({ hello: 'world' })).kind).toBe('endpoint-mismatch');
    expect(auth!.enabled).toBe(true);
    expect(auth!.interpret(httpSnapshot({ basic_permissions: [3], human_description: 'API Permissions (booru): search' })).ok).toBe(true);
    expect(auth!.interpret(httpSnapshot({ basic_permissions: [0], human_description: 'x' })).kind).toBe('auth-failure');
    expect(auth!.interpret(httpSnapshot({}, 419)).kind).toBe('auth-failure');
    expect(auth!.interpret(httpSnapshot({}, 403)).kind).toBe('auth-failure');
  });

  it('reports no ratings instead of pretending to filter', () => {
    expect(hydrusAdapter.capabilities.supportsRatingFilter).toBe(false);
    expect(hydrusAdapter.ratingQueryTags(['safe']).tags).toEqual([]);
    expect(hydrusAdapter.ratingQueryTags(['safe']).warnings[0]).toMatch(/no rating/);
  });
});
