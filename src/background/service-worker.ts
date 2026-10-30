/**
 * MV3 background service worker.
 *
 * Responsibilities:
 *  - own every network request (the extension has host permissions, pages do not)
 *  - own stored credentials (the UI only ever receives masked views)
 *  - answer UI/content-script messages through the shared router
 *  - keep declarativeNetRequest User-Agent rules in sync with saved servers
 *
 * No credential is ever logged: only counts, ids and redacted URLs appear below.
 */
import { registerBuiltinAdapters } from '../adapters/index.js';
import { BooruClient } from '../core/client.js';
import { ChromeDownloader, PawchivePacedDownloader } from '../core/downloads.js';
import type { UiRequest } from '../core/messages.js';
import { DownloadHistoryStore, SearchHistoryStore } from '../core/history.js';
import { MirrorLinkStore } from '../core/link-store.js';
import { TaskStore } from '../core/task-store.js';
import { DownloadQueue } from '../core/queue.js';
import { createRouter } from '../core/router.js';
import { ServerStore } from '../core/servers.js';
import { SettingsStore } from '../core/settings.js';
import { ChromeStorageArea, migrateStorage, STORAGE_KEYS } from '../core/storage.js';
import { syncUserAgentRules } from '../core/userAgent.js';
import { ValidationService } from '../core/validation.js';
import { HttpClient } from '../shared/http.js';

registerBuiltinAdapters();

const VERSION = globalThis.chrome?.runtime?.getManifest?.().version ?? '0.2.0';
const POPUP_PATH = 'popup/popup.html';
const PANEL_PATH = 'panel/panel.html';
const area = new ChromeStorageArea();
const settings = new SettingsStore(area);
const servers = new ServerStore(area);
const http = new HttpClient({ maxRetries: 3 });
const validation = new ValidationService(http);
const client = new BooruClient({ servers, settings, http, validation });
const downloader = new PawchivePacedDownloader(new ChromeDownloader());
const history = new DownloadHistoryStore(area);
const searches = new SearchHistoryStore(area);
const links = new MirrorLinkStore(area);
const tasks = new TaskStore(area);
const queue = new DownloadQueue({ storage: area, client, servers, settings, downloader, history, links, tasks });

// MV3 listeners must be registered synchronously on every worker startup. The
// ID is persisted by the queue; a search after registration closes the race in
// which Chrome finishes before the start callback returns or storage is written.
globalThis.chrome?.downloads?.onChanged?.addListener((delta) => {
  void queue.handleDownloadChanged(delta.id).catch(() => console.warn('[booru] download reconciliation failed; it will be retried.'));
});
globalThis.chrome?.downloads?.onErased?.addListener((id) => {
  void queue.handleDownloadChanged(id).catch(() => console.warn('[booru] erased download reconciliation failed; it will be retried.'));
});
void queue.recover().catch(() => console.warn('[booru] queue recovery failed; open the queue to retry.'));

const handle = createRouter({
  client,
  queue,
  servers,
  settings,
  downloader,
  syncUserAgentRules,
  storage: area,
  history,
  searches,
  links,
  tasks,
  environment: 'extension',
  version: VERSION,
});

/**
 * Decide what a toolbar click opens (Settings → "Toolbar click opens").
 *
 * `sidepanel` (default) clears the popup and lets Chrome open the docked panel
 * (`openPanelOnActionClick`); `popup` restores the classic popup page - and, on
 * browsers without the sidePanel API, that is the only option that works.
 */
async function applyUiMode(reason: string): Promise<void> {
  const current = await settings.get();
  const wantsPanel = current.uiMode !== 'popup';
  const sidePanel = globalThis.chrome?.sidePanel;
  const action = globalThis.chrome?.action;
  const panelAvailable = typeof sidePanel?.setPanelBehavior === 'function';
  const usePanel = wantsPanel && panelAvailable;
  try {
    if (panelAvailable) {
      await sidePanel!.setPanelBehavior({ openPanelOnActionClick: usePanel });
      // Make sure the panel is usable again even if a previous profile disabled
      // it (or the path changed between versions).
      await sidePanel!.setOptions?.({ path: PANEL_PATH, enabled: true });
    }
  } catch (error) {
    console.warn('[booru] side panel behaviour could not be set:', error instanceof Error ? error.message : String(error));
  }
  try {
    await action?.setPopup?.({ popup: usePanel ? '' : POPUP_PATH });
  } catch (error) {
    console.warn('[booru] action popup could not be set:', error instanceof Error ? error.message : String(error));
  }
  console.info(`[booru] toolbar opens ${usePanel ? 'the side panel' : 'the popup'} (${reason})`);
}

async function refreshUserAgentRules(reason: string): Promise<void> {
  try {
    const [currentSettings, currentServers] = await Promise.all([settings.get(), servers.list()]);
    const result = await syncUserAgentRules(currentServers, currentSettings);
    console.info(
      `[booru] User-Agent rules ${result.ok ? 'synced' : 'failed'} (${result.applied} rule(s), reason: ${reason})${
        result.error ? `: ${result.error}` : ''
      }`,
    );
  } catch (error) {
    console.warn('[booru] User-Agent rule sync threw:', error instanceof Error ? error.message : String(error));
  }
}

globalThis.chrome?.runtime?.onInstalled?.addListener((details) => {
  void (async () => {
    await migrateStorage(area);
    await applyUiMode(`install:${details.reason}`);
    await refreshUserAgentRules(`install:${details.reason}`);
    const count = await servers.count();
    console.info(`[booru] Booru Server Manager ${VERSION} ready - ${count} saved server profile(s)`);
  })();
});

globalThis.chrome?.runtime?.onStartup?.addListener(() => {
  void (async () => {
    await applyUiMode('startup');
    await refreshUserAgentRules('startup');
  })();
});

// The worker starts cold for every message burst, so re-apply the stored choice
// on load: a `popup`-mode profile must not lose its popup after a restart.
void applyUiMode('worker-start');

// Another context wrote settings/servers: drop caches so the worker re-reads them.
globalThis.chrome?.storage?.onChanged?.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (STORAGE_KEYS.servers in changes) servers.invalidate();
  if (STORAGE_KEYS.settings in changes) settings.invalidate();
  if (STORAGE_KEYS.history in changes) history.invalidate();
  if (STORAGE_KEYS.searches in changes) searches.invalidate();
  if (STORAGE_KEYS.settings in changes) {
    const next = changes[STORAGE_KEYS.settings]?.newValue as { uiMode?: string } | undefined;
    if (next?.uiMode) void applyUiMode('settings-change');
  }
});

globalThis.chrome?.runtime?.onMessage?.addListener((message, _sender, sendResponse) => {
  const request = message as UiRequest;
  if (!request || typeof request !== 'object' || typeof (request as { type?: unknown }).type !== 'string') {
    return false;
  }
  void handle(request).then(sendResponse);
  return true; // keep the message channel open for the async response
});

// Re-sync rules whenever the saved server list changes (worker-side writes).
servers.onChange((list) => {
  void (async () => {
    const currentSettings = await settings.get();
    await syncUserAgentRules(list, currentSettings);
  })();
});
