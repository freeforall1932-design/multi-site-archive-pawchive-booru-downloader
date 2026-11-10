import type { AdapterContext, AdapterFailure, BooruAdapter, CredentialField, ProbeInterpretation, ValidationProbe } from '../core/adapter.js';
import { BooruError } from '../shared/errors.js';
import type { HttpResponseSnapshot, HttpRequestSpec } from '../shared/http.js';
import type { BooruPost, Rating, RouteMatch, SearchResult, SearchSpec, SiteType } from '../shared/types.js';
import { asRecord, classifyStatus, pickString, readJson, shapeError } from './base.js';
import { hostMatchesPattern, safeUrl, unique } from '../shared/util.js';

export const PAWCHIVE_VERSION = '0.2.0';
const PAWCHIVE_USER_AGENT = `BooruServerManager/${PAWCHIVE_VERSION} (+https://github.com/freeforall1932-design/multi-site-archive-pawchive-booru-downloader)`;
/** Pawchive's API pages by 50 posts. */
export const PAWCHIVE_PAGE_SIZE = 50;

const SITE_RATING_TOKENS: readonly string[] = [];
const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp'];
const VIDEO_EXTS = ['mp4', 'webm', 'mov', 'mkv', 'm4v'];
const PAWCHIVE_DOMAINS = ['pawchive.pw', 'pawchive.st'];

interface PawchiveOptions {
  siteType: SiteType;
  displayName: string;
  baseUrl: string;
  label: string;
  hostPatterns: string[];
  notes?: string[];
  fileHost: (baseUrl: string, node: number | null) => string;
  thumbnailHost: (baseUrl: string) => string;
}

/** Only official Pawchive domains, including the site's former domain. */
export function isPawchiveHost(hostname: string, includeSubdomains = false): boolean {
  const host = hostname.toLowerCase();
  return PAWCHIVE_DOMAINS.some((domain) => host === domain || (includeSubdomains && host.endsWith(`.${domain}`)));
}

/** A Pawchive profile must not be used as a generic archive-site adapter. */
export function normalizePawchiveBaseUrl(raw: string): string {
  const value = raw.trim();
  const parsed = safeUrl(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`);
  const host = parsed?.hostname.replace(/^www\./, '') ?? '';
  if (!parsed || parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || !isPawchiveHost(host)) {
    throw new BooruError('Pawchive profiles require an official Pawchive HTTPS URL', {
      kind: 'unsupported-site',
      hint: 'Use https://pawchive.pw (or the previous pawchive.st domain). Booru profiles are configured separately.',
    });
  }
  return `https://${host}`;
}

/** A row is addressed by service, creator, post and optionally file index. */
export interface PawchivePostRef {
  service: string;
  user: string;
  post: string;
  index: number | null;
}

export function parsePawchivePostId(postId: string): PawchivePostRef | null {
  const parts = postId.split('/').filter(Boolean);
  if (parts.length < 3 || parts.length > 4) return null;
  const [service, user, post, index] = parts;
  if (!service || !user || !post || (index !== undefined && !/^\d+$/.test(index))) return null;
  return { service, user, post, index: index === undefined ? null : Number(index) };
}

export function formatPawchivePostId(ref: PawchivePostRef): string {
  return `${ref.service}/${ref.user}/${ref.post}${ref.index === null ? '' : `/${ref.index}`}`;
}

/** A creator URL or service/id, a `tag:name`, or a title query. */
export function parsePawchiveQuery(raw: string | undefined): { kind: 'creator'; service: string; user: string } | { kind: 'tag'; tag: string } | { kind: 'text'; q: string } {
  const text = (raw ?? '').trim();
  let path = text;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    const url = safeUrl(text);
    const host = url?.hostname.replace(/^www\./, '') ?? '';
    if (!url || url.protocol !== 'https:' || url.port || url.username || url.password || !isPawchiveHost(host)) {
      throw new BooruError('Only Pawchive creator URLs are supported', { kind: 'unsupported-site', hint: 'Paste a Pawchive creator URL or use service/creatorId.' });
    }
    path = url.pathname;
  }
  const creatorUrl = /^\/?([a-z0-9_-]+)\/user\/([^/?#\s]+)/i.exec(path);
  if (creatorUrl) return { kind: 'creator', service: creatorUrl[1]!.toLowerCase(), user: creatorUrl[2]! };
  const creatorShort = /^([a-z0-9_-]+)\/([^/\s]+)$/i.exec(text);
  if (creatorShort) return { kind: 'creator', service: creatorShort[1]!.toLowerCase(), user: creatorShort[2]! };
  const tag = /^tag:(.+)$/i.exec(text);
  if (tag) return { kind: 'tag', tag: tag[1]!.trim() };
  return { kind: 'text', q: text };
}

function classifyFailure(snapshot: HttpResponseSnapshot, displayName: string): AdapterFailure | null {
  return classifyStatus(snapshot, displayName);
}

function fileUrlFor(host: string, path: string, name: string | null): string {
  const cleanPath = path.replace(/^\/+/, '').replace(/^data\//, '');
  const url = new URL(`${host.replace(/\/+$/, '')}/data/${cleanPath}`);
  if (name) url.searchParams.set('f', name);
  return url.toString();
}

function thumbnailFor(host: string, path: string): string {
  const cleanPath = path.replace(/^\/+/, '').replace(/^(?:thumbnail\/)?data\//, '');
  return `${host.replace(/\/+$/, '')}/thumbnail/data/${cleanPath}`;
}

function extOf(name: string | null, path: string | null): string | null {
  const source = name && /\.[a-z0-9]{1,5}$/i.test(name) ? name : path ?? '';
  const match = /\.([a-z0-9]{1,5})$/i.exec(source);
  return match?.[1]?.toLowerCase() ?? null;
}

interface PawchiveFile {
  name: string | null;
  path: string | null;
  node: number | null;
  previewOnly: boolean;
  deferred: boolean;
  tempUrl: string | null;
  tempExpires: string | null;
}

interface PawchiveHosts {
  fileHost: (baseUrl: string, node: number | null) => string;
  thumbnailHost: (baseUrl: string) => string;
}

const DEFAULT_HOSTS: PawchiveHosts = {
  fileHost: (baseUrl) => `https://file.${new URL(baseUrl).hostname.replace(/^www\./, '')}`,
  thumbnailHost: (baseUrl) => `https://img.${new URL(baseUrl).hostname.replace(/^www\./, '')}`,
};

/** Keep unavailable entries in the index so listing and post lookup agree. */
function collectFiles(post: Record<string, unknown>, extraAttachments: unknown[] = []): PawchiveFile[] {
  const seen = new Map<string, number>();
  const out: PawchiveFile[] = [];
  const push = (raw: unknown) => {
    const record = asRecord(raw);
    if (!record) return;
    const path = pickString(record, 'path');
    const tempUrl = pickString(record, 'temp_url');
    const name = pickString(record, 'name');
    if (!path && !tempUrl && !name) return;
    const nodeRaw = record.node;
    const file: PawchiveFile = {
      name, path, tempUrl,
      node: typeof nodeRaw === 'number' && Number.isFinite(nodeRaw) ? nodeRaw : null,
      previewOnly: record.preview_only === true,
      deferred: record.deferred === true,
      tempExpires: pickString(record, 'temp_expires'),
    };
    const key = path ? `path:${path}` : tempUrl ? `url:${tempUrl}` : null;
    const existing = key ? seen.get(key) : undefined;
    if (existing !== undefined) {
      const previous = out[existing]!;
      const useIncomingTemp = !usableTempUrl(previous) && !!usableTempUrl(file);
      out[existing] = {
        ...previous,
        name: previous.name ?? file.name,
        tempUrl: useIncomingTemp ? file.tempUrl : previous.tempUrl ?? file.tempUrl,
        tempExpires: useIncomingTemp || !previous.tempUrl ? file.tempExpires : previous.tempExpires,
        previewOnly: previous.previewOnly || file.previewOnly,
        deferred: previous.deferred && file.deferred,
      };
      return;
    }
    if (key) seen.set(key, out.length);
    out.push(file);
  };
  push(post.file);
  for (const attachment of Array.isArray(post.attachments) ? post.attachments : []) push(attachment);
  for (const attachment of extraAttachments) push(attachment);
  return out;
}

/** Signed URLs are bearer links: accept only HTTPS on Pawchive, never mutate their query. */
function usableTempUrl(file: PawchiveFile): string | null {
  if (!file.tempUrl) return null;
  const url = safeUrl(file.tempUrl);
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.port || !isPawchiveHost(url.hostname, true)) return null;
  if (file.tempExpires) {
    // Pawchive may omit a timezone; interpret those timestamps as UTC.
    const timestamp = /(?:z|[+-]\d\d:?\d\d)$/i.test(file.tempExpires) ? file.tempExpires : `${file.tempExpires}Z`;
    const expires = Date.parse(timestamp);
    if (Number.isFinite(expires) && expires <= Date.now()) return null;
  }
  return file.tempUrl;
}

function buildPost(post: Record<string, unknown>, file: PawchiveFile, index: number, ctx: AdapterContext, hosts: PawchiveHosts): BooruPost | null {
  if (file.deferred) return null;
  const signed = usableTempUrl(file);
  if (!signed && !file.path) return null;
  const service = pickString(post, 'service') ?? 'unknown';
  const user = pickString(post, 'user') ?? '';
  const postId = pickString(post, 'id') ?? '';
  const originalExt = extOf(file.name, file.path ?? safeUrl(signed ?? '')?.pathname ?? null);
  const tagsRaw = post.tags;
  const tags = Array.isArray(tagsRaw)
    ? unique(tagsRaw.filter((tag): tag is string => typeof tag === 'string' && !!tag.trim()))
    : typeof tagsRaw === 'string'
      ? unique(tagsRaw.replace(/^\{|\}$/g, '').split(',').map((tag) => tag.trim()).filter(Boolean))
      : [];
  const thumbnail = file.path ? thumbnailFor(hosts.thumbnailHost(ctx.baseUrl), file.path) : null;
  // Never expose a known preview as a downloadable original, even if a signed
  // URL is present. Keep a row so the user can see that the original is missing.
  const degraded = file.previewOnly || post.has_full === false;
  const fileUrl = degraded ? '' : signed ?? fileUrlFor(hosts.fileHost(ctx.baseUrl, file.node), file.path!, file.name);
  const ext = originalExt;
  const hash = file.path ? /\/([a-f0-9]{64})\.[a-z0-9]+$/i.exec(file.path)?.[1] ?? null : null;
  const title = pickString(post, 'title');
  return {
    serverId: ctx.server.id,
    siteType: ctx.server.siteType,
    id: formatPawchivePostId({ service, user, post: postId, index }),
    postUrl: `${ctx.baseUrl}/${service}/user/${user}/post/${postId}`,
    fileUrl,
    // Never make an <img> request for a full archive, video, or signed file.
    previewUrl: thumbnail && (degraded || (originalExt && IMAGE_EXTS.includes(originalExt))) ? thumbnail : '',
    sampleUrl: null,
    width: null,
    height: null,
    ext,
    sizeBytes: null,
    rating: 'unknown',
    rawRating: null,
    tags,
    tagCategories: { general: tags, artist: [user], copyright: [service] },
    artistTags: [user],
    characterTags: [],
    score: null,
    md5: hash,
    sources: [],
    createdAt: pickString(post, 'published', 'added'),
    isVideo: !!ext && VIDEO_EXTS.includes(ext),
    isAnimated: !!ext && (ext === 'gif' || VIDEO_EXTS.includes(ext)),
    parentId: postId,
    hasChildren: false,
    description: degraded || file.previewOnly ? `${title ?? ''} [preview only]`.trim() : title,
    fileAvailability: degraded || file.previewOnly ? 'preview' : signed ? 'temporary' : 'full',
  };
}

/** Expand attachment slots from either the classic or wrapped single-post API. */
export function inspectPawchivePost(raw: unknown, ctx: AdapterContext, hosts: PawchiveHosts = DEFAULT_HOSTS): { posts: BooruPost[]; unavailable: number } {
  const record = asRecord(raw);
  const wrapped = record && asRecord(record.post);
  const post = wrapped ?? record;
  if (!post) return { posts: [], unavailable: 0 };
  const extra = wrapped && Array.isArray(record?.attachments) ? record.attachments : [];
  const files = collectFiles(post, extra);
  const posts: BooruPost[] = [];
  for (const [index, file] of files.entries()) {
    const normalized = buildPost(post, file, index, ctx, hosts);
    if (normalized) posts.push(normalized);
  }
  return { posts, unavailable: files.length - posts.length };
}

/** Expand visible files while keeping their original stable indices. */
export function expandPawchivePost(raw: unknown, ctx: AdapterContext, hosts: PawchiveHosts = DEFAULT_HOSTS): BooruPost[] {
  return inspectPawchivePost(raw, ctx, hosts).posts;
}

/** References include text-only/deferred posts, which can still contain mirror links. */
function sourcePostRef(raw: unknown, ctx: AdapterContext): Array<{ id: string; label: string; postUrl: string }> {
  const record = asRecord(raw);
  const post = (record && asRecord(record.post)) ?? record;
  const service = pickString(post, 'service');
  const user = pickString(post, 'user');
  const postId = pickString(post, 'id');
  if (!service || !user || !postId) return [];
  const id = formatPawchivePostId({ service, user, post: postId, index: null });
  return [{ id, label: pickString(post, 'title') ?? `#${id}`, postUrl: `${ctx.baseUrl}/${service}/user/${user}/post/${postId}` }];
}

function postList(raw: unknown): unknown[] | null {
  if (Array.isArray(raw)) return raw;
  const record = asRecord(raw);
  for (const key of ['posts', 'data', 'results']) {
    if (Array.isArray(record?.[key])) return record[key] as unknown[];
  }
  return null;
}

function interpretEndpointProbe(snapshot: HttpResponseSnapshot, displayName: string): ProbeInterpretation {
  const failure = classifyFailure(snapshot, displayName);
  if (failure) return { ok: false, kind: failure.kind, message: failure.message, warnings: failure.hint ? [failure.hint] : [] };
  let parsed: unknown;
  try {
    parsed = readJson(snapshot, `${displayName} posts endpoint`);
  } catch (error) {
    const booruError = error as BooruError;
    return { ok: false, kind: booruError.kind, message: booruError.message, warnings: booruError.hint ? [booruError.hint] : [] };
  }
  const list = postList(parsed);
  if (!list) {
    return { ok: false, kind: 'endpoint-mismatch', message: `${displayName} answered with JSON, but not a posts listing`, warnings: ['Expected `{"count": N, "posts": […]}` at /api/v1/posts.'] };
  }
  return { ok: true, kind: 'ok', message: `Endpoint OK - /api/v1/posts responded with ${list.length} post(s)` };
}

/** Pawchive's public creator archive API, independent of the booru adapters. */
function createPawchiveAdapter(options: PawchiveOptions): BooruAdapter {
  const displayName = options.displayName;
  const matchesHost = (host: string): boolean => options.hostPatterns.some((pattern) => hostMatchesPattern(host, pattern));
  const hosts: PawchiveHosts = {
    fileHost: options.fileHost ?? DEFAULT_HOSTS.fileHost,
    thumbnailHost: options.thumbnailHost ?? DEFAULT_HOSTS.thumbnailHost,
  };

  const adapter: BooruAdapter = {
    siteType: options.siteType,
    displayName,
    hostPatterns: options.hostPatterns,
    siteRatingTokens: SITE_RATING_TOKENS,

    capabilities: {
      supportsAnonymousAccess: true,
      supportsRatingFilter: false,
      requiresUsername: false,
      requiresUserId: false,
      requiresApiKey: false,
      requiresUserAgent: false,
      authStyle: 'query',
      supportsBasicAuthHeader: false,
      maxPostsPerRequest: PAWCHIVE_PAGE_SIZE,
      maxPage: null,
      minRequestIntervalMs: 1500,
      supportsPostLookup: true,
      supportsTagSearch: true,
      supportsIdPagination: false,
      apiDocsUrl: `${options.baseUrl}/documentation/api`,
      notes: [
        'Creator archive, not a tag booru: type `service/creatorId` (or paste a creator URL) to list a creator, `tag:name` for a tag, anything else is a title search.',
        'Every attachment of a post becomes one row; ids look like service/creator/post/index.',
        'No login and no ratings; the rating filter does nothing here. Please keep the request interval generous - the site is volunteer-run.',
        'The md5 column shows the SHA-256 storage hash the site uses.',
        ...(options.notes ?? []),
      ],
    },

    defaults: {
      baseUrl: options.baseUrl,
      label: options.label,
      ratings: ['general', 'safe', 'sensitive', 'questionable', 'explicit'],
      userAgentHint: PAWCHIVE_USER_AGENT,
    },

    normalizeBaseUrl(raw: string): string {
      return normalizePawchiveBaseUrl(raw);
    },

    matchesHost,

    matchRoute(url: string): RouteMatch | null {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return null;
      }
      if (parsed.protocol !== 'https:' || parsed.port || !matchesHost(parsed.host)) return null;
      const segments = parsed.pathname.split('/').filter(Boolean);
      const canonicalUrl = `${parsed.origin}${parsed.pathname}`;
      if (segments[1] === 'user' && segments[2] && segments[3] === 'post' && segments[4]) {
        return {
          siteType: options.siteType,
          kind: 'post',
          postId: formatPawchivePostId({ service: segments[0]!, user: segments[2], post: segments[4], index: null }),
          tags: null,
          page: null,
          canonicalUrl,
        };
      }
      if (segments[1] === 'user' && segments[2]) {
        const offset = parsed.searchParams.get('o');
        return {
          siteType: options.siteType,
          kind: 'search',
          postId: null,
          tags: `${segments[0]}/${segments[2]}`,
          page: offset && /^\d+$/.test(offset) ? Math.floor(Number(offset) / PAWCHIVE_PAGE_SIZE) + 1 : null,
          canonicalUrl,
        };
      }
      if (segments[0] === 'posts') {
        const q = parsed.searchParams.get('q');
        const tag = parsed.searchParams.get('tag');
        return { siteType: options.siteType, kind: q || tag ? 'search' : 'index', postId: null, tags: tag ? `tag:${tag}` : q, page: null, canonicalUrl };
      }
      return { siteType: options.siteType, kind: 'index', postId: null, tags: null, page: null, canonicalUrl };
    },

    postUrl(baseUrl: string, postId: string): string {
      const ref = parsePawchivePostId(postId);
      if (!ref) return `${baseUrl.replace(/\/+$/, '')}/posts`;
      return `${baseUrl.replace(/\/+$/, '')}/${ref.service}/user/${ref.user}/post/${ref.post}`;
    },

    buildSearchRequest(ctx, spec): HttpRequestSpec {
      const page = Math.max(spec.page ?? 1, 1);
      const offset = (page - 1) * PAWCHIVE_PAGE_SIZE;
      const query = parsePawchiveQuery(spec.tags);
      let url: URL;
      if (query.kind === 'creator') {
        url = new URL(`${ctx.baseUrl}/api/v1/${encodeURIComponent(query.service)}/user/${encodeURIComponent(query.user)}/posts`);
      } else {
        url = new URL(`${ctx.baseUrl}/api/v1/posts`);
        if (query.kind === 'tag') url.searchParams.set('tag', query.tag);
        else if (query.q) url.searchParams.set('q', query.q);
      }
      url.searchParams.set('o', String(offset));
      return { url: url.toString(), method: 'GET', headers: { Accept: 'application/json' }, tag: options.siteType, label: 'List posts' };
    },

    buildPostRequest(ctx, postId): HttpRequestSpec {
      const ref = parsePawchivePostId(postId);
      if (!ref) {
        throw new BooruError(`"${postId}" is not a ${displayName} post id`, {
          kind: 'parse-failure',
          hint: 'Pawchive ids look like service/creatorId/postId (optionally /attachmentIndex).',
        });
      }
      return {
        url: `${ctx.baseUrl}/api/v1/${encodeURIComponent(ref.service)}/user/${encodeURIComponent(ref.user)}/post/${encodeURIComponent(ref.post)}`,
        method: 'GET',
        headers: { Accept: 'application/json' },
        tag: options.siteType,
        label: `Fetch post ${ref.post}`,
      };
    },

    buildValidationProbes(ctx): ValidationProbe[] {
      return [
        {
          id: `${options.siteType}-endpoint`,
          label: 'Recent posts endpoint',
          purpose: 'endpoint',
          request: { url: `${ctx.baseUrl}/api/v1/posts?o=0`, method: 'GET', headers: { Accept: 'application/json' }, tag: options.siteType, label: 'Endpoint check' },
          interpret: (snapshot) => interpretEndpointProbe(snapshot, displayName),
        },
      ];
    },

    parseSearchResponse(snapshot, spec, ctx): SearchResult {
      const failure = classifyFailure(snapshot, displayName);
      if (failure) throw new BooruError(failure.message, { kind: failure.kind, status: snapshot.status, hint: failure.hint ?? null });
      const parsed = readJson<unknown>(snapshot, `${displayName} posts endpoint`);
      const record = Array.isArray(parsed) ? null : asRecord(parsed);
      const list = postList(parsed);
      if (!list) throw shapeError(`${displayName} posts endpoint`, 'expected a post array or an object with `posts`, `data` or `results`');
      const page = Math.max(spec.page ?? 1, 1);
      const count = record ? (typeof record.count === 'number' ? record.count : null) : null;
      const offset = (page - 1) * PAWCHIVE_PAGE_SIZE;
      return {
        posts: list.flatMap((raw) => expandPawchivePost(raw, ctx, hosts)),
        sourcePosts: list.flatMap((raw) => sourcePostRef(raw, ctx)),
        page,
        limit: PAWCHIVE_PAGE_SIZE,
        hasMore: count !== null ? offset + list.length < count : list.length >= PAWCHIVE_PAGE_SIZE,
        totalCount: count,
        appliedTags: (spec.tags ?? '').trim(),
        requestUrl: snapshot.redactedUrl,
        siteType: options.siteType,
        serverId: ctx.server.id,
      };
    },

    parsePostResponse(snapshot, postId, ctx): BooruPost {
      const failure = classifyFailure(snapshot, displayName);
      if (failure) throw new BooruError(failure.message, { kind: failure.kind, status: snapshot.status, hint: failure.hint ?? null });
      const ref = parsePawchivePostId(postId);
      const parsed = readJson<unknown>(snapshot, `${displayName} post ${postId}`);
      const record = asRecord(parsed);
      // New API: `{post: {...}, attachments: [...], previews: [...]}`; old API: the post itself.
      const post = (record && asRecord(record.post)) ?? record;
      if (!post) throw shapeError(`${displayName} post ${postId}`, 'expected a post object');
      const extra = record && Array.isArray(record.attachments) ? record.attachments : [];
      const files = collectFiles(post, extra);
      const index = ref?.index ?? 0;
      const file = files[index];
      if (!file) {
        throw new BooruError(`${displayName} post ${ref?.post ?? postId} has no file #${index}`, {
          kind: 'parse-failure',
          status: snapshot.status,
          hint: files.length ? `The post has ${files.length} file(s).` : 'The post has no downloadable attachments.',
        });
      }
      const normalized = buildPost(post, file, index, ctx, hosts);
      if (!normalized) {
        throw new BooruError(`Pawchive file #${index} is not available yet`, {
          kind: 'parse-failure',
          status: snapshot.status,
          hint: 'This file is deferred, has no usable temporary link or has not been imported. Try again later.',
        });
      }
      return normalized;
    },

    normalizePost(raw, ctx): BooruPost {
      const first = expandPawchivePost(raw, ctx, hosts)[0];
      if (!first) throw shapeError(`${displayName} post`, 'post has no files');
      return first;
    },

    normalizeRating(): Rating {
      return 'unknown';
    },

    canonicalRatingFor(): Rating | null {
      return null;
    },

    ratingQueryTags() {
      return { tags: [], warnings: [`${displayName} has no rating system; the rating filter is ignored for this server.`] };
    },

    classifyFailure: (snapshot) => classifyFailure(snapshot, displayName),

    credentialFields(): CredentialField[] {
      return [
        {
          key: 'customUserAgent',
          label: 'User-Agent (optional)',
          type: 'text',
          required: false,
          requiredForAuth: false,
          secret: false,
          placeholder: PAWCHIVE_USER_AGENT,
          help: `${displayName} needs no login. Nothing else to configure.`,
        },
      ];
    },

    suggestUserAgent(): string {
      return PAWCHIVE_USER_AGENT;
    },
  };

  return adapter;
}

export const pawchiveAdapter: BooruAdapter = createPawchiveAdapter({
  siteType: 'pawchive',
  displayName: 'Pawchive',
  baseUrl: 'https://pawchive.pw',
  label: 'Pawchive',
  hostPatterns: ['pawchive.pw', 'www.pawchive.pw', 'pawchive.st', 'www.pawchive.st'],
  fileHost: DEFAULT_HOSTS.fileHost,
  thumbnailHost: DEFAULT_HOSTS.thumbnailHost,
  notes: [
    'pawchive.st is the previous domain of the same site.',
    'Signed originals are used when available; preview-only thumbnails are display-only and deferred files are skipped.',
    'Some files need a logged-in website session and may be inaccessible to the extension.',
  ],
});
