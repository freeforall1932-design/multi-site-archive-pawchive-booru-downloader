import type { AdapterContext, AdapterFailure, BooruAdapter, CredentialField, ProbeInterpretation, ValidationProbe } from '../core/adapter.js';
import { BooruError } from '../shared/errors.js';
import type { HttpResponseSnapshot, HttpRequestSpec } from '../shared/http.js';
import type { BooruPost, Rating, RouteMatch, SearchResult, SearchSpec } from '../shared/types.js';
import {
  absolutize,
  accountInfo,
  asRecord,
  classifyStatus,
  composeTags,
  detectAuthWordsInBody,
  encodeBase64,
  pickBoolean,
  pickGroup,
  pickNumber,
  pickString,
  ratingExclusions,
  readJson,
  shapeError,
} from './base.js';
import { hostMatchesPattern, splitTags, unique } from '../shared/util.js';

export const DANBOORU_VERSION = '0.1.0';
export const DANBOORU_DEFAULT_BASE = 'https://danbooru.donmai.us';

/** Danbooru ratings: g (general) / s (sensitive) / q (questionable) / e (explicit). */
const SITE_RATING_TOKENS = ['g', 's', 'q', 'e'] as const;

const CANONICAL_BY_TOKEN: Record<string, Rating> = {
  g: 'general',
  general: 'general',
  s: 'sensitive',
  sensitive: 'sensitive',
  q: 'questionable',
  questionable: 'questionable',
  e: 'explicit',
  explicit: 'explicit',
  // Legacy aliases kept for older Danbooru forks.
  safe: 'general',
};

/** Authorization header value (username:api_key), or null when incomplete. */
export function danbooruAuthHeader(ctx: AdapterContext): string | null {
  const { username, apiKey } = ctx.server;
  if (!username.trim() || !apiKey.trim()) return null;
  return `Basic ${encodeBase64(`${username}:${apiKey}`)}`;
}

function withAuth(ctx: AdapterContext, spec: HttpRequestSpec): HttpRequestSpec {
  const header = danbooruAuthHeader(ctx);
  if (!header) return spec;
  return { ...spec, headers: { ...(spec.headers ?? {}), Authorization: header } };
}

function resolvedTags(ctx: AdapterContext, spec: SearchSpec, extra: string[]): string {
  const active = spec.ratingFilter?.enabled ? extra : [];
  return composeTags(spec.tags, active, ctx.settings.globalTagSuffix);
}

function classifyFailure(snapshot: HttpResponseSnapshot): AdapterFailure | null {
  return classifyStatus(snapshot, 'Danbooru') ?? detectAuthWordsInBody(snapshot.bodyText);
}

function normalizeRating(raw: unknown): Rating {
  if (typeof raw !== 'string') return 'unknown';
  return CANONICAL_BY_TOKEN[raw.trim().toLowerCase()] ?? 'unknown';
}

function matchesHost(host: string): boolean {
  return (
    hostMatchesPattern(host, 'danbooru.donmai.us') ||
    hostMatchesPattern(host, '*.donmai.us') ||
    hostMatchesPattern(host, 'safebooru.donmai.us') ||
    // Self-hosted Danbooru-like instances can be attached by adding the host
    // pattern at registration time - see docs/ADAPTER_CONTRACT.md.
    hostMatchesPattern(host, 'testbooru.donmai.us')
  );
}

/**
 * Map a Danbooru post JSON object into the shared post shape.
 * Handles the modern `file_url`/`large_file_url`/`preview_file_url` keys as well
 * as the legacy `file_url`/`sample_url`/`preview_url` trio used by forks.
 */
function normalizePost(raw: unknown, ctx: AdapterContext): BooruPost {
  const post = asRecord(raw);
  if (!post) throw shapeError('Danbooru post', 'post entry was not an object');
  const id = pickString(post, 'id') ?? '';
  // `large_file_url`, sample and preview are not the original. Keep them for
  // display only when the API withholds `file_url` (e.g. a restricted post).
  const fileUrl = absolutize(ctx.baseUrl, pickString(post, 'file_url')) ?? '';
  const ext = deriveExt(post, fileUrl);
  const previewUrl =
    absolutize(ctx.baseUrl, pickString(post, 'preview_file_url', 'preview_url', 'large_file_url', 'file_url')) ?? fileUrl;
  const sampleUrl = absolutize(ctx.baseUrl, pickString(post, 'large_file_url', 'sample_url'));

  const categories: Record<string, string[]> = {
    general: splitTags(pickString(post, 'tag_string_general') ?? ''),
    artist: splitTags(pickString(post, 'tag_string_artist') ?? ''),
    character: splitTags(pickString(post, 'tag_string_character') ?? ''),
    copyright: splitTags(pickString(post, 'tag_string_copyright') ?? ''),
    meta: splitTags(pickString(post, 'tag_string_meta') ?? ''),
    species: splitTags(pickString(post, 'tag_string_species') ?? ''),
  };
  const legacyTagString = pickString(post, 'tag_string');
  if (legacyTagString && (categories.general ?? []).length === 0) categories.general = splitTags(legacyTagString);
  // Some forks expose `artist` as an array instead of `tag_string_artist`.
  if ((categories.artist ?? []).length === 0 && Array.isArray(post.artist)) {
    categories.artist = post.artist.filter((tag): tag is string => typeof tag === 'string');
  }
  const tags = unique(Object.values(categories).flat());

  const rawRating = pickString(post, 'rating');
  const sourcesRaw = post.source ?? post.sources;
  const sources = Array.isArray(sourcesRaw)
    ? unique(sourcesRaw.filter((value): value is string => typeof value === 'string' && !!value.trim()))
    : splitTags(typeof sourcesRaw === 'string' ? sourcesRaw : '');

  return {
    serverId: ctx.server.id,
    siteType: 'danbooru',
    id,
    postUrl: `${ctx.baseUrl}/posts/${id}`,
    fileUrl,
    previewUrl,
    sampleUrl,
    width: pickNumber(post, 'image_width', 'width'),
    height: pickNumber(post, 'image_height', 'height'),
    ext,
    sizeBytes: pickNumber(post, 'file_size'),
    rating: normalizeRating(rawRating),
    rawRating,
    tags,
    tagCategories: categories,
    artistTags: categories.artist ?? [],
    characterTags: categories.character ?? [],
    score: pickNumber(post, 'score'),
    md5: pickString(post, 'md5'),
    sources,
    createdAt: pickString(post, 'created_at'),
    isVideo: !!ext && ['webm', 'mp4'].includes(ext),
    isAnimated: pickBoolean(post, 'is_animated') ?? (!!ext && ['gif', 'webm', 'mp4', 'apng'].includes(ext)),
    parentId: pickString(post, 'parent_id'),
    hasChildren: pickBoolean(post, 'has_children') ?? false,
    description: pickString(post, 'description'),
  };
}

function deriveExt(post: Record<string, unknown>, fileUrl: string): string | null {
  const direct = pickString(post, 'file_ext');
  if (direct) return direct.toLowerCase();
  const match = /\.([a-z0-9]{1,5})(?:\?|$)/i.exec(fileUrl);
  return match?.[1]?.toLowerCase() ?? null;
}

function interpretAuthProbe(snapshot: HttpResponseSnapshot): ProbeInterpretation {
  const failure = classifyFailure(snapshot);
  if (failure) {
    return { ok: false, kind: failure.kind, message: failure.message, warnings: failure.hint ? [failure.hint] : [] };
  }
  let parsed: unknown;
  try {
    parsed = readJson(snapshot, 'Danbooru profile endpoint');
  } catch (error) {
    const booruError = error as BooruError;
    return { ok: false, kind: booruError.kind, message: booruError.message, warnings: booruError.hint ? [booruError.hint] : [] };
  }
  const profile = asRecord(parsed);
  if (!profile || pickString(profile, 'name') === null) {
    return {
      ok: false,
      kind: 'endpoint-mismatch',
      message: 'Authenticated request returned JSON, but not a Danbooru profile',
      warnings: ['Expected /profile.json to return an object with `name` and `id`.'],
    };
  }
  return {
    ok: true,
    kind: 'ok',
    message: `Signed in as ${pickString(profile, 'name')}`,
    account: accountInfo(pickString(profile, 'name'), pickString(profile, 'id'), pickString(profile, 'level_string', 'level')),
  };
}

/**
 * Danbooru adapter (also the base behaviour for Danbooru-compatible forks:
 * Safebooru, Testbooru, and self-hosted instances with the same API).
 *
 * - Auth: username + API key, sent as HTTP Basic (`login:api_key`); Danbooru
 *   documents query parameters as an equivalent alternative.
 * - Validation: `/profile.json` requires authentication, so it distinguishes
 *   "bad credentials" (401) from "wrong server" (HTML/404).
 * - Reference: https://danbooru.donmai.us/wiki_pages/help:api
 */
export const danbooruAdapter: BooruAdapter = {
  siteType: 'danbooru',
  displayName: 'Danbooru',
  hostPatterns: ['danbooru.donmai.us', '*.donmai.us', 'safebooru.donmai.us', 'testbooru.donmai.us'],
  siteRatingTokens: SITE_RATING_TOKENS,

  capabilities: {
    supportsAnonymousAccess: true,
    supportsRatingFilter: true,
    requiresUsername: true,
    requiresUserId: false,
    requiresApiKey: true,
    requiresUserAgent: false,
    authStyle: 'basic-or-query',
    supportsBasicAuthHeader: true,
    maxPostsPerRequest: 200,
    maxPage: 1000,
    minRequestIntervalMs: 1000,
    supportsPostLookup: true,
    supportsTagSearch: true,
    supportsIdPagination: true,
    apiDocsUrl: 'https://danbooru.donmai.us/wiki_pages/help:api',
    notes: [
      'Global read limit is 10 requests/second; Danbooru asks clients to stay near 1 request/second.',
      'Requests should identify the client with a User-Agent containing your user id.',
      'Anonymous reads work, but a key raises limits and is required for account-level checks.',
    ],
  },

  defaults: {
    baseUrl: DANBOORU_DEFAULT_BASE,
    label: 'Danbooru (main)',
    ratings: ['general', 'sensitive'],
    userAgentHint: `BooruServerManager/${DANBOORU_VERSION} (by user #<your danbooru user id>)`,
  },

  normalizeBaseUrl(raw: string): string {
    return raw.trim().replace(/\/+$/, '').replace(/\/(posts\.json|posts|post)\/?$/i, '');
  },

  matchesHost,

  matchRoute(url: string): RouteMatch | null {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (!matchesHost(parsed.host)) return null;
    const segments = parsed.pathname.split('/').filter(Boolean);
    const canonicalUrl = `${parsed.origin}${parsed.pathname}`;
    if (segments[0] === 'posts' && segments[1] && /^\d+$/.test(segments[1])) {
      return { siteType: 'danbooru', kind: 'post', postId: segments[1], tags: null, page: null, canonicalUrl };
    }
    if (segments[0] === 'posts') {
      const tags = parsed.searchParams.get('tags');
      const page = parsed.searchParams.get('page');
      return {
        siteType: 'danbooru',
        kind: tags ? 'search' : 'index',
        postId: null,
        tags,
        page: page && /^\d+$/.test(page) ? Number(page) : null,
        canonicalUrl,
      };
    }
    if (segments[0] === 'pools' && segments[1]) {
      return { siteType: 'danbooru', kind: 'pool', postId: null, tags: null, page: null, canonicalUrl };
    }
    if (segments[0] === 'wiki_pages' && segments[1]) {
      return { siteType: 'danbooru', kind: 'tag', postId: null, tags: decodeURIComponent(segments[1]), page: null, canonicalUrl };
    }
    return { siteType: 'danbooru', kind: 'index', postId: null, tags: null, page: null, canonicalUrl };
  },

  postUrl(baseUrl: string, postId: string): string {
    return `${baseUrl.replace(/\/+$/, '')}/posts/${postId}`;
  },

  buildSearchRequest(ctx, spec): HttpRequestSpec {
    const limit = Math.min(Math.max(spec.limit ?? 50, 1), this.capabilities.maxPostsPerRequest);
    const filters = this.ratingQueryTags(spec.ratingFilter?.allowed ?? []).tags;
    const tags = resolvedTags(ctx, spec, filters);
    const params = new URLSearchParams();
    if (tags) params.set('tags', tags);
    params.set('limit', String(limit));
    const page = spec.pageToken ?? (spec.page !== undefined && spec.page !== null ? String(spec.page) : null);
    if (page) params.set('page', page);
    if (spec.order) params.set('search[order]', spec.order);
    const bare: HttpRequestSpec = {
      url: `${ctx.baseUrl}/posts.json?${params.toString()}`,
      method: 'GET',
      headers: { Accept: 'application/json' },
      tag: 'danbooru',
      label: 'Search posts',
    };
    return withAuth(ctx, bare);
  },

  buildPostRequest(ctx, postId): HttpRequestSpec {
    return withAuth(ctx, {
      url: `${ctx.baseUrl}/posts/${encodeURIComponent(postId)}.json`,
      method: 'GET',
      headers: { Accept: 'application/json' },
      tag: 'danbooru',
      label: `Fetch post ${postId}`,
    });
  },

  buildValidationProbes(ctx): ValidationProbe[] {
    const endpointProbe: ValidationProbe = {
      id: 'danbooru-endpoint',
      label: 'Listing endpoint (anonymous)',
      purpose: 'endpoint',
      request: {
        url: `${ctx.baseUrl}/posts.json?limit=1`,
        method: 'GET',
        headers: { Accept: 'application/json' },
        tag: 'danbooru',
        label: 'Endpoint check',
      },
      interpret: (snapshot) => {
        const failure = classifyFailure(snapshot);
        if (failure) {
          return { ok: false, kind: failure.kind, message: failure.message, warnings: failure.hint ? [failure.hint] : [] };
        }
        let parsed: unknown;
        try {
          parsed = readJson(snapshot, 'Danbooru listing endpoint');
        } catch (error) {
          const booruError = error as BooruError;
          return { ok: false, kind: booruError.kind, message: booruError.message, warnings: booruError.hint ? [booruError.hint] : [] };
        }
        if (!Array.isArray(parsed)) {
          return {
            ok: false,
            kind: 'endpoint-mismatch',
            message: 'The endpoint answered with JSON, but not a Danbooru post listing',
            warnings: ['Expected a JSON array at /posts.json.'],
          };
        }
        return { ok: true, kind: 'ok', message: `Endpoint OK - received ${parsed.length} post(s) anonymously` };
      },
    };

    const authProbe: ValidationProbe = {
      id: 'danbooru-auth-profile',
      label: 'Authenticated request (profile)',
      purpose: 'auth',
      enabled: !!danbooruAuthHeader(ctx),
      request: withAuth(ctx, {
        url: `${ctx.baseUrl}/profile.json`,
        method: 'GET',
        headers: { Accept: 'application/json' },
        tag: 'danbooru',
        label: 'Credential check',
      }),
      interpret: (snapshot) => interpretAuthProbe(snapshot),
    };

    return [endpointProbe, authProbe];
  },

  parseSearchResponse(snapshot, spec, ctx): SearchResult {
    const failure = classifyFailure(snapshot);
    if (failure) throw new BooruError(failure.message, { kind: failure.kind, status: snapshot.status, hint: failure.hint ?? null });
    const parsed = readJson<unknown>(snapshot, 'Danbooru listing endpoint');
    const list = Array.isArray(parsed) ? parsed : asRecord(parsed)?.posts;
    if (!Array.isArray(list)) throw shapeError('Danbooru listing endpoint', 'expected a JSON array of posts');
    const limit = Math.min(Math.max(spec.limit ?? 50, 1), this.capabilities.maxPostsPerRequest);
    return {
      posts: list.map((raw) => normalizePost(raw, ctx)),
      page: spec.page ?? 1,
      limit,
      hasMore: list.length >= limit,
      totalCount: null,
      appliedTags: resolvedTags(ctx, spec, this.ratingQueryTags(spec.ratingFilter?.allowed ?? []).tags),
      requestUrl: snapshot.redactedUrl,
      siteType: 'danbooru',
      serverId: ctx.server.id,
    };
  },

  parsePostResponse(snapshot, postId, ctx): BooruPost {
    const failure = classifyFailure(snapshot);
    if (failure) throw new BooruError(failure.message, { kind: failure.kind, status: snapshot.status, hint: failure.hint ?? null });
    const parsed = readJson<unknown>(snapshot, `Danbooru post ${postId}`);
    const record = asRecord(parsed);
    const raw = record && asRecord(record.post) ? (record.post as Record<string, unknown>) : record;
    if (!raw) throw shapeError(`Danbooru post ${postId}`, 'expected a post object');
    return normalizePost(raw, ctx);
  },

  normalizePost,

  normalizeRating,

  canonicalRatingFor(siteToken: string): Rating | null {
    return CANONICAL_BY_TOKEN[siteToken.trim().toLowerCase()] ?? null;
  },

  ratingQueryTags(allowed: Rating[]) {
    return ratingExclusions(SITE_RATING_TOKENS, (token) => CANONICAL_BY_TOKEN[token] ?? null, allowed);
  },

  classifyFailure,

  credentialFields(): CredentialField[] {
    return [
      {
        key: 'username',
        label: 'Username',
        type: 'text',
        required: false,
        requiredForAuth: true,
        secret: false,
        placeholder: 'your_danbooru_username',
      },
      {
        key: 'apiKey',
        label: 'API key',
        type: 'password',
        required: false,
        requiredForAuth: true,
        secret: true,
        placeholder: 'from your profile page',
        help: 'Generate the key on your Danbooru profile page (Generate API key).',
      },
      {
        key: 'customUserAgent',
        label: 'User-Agent (recommended: include your user id)',
        type: 'text',
        required: false,
        requiredForAuth: false,
        secret: false,
        placeholder: `BooruServerManager/${DANBOORU_VERSION} (by user #123456)`,
        help: 'Danbooru asks clients to identify themselves with a UA containing your user id.',
      },
    ];
  },

  suggestUserAgent({ server }): string {
    const id = server.userId?.trim();
    const who = id ? `user #${id}` : server.username?.trim() || 'user #<your id>';
    return `BooruServerManager/${DANBOORU_VERSION} (by ${who})`;
  },
};

export { normalizePost as normalizeDanbooruPost };
