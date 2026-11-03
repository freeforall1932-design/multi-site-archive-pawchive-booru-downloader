/**
 * Content script: adds a small floating "download with Booru Manager" button on
 * recognized booru post pages. Runs only on hosts the manifest matches, and only
 * when the setting is enabled. All privileged work happens in the worker.
 */
import type { UiRequest } from '../core/messages.js';
import type { RouteMatch, ServerConfigView } from '../shared/types.js';

const HOST_ID = 'booru-server-manager-button';

async function send<T>(request: UiRequest): Promise<T | null> {
  try {
    const response = (await globalThis.chrome.runtime.sendMessage(request)) as
      | { ok: true; data: T }
      | { ok: false; error: { message: string } };
    if (!response || !response.ok) return null;
    return response.data;
  } catch {
    return null;
  }
}

function mount(route: RouteMatch & { server: ServerConfigView | null }): void {
  if (document.getElementById(HOST_ID)) return;
  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483647;';
  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = `
    button {
      display: inline-flex; align-items: center; gap: 8px;
      font: 600 13px/1 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      color: #fff; background: linear-gradient(135deg,#4b6bff,#7b4bff);
      border: 0; border-radius: 999px; padding: 11px 16px; cursor: pointer;
      box-shadow: 0 8px 22px rgba(20,20,60,.35);
    }
    button[disabled] { opacity: .7; cursor: default; }
    .status { margin-top: 6px; font: 12px/1.4 system-ui, sans-serif; color: #fff;
      background: rgba(12,14,22,.86); border-radius: 8px; padding: 6px 10px; max-width: 280px; }
  `;

  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = route.siteType === 'pawchive' ? '⬇ Download first file' : '⬇ Download with Booru Manager';
  if (route.siteType === 'pawchive') button.title = 'For every attachment, open the side panel and choose Add all available files.';

  const status = document.createElement('div');
  status.className = 'status';
  status.hidden = true;

  button.addEventListener('click', async () => {
    button.disabled = true;
    button.textContent = 'Downloading…';
    try {
      const response = (await globalThis.chrome.runtime.sendMessage({
        type: 'posts/download',
        payload: { serverId: route.server?.id ?? null, url: location.href },
      } satisfies UiRequest)) as { ok: boolean; data?: { filename: string; post?: { fileAvailability?: string } }; error?: { message: string; hint?: string | null } } | undefined;
      if (response?.ok) {
        button.textContent = '⬇ Download again';
        showStatus(`Started original file: ${response.data?.filename ?? 'file'}. Check browser Downloads for completion.`);
      } else if (response) {
        button.textContent = '⬇ Retry download';
        showStatus(`${response.error?.message ?? 'Download failed'}${response.error?.hint ? ` - ${response.error.hint}` : ''}`);
      } else {
        button.textContent = '⬇ Check download';
        showStatus('No response from the extension. Check the queue and Chrome Downloads before trying again.');
      }
    } catch {
      // A closed message channel may occur after Chrome started the transfer.
      // Do not replay it automatically or claim it failed.
      button.textContent = '⬇ Check download';
      showStatus('The extension did not confirm the request. Check the queue and Chrome Downloads before trying again.');
    } finally {
      button.disabled = false;
    }
  });

  function showStatus(text: string): void {
    status.textContent = text;
    status.hidden = false;
    setTimeout(() => {
      status.hidden = true;
    }, 8000);
  }

  shadow.append(style, button, status);
  document.body.appendChild(host);
}

async function boot(): Promise<void> {
  const settings = await send<{ enableContentScriptButton: boolean }>({ type: 'settings/get' });
  if (settings && settings.enableContentScriptButton === false) return;

  const route = await send<RouteMatch & { server: ServerConfigView | null }>({ type: 'routes/detect', payload: { url: location.href } });
  if (!route || route.kind !== 'post' || !route.postId) return;
  mount(route);
}

void boot();
