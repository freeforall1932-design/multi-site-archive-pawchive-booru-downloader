import { isPawchiveHost } from '../adapters/pawchive.js';
import { hydrusAdapter, hydrusAuthHeaders, hydrusFileUrl } from '../adapters/hydrus.js';
import { BooruError } from '../shared/errors.js';
import { RateLimiter } from '../shared/http.js';
import type { BooruPost, ServerConfig } from '../shared/types.js';
import { normalizeBaseUrl, redactUrlsInText, safeUrl } from '../shared/util.js';

/**
 * Resolve the site's original-file URL for every post download path. Previews
 * remain available for display, but are never a substitute for an unavailable
 * original. Obvious rendition paths are rejected even if an API places one in
 * its original-file field. The site is still the authority on what it serves.
 */
export function requireOriginalFile(post: BooruPost): string {
  if (post.fileAvailability === 'preview') {
    throw new BooruError(`Original file for post ${post.id} is unavailable; only a preview was reported.`, {
      kind: 'incomplete-config',
      hint: 'Try again when the original is available; previews are not downloaded.',
    });
  }
  const url = safeUrl(post.fileUrl);
  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
    throw new BooruError(`Original file for post ${post.id} is unavailable.`, {
      kind: 'incomplete-config',
      hint: 'The site did not provide an original-file URL. Samples and previews are not downloaded.',
    });
  }
  // These are standard reduced-rendition path markers used by booru families.
  // Do not infer quality from dimensions or from equality with sampleUrl: a site
  // may point both fields at the same unchanged original for small images.
  const path = url.pathname.toLowerCase();
  const reducedPath = /\/(?:samples?|previews?|thumbs?|thumbnails?)(?:\/|[_-])/.test(path);
  const convertedMoebooru = (post.siteType === 'yandere' || post.siteType === 'konachan') && /\/jpeg\//.test(path);
  if (reducedPath || convertedMoebooru) {
    throw new BooruError(`Original file for post ${post.id} is unavailable; the URL points to a reduced rendition.`, {
      kind: 'incomplete-config',
      hint: 'Samples, converted JPEGs and previews are not downloaded in place of originals.',
    });
  }
  return post.fileUrl;
}

/** Only attach a Hydrus key to the exact configured original-file endpoint. */
export function postDownloadAuth(server: ServerConfig, post: BooruPost, target: string): Record<string, string> | undefined {
  if (server.siteType !== 'hydrus') return undefined;
  const base = normalizeBaseUrl(hydrusAdapter.normalizeBaseUrl!(server.baseUrl));
  const parsed = safeUrl(base);
  if (!parsed || !['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password ||
      post.siteType !== 'hydrus' || post.serverId !== server.id || target !== hydrusFileUrl(base, post.id, 'file')) {
    throw new BooruError('Refusing to send a Hydrus key to an unexpected file URL.', { kind: 'incomplete-config' });
  }
  if (!server.apiKey.trim() || /[\r\n]/.test(server.apiKey)) {
    throw new BooruError('A valid Hydrus access key is required for downloads.', { kind: 'incomplete-config' });
  }
  return hydrusAuthHeaders(server.apiKey);
}

export interface DownloadRequest {
  url: string;
  /** Volatile authentication headers; never add to queue/history or logs. */
  headers?: Record<string, string>;
  /** Path relative to the browser's download directory. */
  filename: string;
  /** Avoid clobbering an existing file (default: uniquify). */
  conflictAction?: 'uniquify' | 'overwrite' | 'prompt';
  /** Abort signal used by queue cancellation. */
  signal?: AbortSignal;
}

export interface DownloadOutcome {
  downloadId: number | null;
  /** True when the direct download failed and the bytes were fetched then saved. */
  viaFallback: boolean;
  bytes: number | null;
}

export interface DownloadSnapshot {
  state: 'in_progress' | 'complete' | 'interrupted';
  error: string | null;
  bytesReceived: number | null;
  totalBytes: number | null;
  /** Chrome's absolute path, used only to recover a uniquified basename. */
  filename: string | null;
  endTime: string | null;
}

export interface Downloader {
  download(request: DownloadRequest): Promise<DownloadOutcome>;
  /** null means the browser no longer has a record for this ID. */
  getState(downloadId: number): Promise<DownloadSnapshot | null>;
  cancel(downloadId: number): Promise<void>;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new BooruError('Download canceled before the browser started it.', { kind: 'unknown' });
}

/** Space Pawchive file starts across profiles without slowing independent booru hosts. */
export class PawchivePacedDownloader implements Downloader {
  constructor(
    private readonly inner: Downloader,
    private readonly limiter = new RateLimiter(),
  ) {}

  async download(request: DownloadRequest): Promise<DownloadOutcome> {
    throwIfAborted(request.signal);
    const url = safeUrl(request.url);
    if (!url || !isPawchiveHost(url.hostname, true)) return this.inner.download(request);
    return this.limiter.run('pawchive-files', () => {
      throwIfAborted(request.signal);
      return this.inner.download(request);
    }, 1000);
  }

  getState(downloadId: number): Promise<DownloadSnapshot | null> {
    return this.inner.getState(downloadId);
  }

  cancel(downloadId: number): Promise<void> {
    return this.inner.cancel(downloadId);
  }
}

/** Records downloads instead of touching the filesystem (tests + browser preview). */
export class RecordingDownloader implements Downloader {
  readonly log: Array<{ url: string; filename: string; at: string }> = [];
  /** When set, the next `download()` call throws it and the field resets. */
  failNext: Error | null = null;
  /** URLs that always fail (a hosting page that refuses, a dead mirror). */
  failUrls = new Set<string>();
  /** Failures the caller asked for, by URL, without consuming `failNext`. */
  failMessage = 'HTTP 403 - the hosting page refused the request';
  /** Tests may turn this off to model a browser transfer that is still running. */
  autoComplete = true;
  private nextId = 1;
  private readonly states = new Map<number, DownloadSnapshot>();

  async download(request: DownloadRequest): Promise<DownloadOutcome> {
    throwIfAborted(request.signal);
    if (!safeUrl(request.url)) {
      throw new BooruError(`Not a valid download URL: ${request.url}`, { kind: 'parse-failure' });
    }
    const failure = this.failNext;
    if (failure) {
      this.failNext = null;
      throw failure;
    }
    if (this.failUrls.has(request.url)) throw new Error(this.failMessage);
    this.log.push({ url: request.url, filename: request.filename, at: new Date().toISOString() });
    const downloadId = this.nextId++;
    this.states.set(downloadId, {
      state: this.autoComplete ? 'complete' : 'in_progress',
      error: null,
      bytesReceived: null,
      totalBytes: null,
      filename: request.filename,
      endTime: this.autoComplete ? new Date().toISOString() : null,
    });
    return { downloadId, viaFallback: false, bytes: null };
  }

  async getState(downloadId: number): Promise<DownloadSnapshot | null> {
    const state = this.states.get(downloadId);
    return state ? { ...state } : null;
  }

  /** Set a simulated browser outcome; the caller emits the change to the queue. */
  setState(downloadId: number, patch: Partial<DownloadSnapshot> | null): void {
    if (patch === null) {
      this.states.delete(downloadId);
      return;
    }
    const current = this.states.get(downloadId);
    if (!current) throw new Error(`Unknown simulated download ${downloadId}`);
    this.states.set(downloadId, { ...current, ...patch });
  }

  async cancel(downloadId: number): Promise<void> {
    const current = this.states.get(downloadId);
    if (!current || current.state !== 'in_progress') throw new Error('Download is not in progress');
    this.states.set(downloadId, { ...current, state: 'interrupted', error: 'USER_CANCELED', endTime: new Date().toISOString() });
  }

  reset(): void {
    this.log.length = 0;
    this.failNext = null;
    this.failUrls.clear();
    this.states.clear();
    this.autoComplete = true;
    this.nextId = 1;
  }
}

export interface ChromeDownloaderOptions {
  /** Fetch implementation used for the blob fallback (extension host permissions apply). */
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  /** Blob URL factory override for tests. */
  createObjectUrl?: (blob: Blob) => string;
  revokeObjectUrl?: (url: string) => void;
}

/**
 * Real downloads through `chrome.downloads`.
 *
 * The direct API call is preferred (browser handles retries/resume). A blob
 * fallback is possible only in a context that supports object URLs. MV3 service
 * workers do not, so they report the direct error instead of fetching a whole
 * file and failing when trying to create an object URL.
 */
export class ChromeDownloader implements Downloader {
  private readonly fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
  private readonly createObjectUrl: ((blob: Blob) => string) | null;
  private readonly revokeObjectUrl: (url: string) => void;

  constructor(options: ChromeDownloaderOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.createObjectUrl = options.createObjectUrl ?? (typeof URL.createObjectURL === 'function' ? (blob) => URL.createObjectURL(blob) : null);
    this.revokeObjectUrl = options.revokeObjectUrl ?? ((url) => URL.revokeObjectURL?.(url));
  }

  async download(request: DownloadRequest): Promise<DownloadOutcome> {
    throwIfAborted(request.signal);
    try {
      const downloadId = await this.direct(request.url, request.filename, request.conflictAction ?? 'uniquify', request.headers);
      return { downloadId, viaFallback: false, bytes: null };
    } catch (error) {
      throwIfAborted(request.signal);
      const booruError = error instanceof BooruError ? error : null;
      if (booruError?.kind !== 'blocked' && booruError?.kind !== 'unknown') throw error;
      if (!this.createObjectUrl) {
        throw new BooruError(`${booruError.message}. Blob fallback is unavailable in this service worker.`, {
          kind: booruError.kind,
          hint: request.headers ? 'Check Chrome Downloads, the trusted Hydrus endpoint, and host access.' : 'Check Chrome Downloads and host access, or open the original URL in the browser.',
        });
      }
      return this.viaBlob(request);
    }
  }

  async getState(downloadId: number): Promise<DownloadSnapshot | null> {
    const downloads = globalThis.chrome?.downloads;
    if (!downloads) throw new Error('chrome.downloads is unavailable');
    const [item] = await downloads.search({ id: downloadId });
    if (!item) return null;
    const nonnegative = (value: number | undefined): number | null =>
      typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
    return {
      state: item.state,
      error: item.error ?? null,
      bytesReceived: nonnegative(item.bytesReceived),
      totalBytes: nonnegative(item.totalBytes),
      filename: item.filename || null,
      endTime: item.endTime ?? null,
    };
  }

  async cancel(downloadId: number): Promise<void> {
    const downloads = globalThis.chrome?.downloads;
    if (!downloads) throw new Error('chrome.downloads is unavailable');
    await downloads.cancel(downloadId);
  }

  private async direct(url: string, filename: string, conflictAction: 'uniquify' | 'overwrite' | 'prompt', headers?: Record<string, string>): Promise<number> {
    const downloads = globalThis.chrome?.downloads;
    if (!downloads) {
      throw new BooruError('chrome.downloads is unavailable', { kind: 'unknown' });
    }
    try {
      return await downloads.download({
        url, filename, conflictAction, saveAs: false,
        ...(headers ? { headers: Object.entries(headers).map(([name, value]) => ({ name, value })) } : {}),
      });
    } catch (error) {
      let message = redactUrlsInText(error instanceof Error ? error.message : String(error));
      for (const value of Object.values(headers ?? {})) if (value) message = message.split(value).join('***');
      const blocked = /permission|denied|not allowed|invalid url|forbidden/i.test(message);
      throw new BooruError(`chrome.downloads rejected the file: ${message}`, {
        kind: blocked ? 'blocked' : 'unknown',
        hint: blocked ? 'Grant access to this media host (Settings > Host access) and try again.' : null,
      });
    }
  }

  private async viaBlob(request: DownloadRequest): Promise<DownloadOutcome> {
    let response: Response;
    try {
      response = await this.fetchImpl(request.url, {
        signal: request.signal, credentials: 'omit', headers: request.headers,
        redirect: request.headers ? 'error' : 'follow',
      });
    } catch (error) {
      let message = redactUrlsInText(error instanceof Error ? error.message : String(error));
      for (const value of Object.values(request.headers ?? {})) if (value) message = message.split(value).join('***');
      throw new BooruError(`Media download failed: ${message}`, { kind: 'network-failure' });
    }
    if (!response.ok) {
      throw new BooruError(`Media host refused the download (HTTP ${response.status})`, {
        kind: response.status === 401 || response.status === 403 ? 'blocked' : 'network-failure',
        status: response.status,
      });
    }
    const blob = await response.blob();
    throwIfAborted(request.signal);
    // download() only enters this path when object URLs are available.
    const objectUrl = this.createObjectUrl!(blob);
    try {
      const downloadId = await this.direct(objectUrl, request.filename, request.conflictAction ?? 'uniquify');
      return { downloadId, viaFallback: true, bytes: blob.size };
    } finally {
      setTimeout(() => this.revokeObjectUrl(objectUrl), 60_000);
    }
  }
}
