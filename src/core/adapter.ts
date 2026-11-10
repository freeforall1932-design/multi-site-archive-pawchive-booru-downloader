import type { HttpResponseSnapshot, HttpRequestSpec } from '../shared/http.js';
import type {
  AccountInfo,
  BooruPost,
  ExtensionSettings,
  FailureKind,
  Rating,
  RouteMatch,
  SearchResult,
  SearchSpec,
  ServerConfig,
  SiteType,
  ValidationKind,
} from '../shared/types.js';

/**
 * Everything an adapter needs to build a request. Adapters receive credentials
 * only here, and must never log them.
 */
export interface AdapterContext {
  server: ServerConfig;
  settings: ExtensionSettings;
  /** Effective User-Agent for this server (custom or adapter default). */
  userAgent: string;
  /** Normalized base URL (no trailing slash). */
  baseUrl: string;
}

export type AuthStyle = 'basic' | 'query' | 'basic-or-query' | 'query-with-userid' | 'header';

export interface AdapterCapabilities {
  /** Read endpoints work without credentials. */
  supportsAnonymousAccess: boolean;
  /** The site documents per-rating search filters. */
  supportsRatingFilter: boolean;
  /** A username is required (not just useful) to authenticate. */
  requiresUsername: boolean;
  /** A numeric user id is required (Gelbooru). */
  requiresUserId: boolean;
  requiresApiKey: boolean;
  /** Descriptive User-Agent is mandated by the site's policy. */
  requiresUserAgent: boolean;
  authStyle: AuthStyle;
  supportsBasicAuthHeader: boolean;
  /** Max posts the site will return in one listing request. */
  maxPostsPerRequest: number;
  /** Highest page number the listing endpoint accepts, if limited. */
  maxPage: number | null;
  /** Site-documented minimum gap between requests (ms). */
  minRequestIntervalMs: number;
  supportsPostLookup: boolean;
  supportsTagSearch: boolean;
  /** Site accepts arbitrary page tokens (e.g. `b12345`). */
  supportsIdPagination: boolean;
  /** Does the site have a JSON listing endpoint at all (false = HTML only, unsupported). */
  apiDocsUrl: string;
  /** Short notes surfaced in the diagnostics tab. */
  notes: string[];
}

export interface CredentialField {
  key: 'username' | 'apiKey' | 'userId' | 'customUserAgent';
  label: string;
  type: 'text' | 'password' | 'textarea';
  /** Required for the profile to be usable at all. */
  required: boolean;
  /** Required when the user supplies any credentials. */
  requiredForAuth: boolean;
  secret: boolean;
  placeholder?: string;
  help?: string;
}

export interface ProbeInterpretation {
  ok: boolean;
  kind: ValidationKind;
  message: string;
  warnings?: string[];
  account?: AccountInfo | null;
}

/**
 * A single HTTP check performed during validation. Interpretation is
 * site-specific and therefore lives inside the adapter.
 */
export interface ValidationProbe {
  id: string;
  label: string;
  purpose: 'endpoint' | 'auth';
  request: HttpRequestSpec;
  interpret: (snapshot: HttpResponseSnapshot) => ProbeInterpretation;
  /** Probe may be skipped (e.g. no credentials saved yet). */
  enabled?: boolean;
  /**
   * Probe endpoints that are optional: a 404/405 means "not available on this
   * instance", so validation moves on to the next candidate instead of failing.
   */
  optional?: boolean;
}

/** Site-specific reading of an error payload. */
export interface AdapterFailure {
  kind: FailureKind;
  message: string;
  hint?: string;
}

/** What an adapter may look at when suggesting a User-Agent (no secrets). */
export interface UserAgentHintContext {
  server: Pick<ServerConfig, 'username' | 'userId' | 'customUserAgent'>;
  baseUrl: string;
}

export interface AdapterDefaults {
  baseUrl: string;
  label: string;
  /** Ratings allowed when the rating filter is switched on. */
  ratings: Rating[];
  userAgentHint: string;
}

/**
 * THE SHARED BOORU ADAPTER CONTRACT.
 *
 * Adding a booru-like site = implement this interface + register it
 * (`src/adapters/index.ts`). Cross-site behavior is shared where possible;
 * Pawchive's attachment, pacing and task policies have explicit branches. See
 * docs/ADAPTER_CONTRACT.md for a step-by-step guide and the conformance tests
 * in tests/adapters/contract.test.ts.
 */
export interface BooruAdapter {
  readonly siteType: SiteType;
  readonly displayName: string;
  readonly capabilities: AdapterCapabilities;
  /** Host patterns this adapter claims for route detection, e.g. `*.gelbooru.com`. */
  readonly hostPatterns: string[];
  readonly defaults: AdapterDefaults;

  /** Optional per-site normalization of the configured base URL. */
  normalizeBaseUrl?(raw: string): string;

  /** Does this adapter own the given hostname? */
  matchesHost(host: string): boolean;

  /**
   * Pure URL → route mapping. Must not require a saved server: the popup needs
   * to know "is the tab I'm on a post page?" before anything is configured.
   */
  matchRoute(url: string): RouteMatch | null;

  /** Absolute post page URL for a post id (used in queue links). */
  postUrl(baseUrl: string, postId: string): string;

  buildSearchRequest(ctx: AdapterContext, spec: SearchSpec): HttpRequestSpec;
  buildPostRequest(ctx: AdapterContext, postId: string): HttpRequestSpec;

  /** Ordered validation probes: endpoint compatibility first, then credentials. */
  buildValidationProbes(ctx: AdapterContext): ValidationProbe[];

  parseSearchResponse(snapshot: HttpResponseSnapshot, spec: SearchSpec, ctx: AdapterContext): SearchResult;
  parsePostResponse(snapshot: HttpResponseSnapshot, postId: string, ctx: AdapterContext): BooruPost;

  /** Site JSON → normalized post. Exposed for tests and future bulk import. */
  normalizePost(raw: unknown, ctx: AdapterContext): BooruPost;

  normalizeRating(raw: unknown): Rating;
  /** Every rating token the site understands (used to build exclusion filters). */
  readonly siteRatingTokens: readonly string[];
  /** Canonical rating for one of the site's own tokens, or null if unknown. */
  canonicalRatingFor(siteToken: string): Rating | null;

  /**
   * Rating-filter contribution to a query: an exclusion list
   * (`-rating:explicit`) which works on every target site and is safe even
   * when a site's OR-syntax differs.
   */
  ratingQueryTags(allowed: Rating[]): { tags: string[]; warnings: string[] };

  /** Optional site-specific error classification applied to any response. */
  classifyFailure?(snapshot: HttpResponseSnapshot): AdapterFailure | null;

  credentialFields(server?: Partial<ServerConfig>): CredentialField[];

  /** Suggested descriptive User-Agent, honouring the site's policy. */
  suggestUserAgent(ctx: UserAgentHintContext): string;

  /**
   * Optional request decoration for browser-specific limitations, e.g. the
   * `_client` query parameter e621 documents for extensions that cannot set a
   * User-Agent header.
   */
  decorateRequest?(ctx: AdapterContext, spec: HttpRequestSpec): HttpRequestSpec;
}

export function isAdapter(value: unknown): value is BooruAdapter {
  const candidate = value as Partial<BooruAdapter> | null;
  return (
    !!candidate &&
    typeof candidate.siteType === 'string' &&
    typeof candidate.buildSearchRequest === 'function' &&
    typeof candidate.parseSearchResponse === 'function' &&
    typeof candidate.parsePostResponse === 'function'
  );
}
