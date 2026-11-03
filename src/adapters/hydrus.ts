import type { AdapterContext, AdapterFailure, BooruAdapter, CredentialField, ProbeInterpretation, ValidationProbe } from '../core/adapter.js';
import { BooruError } from '../shared/errors.js';
import type { HttpResponseSnapshot, HttpRequestSpec } from '../shared/http.js';
import type { BooruPost, Rating, RouteMatch, SearchResult, SearchSpec } from '../shared/types.js';
import { asRecord, classifyStatus, pickBoolean, pickNumber, pickString, readJson, shapeError } from './base.js';
import { hostMatchesPattern, splitTags, stripHydrusCredentials, unique } from '../shared/util.js';

export const HYDRUS_VERSION = '0.1.0';
export const HYDRUS_DEFAULT_BASE = 'http://127.0.0.1:45869';
export const HYDRUS_KEY_PARAM = 'Hydrus-Client-API-Access-Key';

const HOST_PATTERNS = ['127.0.0.1', 'localhost'];

/** Hydrus has no rating concept; the shared rating filter is reported as unsupported. */
const SITE_RATING_TOKENS: readonly string[] = [];

/**
 * Hydrus tag search terms are comma separated (tags contain spaces). An empty
 * search means "everything", which Hydrus spells `system:everything`.
 */
export function composeHydrusTags(userQuery: string | undefined, globalSuffix: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (raw: string) => {
    const tag = raw.trim();
    if (!tag) return;
    const key = tag.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(tag);
  };
  for (const term of (userQuery ?? '').split(',')) push(term);
  for (const term of splitTags(globalSuffix)) push(term);
  return out.length ? out : ['system:everything'];
}

/** Hydrus IDs must be numeric and exactly representable by the JSON API. */
export function hydrusFileId(fileId: string): string {
  if (!/^\d+$/.test(fileId) || !Number.isSafeInteger(Number(fileId))) {
    throw new BooruError('Invalid Hydrus file ID.', { kind: 'parse-failure' });
  }
  return String(Number(fileId));
}

/** URLs are safe to show/store: authentication is carried separately. */
export function hydrusFileUrl(baseUrl: string, fileId: string, kind: 'file' | 'thumbnail'): string {
  const url = new URL(`${baseUrl.replace(/\/+$/, '')}/get_files/${kind}`);
  url.searchParams.set('file_id', hydrusFileId(fileId));
  return url.toString();
}

export function hydrusAuthHeaders(key: string): Record<string, string> {
  return key.trim() ? { [HYDRUS_KEY_PARAM]: key.trim() } : {};
}

function classifyFailure(snapshot: HttpResponseSnapshot): AdapterFailure | null {
  const status = snapshot.status;
  // Hydrus uses 419 for expired/invalid session keys and 403 for missing permissions.
  if (status === 419) {
    return { kind: 'auth-failure', message: 'Hydrus rejected the access key (HTTP 419)', hint: 'Re-create the key under services > review services > client api.' };
  }
  if (status === 403) {
    return {
      kind: 'auth-failure',
      message: 'Hydrus refused the request (HTTP 403) - the access key lacks a permission',
      hint: 'The key needs "search for and fetch files" permission. Edit it under services > manage services > client api.',
    };
  }
  if (status === 401) {
    return { kind: 'auth-failure', message: 'Hydrus needs an access key (HTTP 401)', hint: 'Paste the key from services > review services > client api.' };
  }
  return classifyStatus(snapshot, 'Hydrus');
}

/**
 * Hydrus `tags` metadata: `{ [service_key]: { display_tags: { "0": [tags…] } } }`
 * (status 0 = current). Older clients expose `service_keys_to_statuses_to_display_tags`.
 */
function extractTags(metadata: Record<string, unknown>): string[] {
  const collected: string[] = [];
  const perService = asRecord(metadata.tags) ?? asRecord(metadata.service_keys_to_statuses_to_display_tags);
  if (perService) {
    for (const service of Object.values(perService)) {
      const record = asRecord(service);
      if (!record) continue;
      const statuses = asRecord(record.display_tags) ?? record;
      const current = statuses['0'];
      if (Array.isArray(current)) collected.push(...current.filter((tag): tag is string => typeof tag === 'string'));
    }
  }
  return unique(collected);
}

/**
 * Lightweight post for a bare file id (what `search_files` gives us). The queue
 * refreshes each post through `buildPostRequest` before downloading, so the
 * missing extension/size/tags are filled in from `file_metadata` at that point.
 */
function lightweightPost(fileId: string, ctx: AdapterContext): BooruPost {
  return {
    serverId: ctx.server.id,
    siteType: ctx.server.siteType,
    id: fileId,
    postUrl: hydrusFileUrl(ctx.baseUrl, fileId, 'file'),
    fileUrl: hydrusFileUrl(ctx.baseUrl, fileId, 'file'),
    previewUrl: hydrusFileUrl(ctx.baseUrl, fileId, 'thumbnail'),
    sampleUrl: null,
    width: null,
    height: null,
    ext: null,
    sizeBytes: null,
    rating: 'unknown',
    rawRating: null,
    tags: [],
    tagCategories: {},
    artistTags: [],
    characterTags: [],
    score: null,
    md5: null,
    sources: [],
    createdAt: null,
    isVideo: false,
    isAnimated: false,
    parentId: null,
    hasChildren: false,
    description: null,
  };
}

function normalizePost(raw: unknown, ctx: AdapterContext): BooruPost {
  const metadata = asRecord(raw);
  if (!metadata) throw shapeError('Hydrus file metadata', 'entry was not an object');
  const fileId = pickString(metadata, 'file_id') ?? '';
  const ext = (pickString(metadata, 'ext') ?? '').replace(/^\./, '').toLowerCase() || null;
  const mime = pickString(metadata, 'mime') ?? '';
  const tags = extractTags(metadata);
  const categories: Record<string, string[]> = { general: [], artist: [], character: [], copyright: [], meta: [] };
  for (const tag of tags) {
    const colon = tag.indexOf(':');
    const namespace = colon > 0 ? tag.slice(0, colon) : '';
    const value = colon > 0 ? tag.slice(colon + 1) : tag;
    if (namespace === 'creator' || namespace === 'artist') categories.artist!.push(value);
    else if (namespace === 'character' || namespace === 'person') categories.character!.push(value);
    else if (namespace === 'series' || namespace === 'copyright' || namespace === 'studio') categories.copyright!.push(value);
    else if (namespace === 'system' || namespace === 'meta' || namespace === 'filename' || namespace === 'page') categories.meta!.push(tag);
    else categories.general!.push(tag);
  }
  const knownUrls = Array.isArray(metadata.known_urls)
    ? metadata.known_urls.filter((url): url is string => typeof url === 'string').map(stripHydrusCredentials)
    : [];
  const importedAt = pickNumber(metadata, 'time_imported');
  const duration = pickNumber(metadata, 'duration');
  const isVideo = mime.startsWith('video/');
  return {
    serverId: ctx.server.id,
    siteType: ctx.server.siteType,
    id: fileId,
    postUrl: hydrusFileUrl(ctx.baseUrl, fileId, 'file'),
    fileUrl: hydrusFileUrl(ctx.baseUrl, fileId, 'file'),
    previewUrl: hydrusFileUrl(ctx.baseUrl, fileId, 'thumbnail'),
    sampleUrl: null,
    width: pickNumber(metadata, 'width'),
    height: pickNumber(metadata, 'height'),
    ext,
    sizeBytes: pickNumber(metadata, 'size'),
    rating: 'unknown',
    rawRating: null,
    tags,
    tagCategories: categories,
    artistTags: categories.artist ?? [],
    characterTags: categories.character ?? [],
    score: null,
    // Hydrus identifies files by SHA-256; the `{md5}` template token stays empty.
    md5: null,
    sources: unique(knownUrls),
    createdAt: importedAt ? new Date(importedAt * 1000).toISOString() : null,
    isVideo,
    isAnimated: isVideo || (duration !== null && duration > 0) || (pickBoolean(metadata, 'has_audio') ?? false) || ext === 'gif',
    parentId: null,
    hasChildren: false,
    description: pickString(metadata, 'hash'),
  };
}

function interpretVersionProbe(snapshot: HttpResponseSnapshot): ProbeInterpretation {
  const failure = classifyFailure(snapshot);
  if (failure) return { ok: false, kind: failure.kind, message: failure.message, warnings: failure.hint ? [failure.hint] : [] };
  let parsed: unknown;
  try {
    parsed = readJson(snapshot, 'Hydrus /api_version');
  } catch (error) {
    const booruError = error as BooruError;
    return { ok: false, kind: booruError.kind, message: booruError.message, warnings: ['Is the Client API enabled under services > manage services?'] };
  }
  const record = asRecord(parsed);
  const version = record ? pickNumber(record, 'version') : null;
  if (version === null) {
    return { ok: false, kind: 'endpoint-mismatch', message: 'The URL answered, but not like a Hydrus Client API', warnings: ['Expected `{"version": N, "hydrus_version": M}` at /api_version.'] };
  }
  return { ok: true, kind: 'ok', message: `Hydrus Client API v${version} (client ${pickNumber(record, 'hydrus_version') ?? '?'})` };
}

function interpretKeyProbe(snapshot: HttpResponseSnapshot): ProbeInterpretation {
  const failure = classifyFailure(snapshot);
  if (failure) return { ok: false, kind: failure.kind, message: failure.message, warnings: failure.hint ? [failure.hint] : [] };
  let parsed: unknown;
  try {
    parsed = readJson(snapshot, 'Hydrus /verify_access_key');
  } catch (error) {
    const booruError = error as BooruError;
    return { ok: false, kind: booruError.kind, message: booruError.message };
  }
  const record = asRecord(parsed);
  const permissions = Array.isArray(record?.basic_permissions) ? (record!.basic_permissions as unknown[]) : [];
  // Permission 3 = "search for and fetch files".
  const canSearch = permissions.includes(3) || pickBoolean(record, 'permits_everything') === true;
  return {
    ok: canSearch,
    kind: canSearch ? 'ok' : 'auth-failure',
    message: canSearch
      ? `Access key accepted: ${pickString(record, 'human_description') ?? 'permissions verified'}`
      : 'Access key is valid but lacks the "search for and fetch files" permission',
    warnings: canSearch ? [] : ['Edit the key under services > manage services > client api and enable file search.'],
    account: { username: pickString(record, 'human_description'), userId: null, level: null },
  };
}

/**
 * Hydrus Network Client API adapter (a *local* booru: your own client).
 *
 * - Base URL is the client's API address, `http://127.0.0.1:45869` by default.
 * - Auth: a `Hydrus-Client-API-Access-Key` header; URLs contain no key.
 *   Metadata/thumbnail fetches reject redirects. Chrome downloads can follow
 *   redirects, so header privacy on that path still requires browser testing.
 * - Listing: `/get_files/search_files` returns *every* matching file id; the
 *   adapter pages through that list locally, and the queue fetches
 *   `/get_files/file_metadata` per file before downloading.
 * - Reference: https://hydrusnetwork.github.io/hydrus/developer_api.html
 */
export const hydrusAdapter: BooruAdapter = {
  siteType: 'hydrus',
  displayName: 'Hydrus (Client API)',
  hostPatterns: HOST_PATTERNS,
  siteRatingTokens: SITE_RATING_TOKENS,

  capabilities: {
    supportsAnonymousAccess: false,
    supportsRatingFilter: false,
    requiresUsername: false,
    requiresUserId: false,
    requiresApiKey: true,
    requiresUserAgent: false,
    authStyle: 'header',
    supportsBasicAuthHeader: false,
    maxPostsPerRequest: 100,
    maxPage: null,
    minRequestIntervalMs: 0,
    supportsPostLookup: true,
    supportsTagSearch: true,
    supportsIdPagination: false,
    apiDocsUrl: 'https://hydrusnetwork.github.io/hydrus/developer_api.html',
    notes: [
      'Security: Hydrus keys use headers, but Chrome download redirects and browser storage of headers have not been verified. Use a trusted direct endpoint and a restricted key.',
      'Older versions put keys in URLs and browser history. Rotate an exposed key and remove old Chrome download records.',
      'Talks to your own Hydrus client: enable the Client API under services > manage services and create an access key with "search for and fetch files".',
      'Base URL is plain http on localhost; the extension asks for optional host access to it once.',
      'Search terms are comma separated Hydrus tags (namespaces allowed, `-tag` excludes, `system:` predicates work). Empty = system:everything.',
      'Hydrus has no ratings, so the rating filter does nothing here.',
    ],
  },

  defaults: {
    baseUrl: HYDRUS_DEFAULT_BASE,
    label: 'Hydrus (local client)',
    ratings: ['general', 'safe', 'sensitive', 'questionable', 'explicit'],
    userAgentHint: `BooruServerManager/${HYDRUS_VERSION}`,
  },

  normalizeBaseUrl(raw: string): string {
    const trimmed = raw.trim().replace(/\/+$/, '');
    const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
    return withScheme.replace(/\/(api_version|get_files.*|verify_access_key)$/i, '');
  },

  matchesHost(host: string): boolean {
    return HOST_PATTERNS.some((pattern) => hostMatchesPattern(host, pattern));
  },

  matchRoute(url: string): RouteMatch | null {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (!this.matchesHost(parsed.host)) return null;
    const canonicalUrl = `${parsed.origin}${parsed.pathname}`;
    const fileId = parsed.searchParams.get('file_id');
    if (/\/get_files\/(file|thumbnail)$/.test(parsed.pathname) && fileId && /^\d+$/.test(fileId)) {
      return { siteType: 'hydrus', kind: 'post', postId: fileId, tags: null, page: null, canonicalUrl };
    }
    return null;
  },

  postUrl(baseUrl: string, postId: string): string {
    return hydrusFileUrl(baseUrl, postId, 'file');
  },

  buildSearchRequest(ctx, spec): HttpRequestSpec {
    const url = new URL(`${ctx.baseUrl}/get_files/search_files`);
    url.searchParams.set('tags', JSON.stringify(composeHydrusTags(spec.tags, ctx.settings.globalTagSuffix)));
    // Sort by import time, newest first, so paging is stable-ish between requests.
    url.searchParams.set('file_sort_type', '2');
    url.searchParams.set('file_sort_asc', 'false');
    url.searchParams.set('return_file_ids', 'true');
    return { url: url.toString(), method: 'GET', headers: { Accept: 'application/json', ...hydrusAuthHeaders(ctx.server.apiKey) }, redirect: 'error', tag: 'hydrus', label: 'Search files' };
  },

  buildPostRequest(ctx, postId): HttpRequestSpec {
    const url = new URL(`${ctx.baseUrl}/get_files/file_metadata`);
    url.searchParams.set('file_ids', JSON.stringify([Number(hydrusFileId(postId))]));
    return { url: url.toString(), method: 'GET', headers: { Accept: 'application/json', ...hydrusAuthHeaders(ctx.server.apiKey) }, redirect: 'error', tag: 'hydrus', label: `Fetch file ${postId} metadata` };
  },

  buildValidationProbes(ctx): ValidationProbe[] {
    const hasKey = !!ctx.server.apiKey.trim();
    return [
      {
        id: 'hydrus-endpoint',
        label: 'Client API version',
        purpose: 'endpoint',
        request: { url: `${ctx.baseUrl}/api_version`, method: 'GET', headers: { Accept: 'application/json' }, tag: 'hydrus', label: 'Endpoint check' },
        interpret: interpretVersionProbe,
      },
      {
        id: 'hydrus-auth',
        label: 'Access key permissions',
        purpose: 'auth',
        enabled: hasKey,
        request: {
          url: new URL(`${ctx.baseUrl}/verify_access_key`).toString(),
          method: 'GET',
          headers: { Accept: 'application/json', ...hydrusAuthHeaders(ctx.server.apiKey) },
          redirect: 'error',
          tag: 'hydrus',
          label: 'Credential check',
        },
        interpret: interpretKeyProbe,
      },
    ];
  },

  parseSearchResponse(snapshot, spec, ctx): SearchResult {
    const failure = classifyFailure(snapshot);
    if (failure) throw new BooruError(failure.message, { kind: failure.kind, status: snapshot.status, hint: failure.hint ?? null });
    const parsed = readJson<unknown>(snapshot, 'Hydrus search_files');
    const record = asRecord(parsed);
    const ids = record && Array.isArray(record.file_ids) ? record.file_ids : null;
    if (!ids) throw shapeError('Hydrus search_files', 'expected `{"file_ids": […]}`');
    const limit = Math.min(Math.max(spec.limit ?? 100, 1), this.capabilities.maxPostsPerRequest);
    const page = Math.max(spec.page ?? 1, 1);
    const start = (page - 1) * limit;
    const slice = ids.slice(start, start + limit).map((id) => String(id));
    return {
      posts: slice.map((id) => lightweightPost(id, ctx)),
      page,
      limit,
      hasMore: start + slice.length < ids.length,
      totalCount: ids.length,
      appliedTags: composeHydrusTags(spec.tags, ctx.settings.globalTagSuffix).join(', '),
      requestUrl: snapshot.redactedUrl,
      siteType: 'hydrus',
      serverId: ctx.server.id,
    };
  },

  parsePostResponse(snapshot, postId, ctx): BooruPost {
    const failure = classifyFailure(snapshot);
    if (failure) throw new BooruError(failure.message, { kind: failure.kind, status: snapshot.status, hint: failure.hint ?? null });
    const parsed = readJson<unknown>(snapshot, `Hydrus file ${postId}`);
    const record = asRecord(parsed);
    const list = record && Array.isArray(record.metadata) ? record.metadata : [];
    const requestedId = hydrusFileId(postId);
    const entry = list.find((item) => pickString(asRecord(item), 'file_id') === requestedId);
    if (!entry) throw new BooruError(`Hydrus has no file ${postId}`, { kind: 'parse-failure', status: snapshot.status });
    return normalizePost(entry, ctx);
  },

  normalizePost,

  normalizeRating(): Rating {
    return 'unknown';
  },

  canonicalRatingFor(): Rating | null {
    return null;
  },

  ratingQueryTags() {
    return { tags: [], warnings: ['Hydrus has no rating system; the rating filter is ignored for this server.'] };
  },

  classifyFailure,

  credentialFields(): CredentialField[] {
    return [
      {
        key: 'apiKey',
        label: 'Client API access key',
        type: 'password',
        required: true,
        requiredForAuth: true,
        secret: true,
        placeholder: '64 hex characters from services > review services > client api',
        help: 'Needs "search for and fetch files". Use a restricted key and a trusted direct endpoint; Chrome download redirects and header storage have not been verified. Rotate keys exposed by older versions.',
      },
    ];
  },

  suggestUserAgent(): string {
    return `BooruServerManager/${HYDRUS_VERSION}`;
  },
};
