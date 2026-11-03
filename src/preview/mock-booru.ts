/**
 * Offline mock of the three booru APIs.
 *
 * Used by:
 *  - the browser preview harness (`npm run preview`)
 *  - integration tests that exercise the adapters through the real HTTP layer
 *
 * It deliberately implements the *documented* response shapes (e621 legacy posts,
 * Danbooru post objects, Gelbooru DAPI envelope) so adapter parsing is exercised
 * for real.
 */
import type { FetchLike } from '../shared/http.js';
import {
  credentialsLookValid,
  MOCK_CREATOR_POSTS,
  MOCK_POSTS,
  mockMediaPath,
  type MockCreatorPost,
  type MockPostSeed,
} from './mock-data.js';

export interface MockBooruOptions {
  /** Simulated latency in ms (0 in tests). */
  latencyMs?: number;
  /** Include the `/mock/media/...` prefix (preview) or absolute test URLs. */
  mediaBase?: string;
}

interface RequestContext {
  url: URL;
  site: 'e621' | 'danbooru' | 'gelbooru' | 'creator-archive';
  tags: string;
  limit: number;
  page: number;
  postId: string | null;
  apiKey: string;
  username: string;
  userId: string;
  authHeader: string | null;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

function parseBasicAuth(header: string | null): { username: string; apiKey: string } {
  if (!header?.toLowerCase().startsWith('basic ')) return { username: '', apiKey: '' };
  try {
    const decoded = atob(header.slice(6).trim());
    const index = decoded.indexOf(':');
    return { username: decoded.slice(0, index), apiKey: decoded.slice(index + 1) };
  } catch {
    return { username: '', apiKey: '' };
  }
}

function contextFor(url: URL, init?: RequestInit): RequestContext | null {
  const host = url.host;
  const headers = new Headers(init?.headers ?? {});
  const auth = parseBasicAuth(headers.get('authorization'));
  const site: RequestContext['site'] = host.includes('gelbooru')
    ? 'gelbooru'
    : host.includes('danbooru') || host.includes('donmai')
      ? 'danbooru'
      : host.includes('pawchive')
        ? 'creator-archive'
        : 'e621';
  const tags = url.searchParams.get('tags') ?? '';
  const limit = Number(url.searchParams.get('limit') ?? (site === 'gelbooru' ? 100 : 50));
  const page = Number(site === 'gelbooru' ? url.searchParams.get('pid') ?? 0 : url.searchParams.get('page') ?? 1);
  return {
    url,
    site,
    tags,
    limit: Number.isFinite(limit) && limit > 0 ? limit : 50,
    page: Number.isFinite(page) ? page : site === 'gelbooru' ? 0 : 1,
    postId: site === 'gelbooru' ? url.searchParams.get('id') : null,
    apiKey: url.searchParams.get('api_key') ?? auth.apiKey,
    username: url.searchParams.get('login') ?? auth.username,
    userId: url.searchParams.get('user_id') ?? '',
    authHeader: headers.get('authorization'),
  };
}

/** Tag matching: plain AND terms, `-term` exclusions and rating exclusions. */
function matchesTags(post: MockPostSeed, query: string): boolean {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  for (const token of tokens) {
    if (token.startsWith('force:') || token.startsWith('order:')) continue;
    if (token.startsWith('-rating:')) {
      if (post.rating === normalizeRatingWord(token.slice('-rating:'.length))) return false;
      continue;
    }
    if (token.startsWith('rating:')) {
      if (post.rating !== normalizeRatingWord(token.slice('rating:'.length))) return false;
      continue;
    }
    if (token.startsWith('-')) {
      const needle = token.slice(1);
      if (post.tags.some((tag) => tag.includes(needle))) return false;
      continue;
    }
    if (!post.tags.some((tag) => tag.includes(token))) return false;
  }
  return true;
}

function normalizeRatingWord(token: string): string {
  const map: Record<string, string> = { s: 'safe', safe: 'safe', g: 'general', general: 'general', sensitive: 'sensitive', q: 'questionable', questionable: 'questionable', e: 'explicit', explicit: 'explicit' };
  return map[token.toLowerCase()] ?? token.toLowerCase();
}

/** `force:<status>` tags make failure paths easy to demo from the UI. */
function forcedStatus(tags: string): number | null {
  const match = /force:(\d{3}|html)/.exec(tags);
  if (!match) return null;
  if (match[1] === 'html') return 999;
  return Number(match[1]);
}

function e621Post(seed: MockPostSeed, mediaBase: string) {
  const created = new Date(Date.now() - seed.daysAgo * 86_400_000).toISOString();
  return {
    id: seed.id,
    created_at: created,
    updated_at: created,
    file: {
      width: seed.width,
      height: seed.height,
      ext: seed.ext,
      size: 240_000 + seed.id % 90_000,
      md5: `md5${seed.id}${'0'.repeat(24)}`.slice(0, 32),
      url: `${mediaBase}${mockMediaPath(seed.id, seed.ext)}`,
    },
    preview: { width: 300, height: 300, url: `${mediaBase}${mockMediaPath(seed.id, 'jpg')}` },
    sample: { has: true, width: 850, height: 850, url: `${mediaBase}${mockMediaPath(seed.id, 'jpg')}` },
    score: { up: seed.score, down: 2, total: seed.score },
    rating: seed.rating === 'safe' || seed.rating === 'general' ? 's' : seed.rating === 'questionable' ? 'q' : seed.rating === 'explicit' ? 'e' : 's',
    sources: [`https://artist.example/${seed.artist}/${seed.id}`],
    description: `Synthetic preview post by ${seed.artist}`,
    tags: {
      general: [...seed.tags, 'solo'],
      artist: [seed.artist],
      character: [seed.character],
      copyright: [seed.copyright],
      species: ['human'],
      meta: [],
    },
  };
}

function danbooruPost(seed: MockPostSeed, mediaBase: string) {
  const ratingToken = seed.rating === 'general' || seed.rating === 'safe' ? 'g' : seed.rating === 'sensitive' ? 's' : seed.rating === 'questionable' ? 'q' : 'e';
  return {
    id: seed.id,
    created_at: new Date(Date.now() - seed.daysAgo * 86_400_000).toISOString(),
    rating: ratingToken,
    score: seed.score,
    file_ext: seed.ext,
    file_size: 240_000 + (seed.id % 80_000),
    image_width: seed.width,
    image_height: seed.height,
    md5: `dmd5${seed.id}${'0'.repeat(23)}`.slice(0, 32),
    file_url: `${mediaBase}${mockMediaPath(seed.id, seed.ext)}`,
    large_file_url: `${mediaBase}${mockMediaPath(seed.id, seed.ext)}`,
    preview_file_url: `${mediaBase}${mockMediaPath(seed.id, 'jpg')}`,
    source: `https://artist.example/${seed.artist}/${seed.id}`,
    tag_string_general: [...seed.tags, 'solo'].join(' '),
    tag_string_artist: seed.artist,
    tag_string_character: seed.character,
    tag_string_copyright: seed.copyright,
    tag_string_meta: '',
    is_animated: false,
  };
}

function gelbooruPost(seed: MockPostSeed, mediaBase: string) {
  const ratingToken = seed.rating === 'general' || seed.rating === 'safe' ? 'general' : seed.rating;
  return {
    id: seed.id,
    created_at: new Date(Date.now() - seed.daysAgo * 86_400_000).toUTCString(),
    score: seed.score,
    width: seed.width,
    height: seed.height,
    md5: `gmd5${seed.id}${'0'.repeat(23)}`.slice(0, 32),
    directory: `synthetic/${seed.id % 100}`,
    image: `${seed.id}.${seed.ext}`,
    rating: ratingToken,
    source: `https://artist.example/${seed.artist}/${seed.id}`,
    change: seed.id % 10_000,
    owner: seed.artist,
    creator_id: seed.id % 500,
    parent_id: '',
    sample: 1,
    sample_height: 850,
    sample_width: 850,
    preview_height: 300,
    preview_width: 300,
    tags: [...seed.tags, 'solo', seed.character, seed.copyright].join(' '),
    title: `Synthetic preview post ${seed.id}`,
    has_notes: 'false',
    has_comments: 'false',
    has_children: 'false',
    file_url: `${mediaBase}${mockMediaPath(seed.id, seed.ext)}`,
    preview_url: `${mediaBase}${mockMediaPath(seed.id, 'jpg')}`,
    sample_url: `${mediaBase}${mockMediaPath(seed.id, 'jpg')}`,
    status: 'active',
    post_locked: 0,
  };
}

/**
 * Pawchive creator-archive payloads.
 *
 * The listing returns one entry per post - the adapter expands the attachments
 * into rows itself - and the single-post route returns the newer
 * `{post, attachments}` envelope the live API uses.
 */
function creatorArchivePost(post: MockCreatorPost, mediaBase: string) {
  const files = post.files.map((file) => ({ ...file, preview_only: false }));
  return {
    id: post.id,
    service: post.service,
    user: post.user,
    title: post.title,
    published: post.published,
    content: post.content,
    file: files[0] ?? null,
    attachments: files.slice(1),
    tags: ['mock_creator', post.service],
    // The site's own host, which is what the real API returns for attachments.
    ...(mediaBase ? { server: 'pawchive' } : {}),
  };
}

/** Build a `fetch` implementation that answers the booru and archive APIs offline. */
export function createMockBooruFetch(options: MockBooruOptions = {}): FetchLike {
  const latencyMs = options.latencyMs ?? 90;
  const mediaBase = options.mediaBase ?? '';

  const respond = async (build: () => Response): Promise<Response> => {
    if (latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, latencyMs));
    return build();
  };

  return async (input, init) => {
    const url = new URL(input, 'https://preview.local');
    const ctx = contextFor(url, init);
    if (!ctx) return json({ error: 'unsupported host' }, 400);
    if (
      !['e621.net', 'e926.net', 'danbooru.donmai.us', 'gelbooru.com', 'www.gelbooru.com'].includes(url.host) &&
      !/^(?:www\.)?(?:pawchive\.pw|pawchive\.st)$/.test(url.host)
    ) {
      return json({ error: `mock backend does not know host ${url.host}` }, 404);
    }

    const forced = forcedStatus(ctx.tags);
    if (forced === 999) return respond(() => html('<!doctype html><html><body>Not the API you are looking for</body></html>', 200));
    if (forced) return respond(() => json({ error: 'forced failure' }, forced));

    // Real sites reject a supplied-but-invalid credential pair on every route,
    // so the mock does too (this is what makes 401 paths testable). Creator
    // archives are anonymous - nothing is checked there.
    const supplied = !!(ctx.apiKey || ctx.username || ctx.userId || ctx.authHeader);
    if (
      ctx.site !== 'creator-archive' &&
      supplied &&
      !credentialsLookValid(ctx.site, { username: ctx.username, apiKey: ctx.apiKey, userId: ctx.userId })
    ) {
      return respond(() => json({ error: 'unauthorized' }, 401));
    }

    // --------------------------------------------------- creator archives API
    if (ctx.site === 'creator-archive') {
      const segments = ctx.url.pathname.split('/').filter(Boolean);
      const offset = Number(ctx.url.searchParams.get('o') ?? 0) || 0;

      // Validation probe: `/api/v1/posts?o=0`.
      if (segments[0] === 'api' && segments[1] === 'v1' && segments[2] === 'posts') {
        const q = (ctx.url.searchParams.get('q') ?? '').toLowerCase();
        const tag = (ctx.url.searchParams.get('tag') ?? '').toLowerCase();
        const filtered = MOCK_CREATOR_POSTS.filter((post) => {
          const tags = ['mock_creator', post.service];
          if (tag) return tags.some((entry) => entry.includes(tag));
          if (q) return post.title.toLowerCase().includes(q);
          return true;
        });
        const slice = filtered.slice(offset, offset + 50);
        return respond(() => json({ count: filtered.length, posts: slice.map((post) => creatorArchivePost(post, mediaBase)) }));
      }

      // Creator listing: `/api/v1/{service}/user/{user}/posts?o=0`.
      if (segments[0] === 'api' && segments[1] === 'v1' && segments[3] === 'user' && segments[5] === 'posts') {
        const service = segments[2]!;
        const user = segments[4]!;
        const filtered = MOCK_CREATOR_POSTS.filter((post) => post.service === service && post.user === user);
        const slice = filtered.slice(offset, offset + 50);
        return respond(() => json({ count: filtered.length, posts: slice.map((post) => creatorArchivePost(post, mediaBase)) }));
      }

      // Single post: `/api/v1/{service}/user/{user}/post/{id}`.
      if (segments[0] === 'api' && segments[1] === 'v1' && segments[3] === 'user' && segments[5] === 'post') {
        const post = MOCK_CREATOR_POSTS.find((entry) => entry.id === segments[6]);
        if (!post) return respond(() => json({ error: 'not found' }, 404));
        const built = creatorArchivePost(post, mediaBase);
        return respond(() => json({ post: { ...built, file: undefined }, attachments: post.files.map((file) => ({ ...file, preview_only: false })) }));
      }

      return respond(() => json({ error: `unknown creator-archive route ${ctx.url.pathname}` }, 404));
    }

    // ------------------------------------------------------------- e621 API
    if (ctx.site === 'e621') {
      if (ctx.url.pathname === '/dmail.json' || ctx.url.pathname === '/favorites.json') {
        const valid = credentialsLookValid('e621', { username: ctx.username, apiKey: ctx.apiKey });
        return respond(() =>
          valid
            ? json(ctx.url.pathname === '/dmail.json' ? [] : [{ id: 1, post_id: MOCK_POSTS[0]!.id }])
            : json({ error: 'unauthorized' }, 401),
        );
      }
      if (/^\/posts\/\d+\.json$/.test(ctx.url.pathname)) {
        const id = Number(ctx.url.pathname.split('/')[2]!.replace('.json', ''));
        const seed = MOCK_POSTS.find((post) => post.id === id);
        if (!seed) return respond(() => json({ error: 'not found' }, 404));
        return respond(() => json({ post: e621Post(seed, mediaBase) }));
      }
      if (ctx.url.pathname === '/posts.json') {
        const filtered = MOCK_POSTS.filter((post) => matchesTags(post, ctx.tags));
        const start = (Math.max(ctx.page, 1) - 1) * ctx.limit;
        const slice = filtered.slice(start, start + ctx.limit);
        return respond(() => json(slice.map((post) => e621Post(post, mediaBase))));
      }
      return respond(() => json({ error: 'unknown e621 route' }, 404));
    }

    // --------------------------------------------------------- Danbooru API
    if (ctx.site === 'danbooru') {
      if (ctx.url.pathname === '/profile.json') {
        const valid = credentialsLookValid('danbooru', { username: ctx.username, apiKey: ctx.apiKey });
        return respond(() =>
          valid
            ? json({ id: 778_899, name: ctx.username || 'demo_danbooru', level_string: 'Member', level: 20 })
            : json({ error: 'unauthorized' }, 401),
        );
      }
      if (/^\/posts\/\d+\.json$/.test(ctx.url.pathname)) {
        const id = Number(ctx.url.pathname.split('/')[2]!.replace('.json', ''));
        const seed = MOCK_POSTS.find((post) => post.id === id);
        if (!seed) return respond(() => json({ error: 'not found' }, 404));
        return respond(() => json(danbooruPost(seed, mediaBase)));
      }
      if (ctx.url.pathname === '/posts.json') {
        const filtered = MOCK_POSTS.filter((post) => matchesTags(post, ctx.tags));
        const start = (Math.max(ctx.page, 1) - 1) * ctx.limit;
        const slice = filtered.slice(start, start + ctx.limit);
        return respond(() => json(slice.map((post) => danbooruPost(post, mediaBase))));
      }
      return respond(() => json({ error: 'unknown danbooru route' }, 404));
    }

    // --------------------------------------------------------- Gelbooru DAPI
    if (ctx.url.pathname === '/index.php') {
      const hasCredentials = !!(ctx.apiKey || ctx.userId);
      if (hasCredentials && !credentialsLookValid('gelbooru', { apiKey: ctx.apiKey, userId: ctx.userId })) {
        return respond(() => json({ error: 'Invalid API key or user id' }, 401));
      }
      const filtered = ctx.postId
        ? MOCK_POSTS.filter((post) => String(post.id) === ctx.postId)
        : MOCK_POSTS.filter((post) => matchesTags(post, ctx.tags));
      const start = Math.max(ctx.page, 0) * ctx.limit;
      const slice = filtered.slice(start, start + ctx.limit);
      return respond(() =>
        json({
          '@attributes': { limit: ctx.limit, offset: start, count: filtered.length },
          post: slice.map((post) => gelbooruPost(post, mediaBase)),
        }),
      );
    }

    return respond(() => json({ error: 'unknown gelbooru route' }, 404));
  };
}
