/**
 * Browser preview bootstrap.
 *
 * Builds the exact same service graph as the MV3 service worker - adapters,
 * storage, HTTP layer, validation, queue, router - but backed by
 *  - `localStorage` instead of `chrome.storage.local`
 *  - the offline mock booru API instead of the live sites
 *  - a recording downloader instead of `chrome.downloads`
 *
 * UI entry points call `startPreview()` only when the extension runtime is
 * missing, so the shipped extension never loads this module.
 */
import { registerBuiltinAdapters } from '../adapters/index.js';
import { BooruClient } from '../core/client.js';
import type { RouterResponse, UiRequest } from '../core/messages.js';
import { DownloadHistoryStore, SearchHistoryStore } from '../core/history.js';
import { MirrorLinkStore } from '../core/link-store.js';
import { TaskStore } from '../core/task-store.js';
import { DownloadQueue } from '../core/queue.js';
import { createRouter } from '../core/router.js';
import { ServerStore } from '../core/servers.js';
import { SettingsStore } from '../core/settings.js';
import { STORAGE_KEYS, WebStorageArea, type StorageArea } from '../core/storage.js';
import { ValidationService } from '../core/validation.js';
import { HttpClient } from '../shared/http.js';
import type { BooruPost, SearchResult, ServerConfig } from '../shared/types.js';
import { createServerConfig } from '../core/servers.js';
import { installPlatform } from '../platform/index.js';
import { PREVIEW_STORAGE_NAMESPACE, PreviewDownloader, PreviewPlatform, previewMediaUrl } from '../platform/preview.js';
import { createMockBooruFetch } from './mock-booru.js';
import { MOCK_CREDENTIALS } from './mock-data.js';

interface PreviewGlobal {
  installed?: boolean;
  servers?: ServerConfig[];
  storage?: StorageArea;
  router?: ReturnType<typeof createRouter>;
}

const globalScope = globalThis as typeof globalThis & { __bsmPreview?: PreviewGlobal };

/** Keep automatic thumbnails inside the preview, even for real-shaped mock URLs. */
export function withPreviewMedia(request: UiRequest, response: RouterResponse): RouterResponse {
  if (!response.ok) return response;
  const post = (entry: BooruPost): BooruPost => ({ ...entry, previewUrl: previewMediaUrl(entry.previewUrl || entry.id) });
  if (request.type === 'browse/search') {
    const data = response.data as SearchResult;
    return { ...response, data: { ...data, posts: data.posts.map(post) } };
  }
  if (request.type === 'posts/get') return { ...response, data: post(response.data as BooruPost) };
  if (request.type === 'posts/resolveUrl' || request.type === 'posts/download') {
    const data = response.data as { post: BooruPost };
    return { ...response, data: { ...data, post: post(data.post) } };
  }
  return response;
}

/** Seed profiles so the preview opens with a working server manager. */
export function defaultPreviewServers(): ServerConfig[] {
  return [
    createServerConfig({
      siteType: 'e621',
      baseUrl: 'https://e621.net',
      label: 'e621 (demo account)',
      username: MOCK_CREDENTIALS.e621.username,
      apiKey: MOCK_CREDENTIALS.e621.apiKey,
      customUserAgent: 'BooruServerManager/0.1.0 (preview harness; by demo_e621 on e621)',
      isDefault: true,
      allowedRatings: ['safe'],
      ratingFilterEnabled: true,
    }),
    createServerConfig({
      siteType: 'danbooru',
      baseUrl: 'https://danbooru.donmai.us',
      label: 'Danbooru (demo account)',
      username: MOCK_CREDENTIALS.danbooru.username,
      apiKey: MOCK_CREDENTIALS.danbooru.apiKey,
      customUserAgent: 'BooruServerManager/0.1.0 (by user #778899)',
      allowedRatings: ['general', 'sensitive'],
      ratingFilterEnabled: true,
    }),
    createServerConfig({
      siteType: 'gelbooru',
      baseUrl: 'https://gelbooru.com',
      label: 'Gelbooru (demo account)',
      username: 'demo_gelbooru',
      userId: MOCK_CREDENTIALS.gelbooru.userId,
      apiKey: MOCK_CREDENTIALS.gelbooru.apiKey,
      allowedRatings: ['general', 'sensitive', 'questionable'],
      ratingFilterEnabled: true,
    }),
    createServerConfig({
      siteType: 'e621',
      baseUrl: 'https://e926.net',
      label: 'e926 (safe mirror, no credentials)',
      customUserAgent: 'BooruServerManager/0.1.0 (preview harness)',
      allowedRatings: ['safe'],
      ratingFilterEnabled: false,
    }),
    // Creator archive: no login, and the demo creator's posts carry the mirror
    // links the Links tab collects (see `MOCK_CREATOR_POSTS`).
    createServerConfig({
      siteType: 'pawchive',
      baseUrl: 'https://pawchive.pw',
      label: 'Pawchive (demo creator)',
      customUserAgent: 'BooruServerManager/0.1.0 (preview harness)',
      allowedRatings: ['general', 'safe', 'sensitive', 'questionable', 'explicit'],
      ratingFilterEnabled: false,
    }),
  ];
}

/** Build (once) and install the preview platform for this page. */
export async function startPreview(options: { reseed?: boolean } = {}): Promise<void> {
  const existing = globalScope.__bsmPreview;
  if (existing?.installed) return;

  registerBuiltinAdapters();
  // `localStorage` (not memory) so the options page, the popup and a reload all
  // share the same demo servers - exactly like `chrome.storage.local` does.
  const storage = new WebStorageArea(PREVIEW_STORAGE_NAMESPACE);
  const seeded: PreviewGlobal = { installed: true, storage };

  const settings = new SettingsStore(storage);
  const servers = new ServerStore(storage);

  // Seed demo profiles the first time the preview runs in this page load.
  const stored = await storage.get<ServerConfig[]>(STORAGE_KEYS.servers);
  if (!stored || options.reseed) {
    await storage.set(STORAGE_KEYS.servers, defaultPreviewServers());
  }

  const http = new HttpClient({
    fetchImpl: createMockBooruFetch({ latencyMs: 120 }),
    maxRetries: 2,
    retryBaseDelayMs: 150,
  });
  const validation = new ValidationService(http);
  const client = new BooruClient({ servers, settings, http, validation });
  const downloader = new PreviewDownloader();
  const history = new DownloadHistoryStore(storage);
  const searches = new SearchHistoryStore(storage);
  const links = new MirrorLinkStore(storage);
  const tasks = new TaskStore(storage);
  const queue = new DownloadQueue({ storage, client, servers, settings, downloader, history, links, tasks });

  const router = createRouter({
    client,
    queue,
    servers,
    settings,
    downloader,
    storage,
    history,
    searches,
    links,
    tasks,
    // The preview keeps no chrome APIs, so UA rewriting is reported as a no-op.
    environment: 'preview',
    version: '0.1.0-preview',
  });

  installPlatform(
    new PreviewPlatform({
      handler: async (request: UiRequest) => withPreviewMedia(request, await router(request)),
      downloader,
      storage,
    }),
  );

  seeded.router = router;
  globalScope.__bsmPreview = seeded;
}
