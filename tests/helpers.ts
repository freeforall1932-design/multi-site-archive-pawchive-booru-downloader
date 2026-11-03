import { registerBuiltinAdapters } from '../src/adapters/index.js';
import { BooruClient } from '../src/core/client.js';
import { DownloadHistoryStore, SearchHistoryStore } from '../src/core/history.js';
import { MirrorLinkStore } from '../src/core/link-store.js';
import { TaskStore } from '../src/core/task-store.js';
import { DownloadQueue } from '../src/core/queue.js';
import { ServerStore } from '../src/core/servers.js';
import { SettingsStore } from '../src/core/settings.js';
import { MemoryStorageArea } from '../src/core/storage.js';
import { createRouter } from '../src/core/router.js';
import { ValidationService } from '../src/core/validation.js';
import { HttpClient } from '../src/shared/http.js';
import { DEFAULT_SETTINGS, type ExtensionSettings, type ServerConfig } from '../src/shared/types.js';
import type { FetchLike, HttpResponseSnapshot } from '../src/shared/http.js';
import { RecordingDownloader } from '../src/core/downloads.js';
import { createServerConfig } from '../src/core/servers.js';
import { createMockBooruFetch } from '../src/preview/mock-booru.js';
import { MOCK_POSTS } from '../src/preview/mock-data.js';

registerBuiltinAdapters();

export interface TestHarnessOptions {
  settings?: Partial<ExtensionSettings>;
  seedServers?: ServerConfig[];
  /** Use the offline mock booru backend instead of a stubbed fetch. */
  mockBooru?: boolean;
  fetchImpl?: FetchLike;
}

/** Wires the whole service graph against in-memory storage. */
export function createHarness(options: TestHarnessOptions = {}) {
  const area = new MemoryStorageArea();
  const settings = new SettingsStore(area);
  const servers = new ServerStore(area);
  const fetchImpl = options.fetchImpl ?? (options.mockBooru === false ? undefined : createMockBooruFetch({ latencyMs: 0 }));
  const http = new HttpClient({ fetchImpl, maxRetries: 2, retryBaseDelayMs: 1, sleepImpl: async () => undefined });
  const validation = new ValidationService(http);
  const client = new BooruClient({ servers, settings, http, validation });
  const downloader = new RecordingDownloader();
  const history = new DownloadHistoryStore(area);
  const searches = new SearchHistoryStore(area);
  const links = new MirrorLinkStore(area);
  const tasks = new TaskStore(area);
  const queue = new DownloadQueue({ storage: area, client, servers, settings, downloader, history, links, tasks });
  const router = createRouter({
    client,
    queue,
    servers,
    settings,
    downloader,
    storage: area,
    history,
    searches,
    links,
    tasks,
    environment: 'extension',
    version: 'test',
  });

  /** Seed storage: accepts inline servers/settings, else uses the factory options. */
  const seed = async (overrides: TestHarnessOptions = {}) => {
    for (const server of overrides.seedServers ?? options.seedServers ?? []) await servers.save(server);
    const settingsOverrides = overrides.settings ?? options.settings;
    if (settingsOverrides) await settings.save(settingsOverrides);
  };

  return { area, settings, servers, http, validation, client, downloader, queue, history, searches, links, tasks, router, seed };
}

export function e621Server(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return createServerConfig({
    siteType: 'e621',
    baseUrl: 'https://e621.net',
    label: 'e621 test',
    username: 'demo_e621',
    apiKey: 'e621-demo-key',
    customUserAgent: 'BooruServerManager/test (by demo_e621 on e621)',
    allowedRatings: ['safe'],
    ...overrides,
  });
}

export function danbooruServer(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return createServerConfig({
    siteType: 'danbooru',
    baseUrl: 'https://danbooru.donmai.us',
    label: 'Danbooru test',
    username: 'demo_danbooru',
    apiKey: 'danbooru-demo-key',
    allowedRatings: ['general', 'sensitive'],
    ...overrides,
  });
}

export function gelbooruServer(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return createServerConfig({
    siteType: 'gelbooru',
    baseUrl: 'https://gelbooru.com',
    label: 'Gelbooru test',
    userId: '4242',
    apiKey: 'gelbooru-demo-key',
    username: 'demo_gelbooru',
    allowedRatings: ['general', 'sensitive'],
    ...overrides,
  });
}

/** Response snapshot built synchronously, for adapter parsing tests. */
export function httpSnapshot(body: unknown, status = 200, contentType = 'application/json; charset=utf-8'): HttpResponseSnapshot {
  const bodyText = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    url: 'https://test.local/request',
    redactedUrl: 'https://test.local/request',
    method: 'GET',
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    contentType,
    headers: { 'content-type': contentType },
    bodyText,
    durationMs: 1,
    tag: null,
  };
}

export function htmlSnapshot(body = '<!doctype html><html><body>not the api</body></html>', status = 200): HttpResponseSnapshot {
  return httpSnapshot(body, status, 'text/html; charset=utf-8');
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

export function htmlResponse(body = '<!doctype html><html><body>nope</body></html>', status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

export const testSettings = DEFAULT_SETTINGS;
export const samplePostIds = MOCK_POSTS.map((post) => post.id);
