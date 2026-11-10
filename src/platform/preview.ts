import { RecordingDownloader, type Downloader, type DownloadRequest, type DownloadOutcome, type DownloadSnapshot } from '../core/downloads.js';
import type { RouterResponse, UiRequest } from '../core/messages.js';
import { WebStorageArea, type StorageArea } from '../core/storage.js';
import type { Platform } from './types.js';

/** `localStorage` namespace the preview harness resets and documents. */
export const PREVIEW_STORAGE_NAMESPACE = 'bsm-preview';

/** Map an arbitrary demo URL to a local synthetic asset, never a live site. */
export function previewMediaUrl(url: string): string {
  if (/^\/mock\/media\/\d+\.(?:jpg|png)$/.test(url)) return url;
  let hash = 2166136261;
  for (let i = 0; i < url.length; i += 1) hash = Math.imul(hash ^ url.charCodeAt(i), 16777619);
  return `/mock/media/${hash >>> 0}.jpg`;
}

/**
 * Preview-only downloader. The anchor uses local synthetic media; its completion
 * is simulated because normal web pages cannot observe browser download state.
 */
export class PreviewDownloader implements Downloader {
  private readonly recorder = new RecordingDownloader();

  get log() {
    return this.recorder.log;
  }

  async download(request: DownloadRequest): Promise<DownloadOutcome> {
    const outcome = await this.recorder.download(request);
    try {
      const anchor = document.createElement('a');
      anchor.href = previewMediaUrl(request.url);
      anchor.download = request.filename.split('/').pop() ?? 'download';
      anchor.target = '_blank';
      anchor.rel = 'noopener';
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
    } catch {
      /* preview only */
    }
    return outcome;
  }

  getState(downloadId: number): Promise<DownloadSnapshot | null> {
    return this.recorder.getState(downloadId);
  }

  cancel(downloadId: number): Promise<void> {
    return this.recorder.cancel(downloadId);
  }
}

export interface PreviewPlatformOptions {
  handler: (request: UiRequest) => Promise<RouterResponse>;
  /** Shared with the download queue so both record the same download log. */
  downloader?: Downloader;
  /** Shared with the service graph so the UI and the router read one area. */
  storage?: StorageArea;
}

/**
 * Platform implementation for `npm run preview`: identical services, but storage
 * is `localStorage`, downloads are browser downloads of mock media, and messages
 * are handled in-process instead of by a service worker.
 */
export class PreviewPlatform implements Platform {
  readonly environment = 'preview' as const;
  readonly storage: StorageArea;
  readonly downloader: Downloader;
  readonly permissions = {
    contains: async () => true,
    request: async () => true,
  };

  constructor(private readonly options: PreviewPlatformOptions) {
    this.downloader = options.downloader ?? new PreviewDownloader();
    this.storage = options.storage ?? new WebStorageArea(PREVIEW_STORAGE_NAMESPACE);
  }

  async send(request: UiRequest): Promise<RouterResponse> {
    return this.options.handler(request);
  }

  async syncUserAgentRules(): Promise<{ ok: boolean; applied: number; error?: string }> {
    return { ok: true, applied: 0, error: 'Preview mode: declarativeNetRequest is not available, the `_client` fallback is used instead.' };
  }

  async activeTabUrl(): Promise<string | null> {
    const params = new URLSearchParams(globalThis.location.search);
    return params.get('tab');
  }

  openOptions(hash?: string): void {
    const suffix = hash ? `#${hash.replace(/^#/, '')}` : '';
    globalThis.open(`/dist/options/options.html${suffix}`, '_blank', 'noopener');
  }

  /** Preview stand-in: the "panel" opens as a normal page in its own tab. */
  async openPanel(): Promise<boolean> {
    const params = new URLSearchParams(globalThis.location.search);
    const tab = params.get('tab');
    const query = tab ? `?tab=${encodeURIComponent(tab)}` : '';
    globalThis.open(`/dist/panel/panel.html${query}`, '_blank', 'noopener');
    return true;
  }

  async describeEnvironment(): Promise<Record<string, string>> {
    return {
      Environment: 'browser preview (no extension APIs)',
      Storage: 'localStorage namespace "bsm-preview"',
      Downloads: 'mock media; completion is simulated, not observed from Chrome',
      'User-Agent rewriting': 'disabled in preview',
    };
  }
}
