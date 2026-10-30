import { BooruError } from './errors.js';
import { redactHeaders, redactUrl, redactUrlsInText, sleep } from './util.js';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/** A request description produced by an adapter. Contains credentials - never log it raw. */
export interface HttpRequestSpec {
  url: string;
  method?: HttpMethod;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  /** Adapter/site tag used in diagnostics. */
  tag?: string;
  /** Human label for the validation trace. */
  label?: string;
}

/** Sanitized snapshot of a response - safe to persist/render. */
export interface HttpResponseSnapshot {
  url: string;
  /** Credential-free URL for display. */
  redactedUrl: string;
  method: HttpMethod;
  ok: boolean;
  status: number;
  statusText: string;
  contentType: string;
  headers: Record<string, string>;
  bodyText: string;
  durationMs: number;
  tag: string | null;
}

export interface HttpEvent {
  type: 'request' | 'response' | 'retry' | 'error';
  url: string;
  method: HttpMethod;
  status?: number;
  durationMs?: number;
  attempt?: number;
  message?: string;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpClientOptions {
  fetchImpl?: FetchLike;
  defaultTimeoutMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  /** Minimum gap between requests issued through this client. */
  minIntervalMs?: number;
  now?: () => number;
  sleepImpl?: (ms: number, signal?: AbortSignal) => Promise<void>;
  onEvent?: (event: HttpEvent) => void;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 522, 524]);

/**
 * Serializes requests per key (usually one key per saved server) so we never
 * exceed a site's documented request rate.
 */
export class RateLimiter {
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly lastRun = new Map<string, number>();

  constructor(
    private readonly defaultIntervalMs = 0,
    private readonly now: () => number = () => Date.now(),
    private readonly sleepImpl: (ms: number, signal?: AbortSignal) => Promise<void> = sleep,
  ) {}

  intervalFor(key: string, override?: number): number {
    void key;
    return Math.max(0, override ?? this.defaultIntervalMs);
  }

  /** Run `task` after the per-key spacing requirement is satisfied. */
  async run<T>(key: string, task: () => Promise<T>, intervalMs?: number): Promise<T> {
    const interval = this.intervalFor(key, intervalMs);
    const previous = this.chains.get(key) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(async () => {
        const last = this.lastRun.get(key);
        if (last !== undefined && interval > 0) {
          const wait = interval - (this.now() - last);
          if (wait > 0) await this.sleepImpl(wait);
        }
        try {
          return await task();
        } finally {
          this.lastRun.set(key, this.now());
        }
      });
    this.chains.set(
      key,
      run.catch(() => undefined),
    );
    return run;
  }
}

function parseRetryAfter(headers: Headers): number | null {
  const value = headers.get('retry-after');
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

/**
 * Thin, well-behaved fetch wrapper:
 * - timeouts via AbortController
 * - retry with exponential backoff for transient/ratelimited responses
 * - per-key rate limiting
 * - redacted diagnostics events (credentials never leave this module)
 */
export class HttpClient {
  private readonly fetchImpl: FetchLike;
  private readonly defaultTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly now: () => number;
  private readonly sleepImpl: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly onEvent?: (event: HttpEvent) => void;
  readonly rateLimiter: RateLimiter;

  constructor(options: HttpClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 20_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 600;
    this.now = options.now ?? (() => Date.now());
    this.sleepImpl = options.sleepImpl ?? sleep;
    if (options.onEvent) this.onEvent = options.onEvent;
    this.rateLimiter = new RateLimiter(options.minIntervalMs ?? 0, this.now, this.sleepImpl);
  }

  private emit(event: HttpEvent): void {
    this.onEvent?.({ ...event, url: redactUrl(event.url) });
  }

  async request(spec: HttpRequestSpec, options: { signal?: AbortSignal; rateKey?: string; minIntervalMs?: number } = {}): Promise<HttpResponseSnapshot> {
    const method: HttpMethod = spec.method ?? 'GET';
    const rateKey = options.rateKey ?? spec.url;
    const maxAttempts = Math.max(1, this.maxRetries);
    let attempt = 0;
    let lastError: BooruError | null = null;

    while (attempt < maxAttempts) {
      attempt += 1;
      const started = this.now();
      try {
        const response = await this.rateLimiter.run(
          rateKey,
          () => this.perform(spec, method, options.signal),
          options.minIntervalMs,
        );
        const durationMs = this.now() - started;
        const snapshot: HttpResponseSnapshot = {
          url: spec.url,
          redactedUrl: redactUrl(spec.url),
          method,
          ok: response.response.ok,
          status: response.response.status,
          statusText: response.response.statusText,
          contentType: response.response.headers.get('content-type') ?? '',
          headers: headersToRecord(response.response.headers),
          bodyText: response.bodyText,
          durationMs,
          tag: spec.tag ?? null,
        };
        this.emit({ type: 'response', url: spec.url, method, status: snapshot.status, durationMs, attempt });
        if (!snapshot.ok && RETRYABLE_STATUS.has(snapshot.status) && attempt < maxAttempts) {
          const retryAfter = parseRetryAfter(response.response.headers);
          const delay = retryAfter ?? this.retryBaseDelayMs * 2 ** (attempt - 1);
          this.emit({
            type: 'retry',
            url: spec.url,
            method,
            attempt,
            durationMs: delay,
            message: `HTTP ${snapshot.status}, retrying in ${Math.round(delay)}ms`,
          });
          await this.sleepImpl(delay, options.signal);
          continue;
        }
        return snapshot;
      } catch (error) {
        const durationMs = this.now() - started;
        if (options.signal?.aborted) {
          throw new BooruError('Request aborted', { kind: 'network-failure', cause: error });
        }
        const isTimeout = error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError');
        lastError = new BooruError(
          isTimeout ? `Request timed out after ${spec.timeoutMs ?? this.defaultTimeoutMs}ms` : `Network request failed: ${redactUrlsInText(error instanceof Error ? error.message : String(error))}`,
          { kind: 'network-failure', cause: error },
        );
        this.emit({ type: 'error', url: spec.url, method, attempt, durationMs, message: lastError.message });
        if (attempt < maxAttempts) {
          const delay = this.retryBaseDelayMs * 2 ** (attempt - 1);
          await this.sleepImpl(delay, options.signal);
          continue;
        }
        throw lastError;
      }
    }
    throw lastError ?? new BooruError('Request failed', { kind: 'unknown' });
  }

  private async perform(
    spec: HttpRequestSpec,
    method: HttpMethod,
    signal?: AbortSignal,
  ): Promise<{ response: Response; bodyText: string }> {
    const controller = new AbortController();
    const timeoutMs = spec.timeoutMs ?? this.defaultTimeoutMs;
    const timer = setTimeout(() => controller.abort(new DOMException('Timeout', 'TimeoutError')), timeoutMs);
    const onOuterAbort = () => controller.abort(new DOMException('Aborted', 'AbortError'));
    signal?.addEventListener('abort', onOuterAbort, { once: true });
    this.emit({ type: 'request', url: spec.url, method });
    try {
      const response = await this.fetchImpl(spec.url, {
        method,
        headers: spec.headers,
        body: spec.body,
        signal: controller.signal,
        redirect: 'follow',
        credentials: 'omit',
        cache: 'no-store',
      });
      const bodyText = await response.text();
      return { response, bodyText };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onOuterAbort);
    }
  }
}

/** JSON parse helper that reports a parse failure instead of throwing raw. */
export function parseJsonBody<T = unknown>(snapshot: HttpResponseSnapshot, context: string): T {
  try {
    return JSON.parse(snapshot.bodyText) as T;
  } catch {
    if (snapshot.bodyText.trim().length === 0) {
      throw new BooruError(`Empty response body from ${context}`, {
        kind: 'parse-failure',
        status: snapshot.status,
        hint: 'The site returned nothing at all - double-check the base URL.',
      });
    }
    throw new BooruError(
      `${context} returned ${snapshot.contentType.includes('html') ? 'HTML' : 'a non-JSON body'} instead of JSON`,
      {
        kind: snapshot.contentType.includes('html') ? 'endpoint-mismatch' : 'parse-failure',
        status: snapshot.status,
        hint: 'This usually means the base URL points at a web page rather than the API root.',
      },
    );
  }
}

export function describeRequest(spec: HttpRequestSpec, headersOverride?: Record<string, string>): string {
  const headers = redactHeaders(spec.headers ?? {});
  const override = redactHeaders(headersOverride ?? {});
  const merged = { ...headers, ...override };
  const headerText = Object.entries(merged)
    .map(([key, value]) => `${key}: ${value}`)
    .join(', ');
  return `${spec.method ?? 'GET'} ${redactUrl(spec.url)}${headerText ? ` [${headerText}]` : ''}`;
}
