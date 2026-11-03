import { BooruError } from '../shared/errors.js';
import { parseJsonBody, type HttpClient } from '../shared/http.js';
import type {
  BooruPost,
  ExtensionSettings,
  Rating,
  RouteMatch,
  SearchResult,
  SearchSpec,
  ServerConfig,
} from '../shared/types.js';
import { DEFAULT_SAFE_RATINGS } from '../shared/types.js';
import { clamp, safeUrl, unique } from '../shared/util.js';
import type { BooruAdapter } from './adapter.js';
import { createAdapterContext, detectRoute, getAdapter, listAdapters, requireAdapter } from './registry.js';
import { isUsableServer, type ServerStore } from './servers.js';
import type { SettingsStore } from './settings.js';
import type { ValidationService } from './validation.js';
import { requestRateKey } from './request-policy.js';
import { hydrusAuthHeaders, hydrusFileUrl } from '../adapters/hydrus.js';

export interface BooruClientDeps {
  servers: ServerStore;
  settings: SettingsStore;
  http: HttpClient;
  validation: ValidationService;
}

export interface ResolvedTarget {
  server: ServerConfig;
  adapter: BooruAdapter;
}

/**
 * The single generic service the UI (and the download queue) talks to.
 * Nothing above this layer knows which booru it is dealing with: site
 * behaviour is reached exclusively through the adapter contract.
 */
export class BooruClient {
  constructor(private readonly deps: BooruClientDeps) {}

  get adapters(): BooruAdapter[] {
    return listAdapters();
  }

  async listServers(): Promise<ServerConfig[]> {
    return this.deps.servers.list();
  }

  async resolveServer(explicitId?: string | null): Promise<ServerConfig> {
    if (explicitId) {
      const server = await this.deps.servers.get(explicitId);
      if (!server) throw new BooruError(`Unknown server "${explicitId}"`, { kind: 'unknown' });
      return server;
    }
    const fallback = await this.deps.servers.getDefault();
    if (!fallback) {
      throw new BooruError('No server is configured yet', {
        kind: 'incomplete-config',
        hint: 'Add one in the server manager (Add server).',
      });
    }
    return fallback;
  }

  async resolve(explicitId?: string | null): Promise<ResolvedTarget> {
    const server = await this.resolveServer(explicitId);
    const adapter = requireAdapter(server.siteType);
    if (!isUsableServer(server)) {
      // Preserve site-specific diagnostics where available, but never send
      // requests from a legacy profile with an invalid or credential-bearing URL.
      adapter.normalizeBaseUrl?.(server.baseUrl);
      throw new BooruError('This server URL is invalid or contains embedded credentials.', {
        kind: 'incomplete-config', hint: 'Edit the profile and remove credentials from its URL.',
      });
    }
    return { server, adapter };
  }

  /** Does the route rating filter apply to this post? */
  isRatingAllowed(server: ServerConfig, adapter: BooruAdapter, rating: Rating): boolean {
    if (!server.ratingFilterEnabled) return true;
    if (rating === 'unknown') return true;
    const allowed = server.allowedRatings?.length ? server.allowedRatings : adapter.defaults.ratings;
    return allowed.includes(rating);
  }

  /** Build the rating filter block for a search, honouring per-call overrides. */
  ratingFilterFor(server: ServerConfig, adapter: BooruAdapter, override?: { enabled?: boolean; allowed?: Rating[] }) {
    if (!adapter.capabilities.supportsRatingFilter) return { enabled: false, allowed: [] as Rating[] };
    const enabled = override?.enabled ?? server.ratingFilterEnabled;
    const allowed = unique(override?.allowed ?? server.allowedRatings ?? adapter.defaults.ratings ?? DEFAULT_SAFE_RATINGS);
    return { enabled: enabled && allowed.length > 0, allowed };
  }

  async search(serverId: string | null, spec: SearchSpec): Promise<SearchResult> {
    const { server, adapter } = await this.resolve(serverId);
    const settings = await this.deps.settings.get();
    const ctx = createAdapterContext(adapter, server, settings);
    const limit = clamp(spec.limit ?? 50, 1, adapter.capabilities.maxPostsPerRequest);
    const fullSpec: SearchSpec = {
      ...spec,
      limit,
      ratingFilter: this.ratingFilterFor(server, adapter, spec.ratingFilter),
    };
    const request = adapter.buildSearchRequest(ctx, fullSpec);
    const snapshot = await this.deps.http.request(request, {
      rateKey: requestRateKey(server),
      minIntervalMs: Math.max(settings.minRequestIntervalMs, adapter.capabilities.minRequestIntervalMs),
      maxAttempts: settings.maxRetries,
    });
    return adapter.parseSearchResponse(snapshot, fullSpec, ctx);
  }

  async getPost(serverId: string | null, postId: string): Promise<BooruPost> {
    const { server, adapter } = await this.resolve(serverId);
    const settings = await this.deps.settings.get();
    const ctx = createAdapterContext(adapter, server, settings);
    const request = adapter.buildPostRequest(ctx, postId);
    const snapshot = await this.deps.http.request(request, {
      rateKey: requestRateKey(server),
      minIntervalMs: Math.max(settings.minRequestIntervalMs, adapter.capabilities.minRequestIntervalMs),
      maxAttempts: settings.maxRetries,
    });
    return adapter.parsePostResponse(snapshot, postId, ctx);
  }

  /** Fetch only a configured Hydrus thumbnail by ID; callers cannot supply a URL or key. */
  async getHydrusThumbnail(serverId: string, postId: string): Promise<string> {
    const { server, adapter } = await this.resolve(serverId);
    if (server.siteType !== 'hydrus') {
      throw new BooruError('Authenticated thumbnails are only available for Hydrus profiles.', { kind: 'unsupported-site' });
    }
    if (!server.apiKey.trim() || /[\r\n]/.test(server.apiKey)) {
      throw new BooruError('A valid Hydrus access key is required for thumbnails.', { kind: 'incomplete-config' });
    }
    const settings = await this.deps.settings.get();
    const ctx = createAdapterContext(adapter, server, settings);
    return this.deps.http.requestImage({
      url: hydrusFileUrl(ctx.baseUrl, postId, 'thumbnail'),
      headers: hydrusAuthHeaders(server.apiKey),
      redirect: 'error', tag: 'hydrus',
    }, {
      rateKey: requestRateKey(server),
      minIntervalMs: Math.max(settings.minRequestIntervalMs, adapter.capabilities.minRequestIntervalMs),
      maxBytes: 1024 * 1024,
    });
  }

  /**
   * The post exactly as the site sent it.
   *
   * `BooruPost` is deliberately lossy - it carries what a *booru* needs. The
   * Links tab needs the opposite: every URL buried anywhere in the payload
   * (creator archives keep their real downloads in a `content` HTML field,
   * which no adapter field maps to). Reading the raw JSON keeps that feature
   * site-agnostic and leaves the adapter contract untouched.
   */
  async getPostPayload(serverId: string | null, postId: string): Promise<unknown> {
    const { server, adapter } = await this.resolve(serverId);
    const settings = await this.deps.settings.get();
    const ctx = createAdapterContext(adapter, server, settings);
    const request = adapter.buildPostRequest(ctx, postId);
    const snapshot = await this.deps.http.request(request, {
      rateKey: requestRateKey(server),
      minIntervalMs: Math.max(settings.minRequestIntervalMs, adapter.capabilities.minRequestIntervalMs),
      maxAttempts: settings.maxRetries,
    });
    const failure = adapter.classifyFailure?.(snapshot) ?? null;
    if (failure) {
      throw new BooruError(failure.message, { kind: failure.kind, status: snapshot.status, hint: failure.hint ?? null });
    }
    return parseJsonBody<unknown>(snapshot, `${adapter.displayName} post ${postId}`);
  }

  async validateServer(serverId: string): Promise<ReturnType<ValidationService['validate']>> {
    const server = await this.resolveServer(serverId);
    const settings = await this.deps.settings.get();
    const result = await this.deps.validation.validate(server, settings);
    const updated = await this.deps.servers.updateValidation(server.id, result, server);
    if (!updated) {
      return { ...result, ok: false, kind: 'incomplete-config', endpointOk: null, authOk: null, account: null,
        message: 'The server profile changed or was removed during validation; validate the current profile again.', trace: [] };
    }
    return result;
  }

  /** Validate an unsaved draft (the add/edit form calls this before saving). */
  async validateDraft(server: ServerConfig) {
    const settings = await this.deps.settings.get();
    return this.deps.validation.validate(server, settings);
  }

  /** URL → route, preferring a saved server that owns the host. */
  async resolveRoute(url: string): Promise<(RouteMatch & { server: ServerConfig | null }) | null> {
    const servers = await this.deps.servers.list();
    const match = detectRoute(url, servers);
    if (!match) return null;
    let server = match.serverId ? servers.find((entry) => entry.id === match.serverId) ?? null : null;
    if (!server && match.siteType === 'pawchive') {
      // `www` and the former domain are aliases of the same creator archive.
      const host = safeUrl(url)?.hostname.replace(/^www\./, '');
      const candidates = servers.filter((entry) => entry.siteType === 'pawchive' && isUsableServer(entry));
      server = candidates.find((entry) => safeUrl(entry.baseUrl)?.hostname === host)
        ?? candidates.find((entry) => entry.isDefault)
        ?? candidates[0]
        ?? null;
    }
    return { ...match, ...(server ? { serverId: server.id } : {}), server };
  }

  /** Resolve a post referenced by URL (used by the content script + popup). */
  async resolvePostFromUrl(url: string): Promise<{ post: BooruPost; server: ServerConfig; route: RouteMatch }> {
    const route = await this.resolveRoute(url);
    if (!route || route.kind !== 'post' || !route.postId) {
      throw new BooruError('This page is not a recognized booru post', {
        kind: 'endpoint-mismatch',
        hint: 'Open a post page on a saved server, or search by tags instead.',
      });
    }
    const preferred = route.server ?? null;
    const candidates = preferred ? [preferred] : (await this.deps.servers.list()).filter((server) => {
      const adapter = getAdapter(server.siteType);
      return !!adapter && adapter.matchesHost(new URL(url).host);
    });
    if (!candidates.length) {
      throw new BooruError('No saved server matches this page', {
        kind: 'incomplete-config',
        hint: 'Add the site as a server first (Add server).',
      });
    }
    let lastError: unknown = null;
    for (const candidate of candidates) {
      try {
        const post = await this.getPost(candidate.id, route.postId);
        return { post, server: candidate, route };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new BooruError('Could not load the post from any saved server', { kind: 'unknown' });
  }

  async getSettings(): Promise<ExtensionSettings> {
    return this.deps.settings.get();
  }
}
