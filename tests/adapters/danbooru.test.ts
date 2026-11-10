import { describe, expect, it } from 'vitest';
import { danbooruAdapter, danbooruAuthHeader } from '../../src/adapters/danbooru.js';
import { createAdapterContext } from '../../src/core/registry.js';
import { DEFAULT_SETTINGS, type BooruPost } from '../../src/shared/types.js';
import { danbooruServer, htmlSnapshot, httpSnapshot } from '../helpers.js';
import { decodeBase64 } from '../base64.js';

const settings = DEFAULT_SETTINGS;

function context(overrides: Record<string, unknown> = {}) {
  return createAdapterContext(danbooruAdapter, danbooruServer(overrides as never), settings);
}

const post = {
  id: 6_000_001,
  created_at: '2024-06-01T12:00:00.000-04:00',
  rating: 's',
  score: 42,
  file_ext: 'jpg',
  file_size: 512_000,
  image_width: 1400,
  image_height: 1000,
  md5: 'deadbeef',
  file_url: 'https://cdn.donmai.us/original/de/ad/deadbeef.jpg',
  large_file_url: 'https://cdn.donmai.us/sample/de/ad/sample-deadbeef.jpg',
  preview_file_url: 'https://cdn.donmai.us/180x180/de/ad/deadbeef.jpg',
  source: 'https://artist.example/post/1',
  tag_string_general: 'blue_sky cloud city',
  tag_string_artist: 'kite',
  tag_string_character: 'alba',
  tag_string_copyright: 'original_series',
  tag_string_meta: 'highres',
  is_animated: false,
};

describe('Danbooru adapter - auth', () => {
  it('uses HTTP Basic with username + api key (documented)', () => {
    const header = danbooruAuthHeader(context());
    expect(header).toMatch(/^Basic /);
    expect(decodeBase64(header!.slice(6))).toBe('demo_danbooru:danbooru-demo-key');
  });

  it('attaches the header to search and post requests', () => {
    expect(danbooruAdapter.buildSearchRequest(context(), { tags: 'cat' }).headers?.Authorization).toMatch(/^Basic /);
    expect(danbooruAdapter.buildPostRequest(context(), '1').headers?.Authorization).toMatch(/^Basic /);
  });
});

describe('Danbooru adapter - requests', () => {
  it('builds the posts listing request with tags, limit and page', () => {
    const spec = danbooruAdapter.buildSearchRequest(context(), { tags: 'cat solo', limit: 30, page: 3 });
    const url = new URL(spec.url);
    expect(url.pathname).toBe('/posts.json');
    expect(url.searchParams.get('tags')).toBe('cat solo');
    expect(url.searchParams.get('limit')).toBe('30');
    expect(url.searchParams.get('page')).toBe('3');
  });

  it('uses Danbooru rating tokens (g/s/q/e) for exclusions', () => {
    const spec = danbooruAdapter.buildSearchRequest(context(), {
      tags: 'cat',
      ratingFilter: { enabled: true, allowed: ['general', 'sensitive'] },
    });
    const tags = new URL(spec.url).searchParams.get('tags') ?? '';
    expect(tags).toContain('-rating:q');
    expect(tags).toContain('-rating:e');
    expect(tags).not.toContain('-rating:s');
    expect(tags).not.toContain('-rating:g');
  });

  it('clamps the limit to the documented maximum of 200', () => {
    const spec = danbooruAdapter.buildSearchRequest(context(), { limit: 999 });
    expect(new URL(spec.url).searchParams.get('limit')).toBe('200');
  });

  it('supports self-hosted instance base URLs', () => {
    const ctx = createAdapterContext(danbooruAdapter, danbooruServer({ baseUrl: 'https://booru.example.org' }), settings);
    const spec = danbooruAdapter.buildSearchRequest(ctx, { tags: 'cat' });
    expect(new URL(spec.url).origin).toBe('https://booru.example.org');
  });
});

describe('Danbooru adapter - parsing', () => {
  it('normalizes posts including tag categories', () => {
    const normalized = danbooruAdapter.normalizePost(post, context()) as BooruPost;
    expect(normalized.rating).toBe('sensitive');
    expect(normalized.artistTags).toEqual(['kite']);
    expect(normalized.characterTags).toEqual(['alba']);
    expect(normalized.tags).toEqual(expect.arrayContaining(['blue_sky', 'kite', 'alba']));
    expect(normalized.width).toBe(1400);
    expect(normalized.sizeBytes).toBe(512_000);
    expect(normalized.sampleUrl).toContain('/sample/');
  });

  it('keeps samples for display but does not substitute them for a missing original', () => {
    const normalized = danbooruAdapter.normalizePost(
      { id: 5, rating: 'g', file_url: null, large_file_url: 'https://cdn.donmai.us/sample/x.jpg', file_ext: 'jpg' },
      context(),
    ) as BooruPost;
    expect(normalized.fileUrl).toBe('');
    expect(normalized.sampleUrl).toContain('/sample/');
  });

  it('parses list responses', () => {
    const snapshot = httpSnapshot([post]);
    const result = danbooruAdapter.parseSearchResponse(snapshot, { limit: 1 }, context());
    expect(result.posts).toHaveLength(1);
    expect(result.hasMore).toBe(true);
  });
});

describe('Danbooru adapter - failure classification', () => {
  it('separates 401 from 403', () => {
    expect(danbooruAdapter.classifyFailure!(httpSnapshot({ error: 'unauthorized' }, 401))?.kind).toBe('auth-failure');
    expect(danbooruAdapter.classifyFailure!(httpSnapshot({ error: 'forbidden' }, 403))?.kind).toBe('blocked');
  });

  it('detects endpoint mismatch (HTML page instead of API)', () => {
    expect(danbooruAdapter.classifyFailure!(htmlSnapshot())?.kind).toBe('endpoint-mismatch');
  });

  it('detects rate limiting', () => {
    expect(danbooruAdapter.classifyFailure!(httpSnapshot({ error: 'throttled' }, 429))?.kind).toBe('rate-limited');
  });
});

describe('Danbooru adapter - validation probes', () => {
  it('probes anonymously for the endpoint and /profile.json for credentials', () => {
    const probes = danbooruAdapter.buildValidationProbes(context());
    expect(probes).toHaveLength(2);
    expect(probes[0]!.purpose).toBe('endpoint');
    expect(probes[0]!.request.url).toContain('/posts.json?limit=1');
    expect(probes[0]!.request.headers?.Authorization).toBeUndefined();
    expect(probes[1]!.purpose).toBe('auth');
    expect(probes[1]!.request.url).toContain('/profile.json');
  });

  it('reads the account name out of a successful profile probe', () => {
    const probe = danbooruAdapter.buildValidationProbes(context()).find((entry) => entry.purpose === 'auth')!;
    const interpretation = probe.interpret(httpSnapshot({ id: 42, name: 'demo_danbooru', level_string: 'Gold' }));
    expect(interpretation.ok).toBe(true);
    expect(interpretation.account?.username).toBe('demo_danbooru');
    expect(interpretation.account?.userId).toBe('42');
  });

  it('flags an authentication failure on the profile probe', () => {
    const probe = danbooruAdapter.buildValidationProbes(context()).find((entry) => entry.purpose === 'auth')!;
    const interpretation = probe.interpret(httpSnapshot({ error: 'unauthorized' }, 401));
    expect(interpretation.ok).toBe(false);
    expect(interpretation.kind).toBe('auth-failure');
  });

  it('skips the auth probe when no credentials are configured', () => {
    const probes = danbooruAdapter.buildValidationProbes(context({ apiKey: '', username: '' }));
    expect(probes.find((entry) => entry.purpose === 'auth')!.enabled).toBe(false);
  });
});

describe('Danbooru adapter - routes', () => {
  it('detects posts, searches and wiki routes', () => {
    expect(danbooruAdapter.matchRoute('https://danbooru.donmai.us/posts/123')?.kind).toBe('post');
    expect(danbooruAdapter.matchRoute('https://danbooru.donmai.us/posts?tags=cat&page=2')).toMatchObject({
      kind: 'search',
      tags: 'cat',
      page: 2,
    });
    expect(danbooruAdapter.matchRoute('https://safebooru.donmai.us/posts/9')?.siteType).toBe('danbooru');
    expect(danbooruAdapter.matchRoute('https://gelbooru.com/index.php?page=post&s=view&id=1')).toBeNull();
  });
});
