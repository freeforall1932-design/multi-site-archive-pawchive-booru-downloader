import { ChromeDownloader } from '../core/downloads.js';
import { redactUrlsInText } from '../shared/util.js';
import type { RouterResponse, UiRequest } from '../core/messages.js';
import { ChromeStorageArea } from '../core/storage.js';
import { syncUserAgentRules } from '../core/userAgent.js';
import type { Platform } from './types.js';

function runtimeAvailable(): boolean {
  return typeof globalThis.chrome !== 'undefined' && !!globalThis.chrome?.runtime?.id;
}

// A lost response does not prove the worker failed to execute a request. Only
// repeat read-like operations; replaying a start, import or mutation can create
// duplicate downloads or other side effects.
const RETRYABLE_READS = new Set<UiRequest['type']>([
  'servers/list', 'servers/export', 'browse/search', 'posts/get', 'posts/thumbnail', 'posts/resolveUrl', 'routes/detect',
  'links/list', 'links/posts', 'links/export', 'tasks/list', 'tasks/export', 'queue/list', 'history/list',
  'searches/list', 'settings/get',
]);

function uncertainResponse(request: UiRequest): RouterResponse {
  return {
    ok: false,
    error: {
      message: 'The background worker did not confirm the request; it may already have finished.',
      kind: 'unknown',
      hint: RETRYABLE_READS.has(request.type)
        ? 'Refresh and try again.'
        : 'Check the current state and, for downloads, the queue and Chrome Downloads before retrying.',
    },
  };
}

/** Chrome MV3 implementation. API actions use the worker; UI images can load remotely. */
export class ExtensionPlatform implements Platform {
  readonly environment = 'extension' as const;
  readonly storage = new ChromeStorageArea();
  readonly downloader = new ChromeDownloader();
  readonly permissions = {
    contains: async (origin: string): Promise<boolean> => {
      if (!globalThis.chrome?.permissions) return false;
      try {
        return await globalThis.chrome.permissions.contains({ origins: [`${origin}/*`] });
      } catch {
        return false;
      }
    },
    request: async (origin: string): Promise<boolean> => {
      if (!globalThis.chrome?.permissions) return false;
      try {
        return await globalThis.chrome.permissions.request({ origins: [`${origin}/*`] });
      } catch {
        return false;
      }
    },
  };

  async send(request: UiRequest): Promise<RouterResponse> {
    if (!runtimeAvailable()) {
      return { ok: false, error: { message: 'Extension runtime unavailable', kind: 'unknown', hint: null } };
    }
    try {
      const response = (await globalThis.chrome.runtime.sendMessage(request)) as RouterResponse | undefined;
      return response ?? uncertainResponse(request);
    } catch (error) {
      const message = redactUrlsInText(error instanceof Error ? error.message : String(error));
      if (/Receiving end does not exist|message port closed/i.test(message)) {
        if (RETRYABLE_READS.has(request.type)) {
          try {
            const retry = (await globalThis.chrome.runtime.sendMessage(request)) as RouterResponse | undefined;
            if (retry) return retry;
          } catch {
            /* The read still failed; report the uncertain result below. */
          }
        }
        return uncertainResponse(request);
      }
      if (!RETRYABLE_READS.has(request.type)) return uncertainResponse(request);
      return { ok: false, error: { message: `Background worker error: ${message}`, kind: 'unknown', hint: null } };
    }
  }

  async syncUserAgentRules(servers: Parameters<typeof syncUserAgentRules>[0], settings: Parameters<typeof syncUserAgentRules>[1]) {
    return syncUserAgentRules(servers, settings);
  }

  async activeTabUrl(): Promise<string | null> {
    if (!globalThis.chrome?.tabs) return null;
    try {
      const [tab] = await globalThis.chrome.tabs.query({ active: true, lastFocusedWindow: true });
      return tab?.url ?? null;
    } catch {
      return null;
    }
  }

  openOptions(hash?: string): void {
    const suffix = hash ? `#${hash.replace(/^#/, '')}` : '';
    const runtime = globalThis.chrome?.runtime;
    const tabs = globalThis.chrome?.tabs;
    if (suffix && runtime?.getURL && tabs?.create) {
      // Create the requested deep link directly: openOptionsPage followed by a
      // tab query races creation and can append a second hash to an existing URL.
      const url = `${runtime.getURL('options/options.html')}${suffix}`;
      void (async () => {
        try { await tabs.create({ url }); }
        catch { await runtime.openOptionsPage?.().catch(() => undefined); }
      })();
      return;
    }
    if (runtime?.openOptionsPage) {
      void runtime.openOptionsPage().catch(() => undefined);
      return;
    }
    if (suffix) globalThis.location.hash = suffix;
  }

  /**
   * Open the docked side panel. Chrome only allows this from a user gesture
   * (toolbar click, popup button, options-page link); the toolbar path is handled
   * by `openPanelOnActionClick` in the worker instead.
   */
  async openPanel(): Promise<boolean> {
    const sidePanel = globalThis.chrome?.sidePanel;
    if (!sidePanel?.open) return false;
    try {
      const [tab] = await globalThis.chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (tab?.windowId !== undefined) {
        await sidePanel.open({ windowId: tab.windowId });
        return true;
      }
      if (tab?.id !== undefined) {
        await sidePanel.open({ tabId: tab.id });
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  async describeEnvironment(): Promise<Record<string, string>> {
    return {
      'Manifest version': String(globalThis.chrome?.runtime?.getManifest?.().manifest_version ?? 'unknown'),
      'Extension version': String(globalThis.chrome?.runtime?.getManifest?.().version ?? 'unknown'),
      'Docked side panel': globalThis.chrome?.sidePanel ? 'available' : 'unavailable',
      'User-Agent rewriting': globalThis.chrome?.declarativeNetRequest ? 'available' : 'unavailable',
      'Native downloads': globalThis.chrome?.downloads ? 'available' : 'unavailable',
    };
  }
}
