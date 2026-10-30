/**
 * Options page shell: navigation + state for the server manager, browse, queue,
 * settings and diagnostics views.
 *
 * The page never talks to a booru directly and never sees a stored secret - it
 * renders masked views and sends `UiRequest`s to the background worker.
 */
import { registerBuiltinAdapters } from '../adapters/index.js';
import type { AdapterCatalogEntry, DiagnosticsInfo, EnqueueCandidate, UiRequest } from '../core/messages.js';
import { getAdapter } from '../core/registry.js';
import { isUsableServer } from '../core/servers.js';
import { getPlatform, isExtensionEnvironment } from '../platform/index.js';
import type {
  BooruPost,
  ExtensionSettings,
  QueueItem,
  QueueSummary,
  SearchResult,
  ServerConfigView,
  ValidationResult,
} from '../shared/types.js';
import { h, clear, button } from '../ui/dom.js';
import { renderBrowse, type BrowseState } from '../ui/browse.js';
import { renderDiagnostics, copyDiagnostics } from '../ui/diagnostics-view.js';
import { renderQueue, type QueueState } from '../ui/queue-view.js';
import { renderServerForm, draftForSiteType, draftFromServer, type ServerFormDraft, type ServerFormState } from '../ui/server-form.js';
import { renderServerList, type ServerListState } from '../ui/server-list.js';
import { renderSettings, type SettingsState } from '../ui/settings-view.js';
import { showError, toast } from '../ui/toast.js';

export type ViewName = 'servers' | 'browse' | 'queue' | 'settings' | 'diagnostics' | 'editor';

interface AppState {
  view: ViewName;
  servers: ServerConfigView[];
  adapters: AdapterCatalogEntry[];
  settings: ExtensionSettings | null;
  busyId: string | null;
  editor: {
    draft: ServerFormDraft;
    isNew: boolean;
    apiKeyMask: string;
    validation: ValidationResult | null;
    validating: boolean;
    saving: boolean;
    validatedSignature: string | null;
  } | null;
  listFilter: string;
  browse: {
    serverId: string | null;
    tags: string;
    limit: number;
    page: number;
    posts: BooruPost[];
    results: SearchResult | null;
    selection: Set<string>;
    busy: boolean;
    error: { message: string; kind: string; hint: string | null } | null;
    overrideRatingFilter: boolean | null;
  };
  queue: { summary: QueueSummary; items: QueueItem[]; maxConcurrency: number; busy: boolean };
  diagnostics: DiagnosticsInfo | null;
  hostAccess: { origin: string; granted: boolean } | null;
  settingsDraft: ExtensionSettings | null;
  settingsSaving: boolean;
  historyCount: number;
  searchCount: number;
}

const platform = getPlatform();
const root = document.getElementById('view') as HTMLElement;
const toastHost = document.getElementById('toast-anchor');

const state: AppState = {
  view: 'servers',
  servers: [],
  adapters: [],
  settings: null,
  busyId: null,
  editor: null,
  listFilter: '',
  browse: {
    serverId: null,
    tags: '',
    limit: 25,
    page: 1,
    posts: [],
    results: null,
    selection: new Set(),
    busy: false,
    error: null,
    overrideRatingFilter: null,
  },
  queue: { summary: emptySummary(), items: [], maxConcurrency: 2, busy: false },
  diagnostics: null,
  hostAccess: null,
  settingsDraft: null,
  settingsSaving: false,
  historyCount: 0,
  searchCount: 0,
};

function emptySummary(): QueueSummary {
  return { pending: 0, running: 0, done: 0, failed: 0, skipped: 0, canceled: 0, unverified: 0, total: 0, paused: false, active: false };
}

// ------------------------------------------------------------------ messaging

async function send<T>(request: UiRequest): Promise<T | null> {
  const response = await platform.send(request);
  if (!response.ok) {
    showError(response.error);
    return null;
  }
  return response.data as T;
}

async function sendOrToast<T>(request: UiRequest, successMessage?: string): Promise<T | null> {
  const data = await send<T>(request);
  if (data !== null && successMessage) toast(successMessage, 'success');
  return data;
}

// --------------------------------------------------------------------- router

function navigate(view: ViewName, options: { replaceHash?: boolean } = {}): void {
  state.view = view;
  if (!options.replaceHash) {
    const hash = view === 'editor' ? 'editor' : view;
    if (globalThis.location.hash.replace('#', '') !== hash) globalThis.location.hash = hash;
  }
  renderNav();
  void render();
}

function viewFromHash(): ViewName {
  const hash = globalThis.location.hash.replace('#', '') || 'servers';
  const known: ViewName[] = ['servers', 'browse', 'queue', 'settings', 'diagnostics', 'editor'];
  return (known.includes(hash as ViewName) ? hash : 'servers') as ViewName;
}

function renderNav(): void {
  const nav = document.getElementById('nav') as HTMLElement;
  clear(nav);
  const items: Array<{ view: ViewName; label: string; iconName: string }> = [
    { view: 'servers', label: 'Servers', iconName: 'servers' },
    { view: 'browse', label: 'Browse', iconName: 'search' },
    { view: 'queue', label: 'Queue', iconName: 'queue' },
    { view: 'settings', label: 'Settings', iconName: 'settings' },
    { view: 'diagnostics', label: 'Diagnostics', iconName: 'info' },
  ];
  // One extra row: everything the options page does is also available in the
  // docked panel, which is what the toolbar opens by default.
  nav.appendChild(
    h(
      'button',
      {
        class: 'nav-item nav-item-panel',
        type: 'button',
        title: 'Open the docked side panel (Settings → "Toolbar click opens")',
        onClick: () => {
          void platform.openPanel().then((opened) => {
            if (!opened) toast('The browser did not open a side panel; switching the toolbar to popup mode is the fallback.', 'warning', 6000);
          });
        },
      },
      h('span', { class: 'nav-label', text: 'Open side panel' }),
    ),
  );

  for (const item of items) {
    const active = state.view === item.view || (state.view === 'editor' && item.view === 'servers');
    nav.appendChild(
      h(
        'button',
        {
          class: `nav-item${active ? ' is-active' : ''}`,
          type: 'button',
          onClick: () => navigate(item.view),
        },
        h('span', { class: 'nav-label', text: item.label }),
        item.view === 'queue' && state.queue.summary.pending + state.queue.summary.running > 0
          ? h('span', { class: 'badge', text: String(state.queue.summary.pending + state.queue.summary.running) })
          : null,
      ),
    );
  }
}

// --------------------------------------------------------------------- render

async function render(): Promise<void> {
  root.replaceChildren();
  switch (state.view) {
    case 'servers':
      return renderServers();
    case 'editor':
      return renderEditor();
    case 'browse':
      return renderBrowseView();
    case 'queue':
      return renderQueueView();
    case 'settings':
      return renderSettingsView();
    case 'diagnostics':
      return renderDiagnosticsView();
    default:
      return undefined;
  }
}

function renderServers(): void {
  const listState: ServerListState = {
    servers: state.servers,
    adapters: state.adapters,
    busyId: state.busyId,
    filter: state.listFilter,
  };
  renderServerList(root, listState, {
    onAdd: (siteType) => openEditor(null, siteType),
    onEdit: (server) => openEditor(server),
    onDuplicate: async (server) => {
      const created = await sendOrToast<ServerConfigView>({ type: 'servers/duplicate', payload: { id: server.id } }, 'Server duplicated');
      if (created) await refreshServers();
    },
    onDelete: async (server) => {
      if (!globalThis.confirm(`Delete "${server.label}" and its stored credentials?`)) return;
      const remaining = await sendOrToast<ServerConfigView[]>({ type: 'servers/remove', payload: { id: server.id } }, 'Server deleted');
      if (remaining) {
        state.servers = remaining;
        const supported = remaining.filter(isUsableServer);
        state.browse.serverId = supported.find((entry) => entry.isDefault)?.id ?? supported[0]?.id ?? null;
        renderNav();
        await render();
      }
    },
    onSetDefault: async (server) => {
      const updated = await sendOrToast<ServerConfigView[]>({ type: 'servers/setDefault', payload: { id: server.id } }, `${server.label} is now the default server`);
      if (updated) {
        state.servers = updated;
        state.browse.serverId = server.id;
        await render();
      }
    },
    onTest: async (server) => {
      state.busyId = server.id;
      renderServers();
      const result = await send<ValidationResult>({ type: 'servers/validate', payload: { id: server.id } });
      state.busyId = null;
      if (result) {
        toast(
          result.ok ? `${server.label}: ${result.message}` : `${server.label}: ${result.message}`,
          result.ok ? 'success' : 'error',
          6000,
        );
      }
      await refreshServers();
    },
    onFilterChange: (value) => {
      state.listFilter = value;
      renderServers();
    },
    onOpenQueue: () => navigate('queue'),
  });
}

function renderEditor(): void {
  const editor = state.editor;
  if (!editor) {
    void navigate('servers');
    return;
  }
  const adapter = getAdapter(editor.draft.siteType);
  const formState: ServerFormState = {
    draft: editor.draft,
    adapters: state.adapters,
    credentialFields: adapter ? adapter.credentialFields(editor.draft) : [],
    isNew: editor.isNew,
    apiKeyMask: editor.apiKeyMask,
    suggestedUserAgent: adapter
      ? adapter.suggestUserAgent({
          server: { username: editor.draft.username, userId: editor.draft.userId, customUserAgent: editor.draft.customUserAgent },
          baseUrl: editor.draft.baseUrl,
        })
      : '',
    validation: editor.validation,
    validating: editor.validating,
    validatedCurrentValues: signature(editor.draft) === editor.validatedSignature,
    saving: editor.saving,
  };
  renderServerForm(root, formState, {
    onChange: (patch) => {
      const previousSiteType = editor.draft.siteType;
      Object.assign(editor.draft, patch);
      if (patch.siteType && patch.siteType !== previousSiteType) {
        const next = state.adapters.find((entry) => entry.siteType === patch.siteType);
        editor.draft.baseUrl = next?.baseUrl ?? '';
        editor.draft.label = next?.displayName ?? patch.siteType;
        editor.draft.allowedRatings = next?.defaultRatings ?? [];
        editor.draft.ratingFilterEnabled = next?.supportsRatingFilter ?? true;
        editor.draft.customUserAgent = '';
        editor.draft.username = '';
        editor.draft.userId = '';
        editor.draft.apiKey = '';
      }
      renderEditor();
    },
    onValidate: async () => {
      editor.validating = true;
      editor.validation = null;
      renderEditor();
      const result = await send<ValidationResult>({
        type: 'servers/validateDraft',
        payload: { server: { ...editor.draft, ...(editor.isNew ? {} : { id: editor.draft.id }) } },
      });
      editor.validating = false;
      if (result) {
        editor.validation = result;
        editor.validatedSignature = signature(editor.draft);
        toast(result.ok ? 'Validation succeeded' : `Validation failed: ${result.message}`, result.ok ? 'success' : 'error', 6000);
      }
      renderEditor();
    },
    onSave: async ({ force }) => {
      if (!editor.isNew && !editor.validation && !force) {
        // "Validation must happen before or during save": run it automatically.
        editor.validating = true;
        renderEditor();
        const result = await send<ValidationResult>({
          type: 'servers/validateDraft',
          payload: { server: { ...editor.draft, id: editor.draft.id } },
        });
        editor.validating = false;
        if (result) {
          editor.validation = result;
          editor.validatedSignature = signature(editor.draft);
        }
        renderEditor();
        if (result && !result.ok) {
          toast('Saved nothing yet - validation failed. Use "Save anyway" to store it regardless.', 'warning', 6000);
          return;
        }
      }
      editor.saving = true;
      renderEditor();
      const saved = await send<ServerConfigView>({
        type: 'servers/save',
        payload: {
          ...editor.draft,
          ...(editor.isNew ? {} : { id: editor.draft.id }),
        },
      });
      editor.saving = false;
      if (saved) {
        toast(`Saved ${saved.label}`, 'success');
        await refreshServers();
        navigate('servers');
      } else {
        renderEditor();
      }
    },
    onCancel: () => {
      state.editor = null;
      navigate('servers');
    },
    onSuggestUserAgent: () => {
      const adapterForUa = getAdapter(editor.draft.siteType);
      if (!adapterForUa) return;
      editor.draft.customUserAgent = adapterForUa.suggestUserAgent({
        server: { username: editor.draft.username, userId: editor.draft.userId, customUserAgent: '' },
        baseUrl: editor.draft.baseUrl,
      });
      renderEditor();
    },
    onBackToList: () => {
      state.editor = null;
      navigate('servers');
    },
  });
}

function renderBrowseView(): void {
  const browseState: BrowseState = {
    servers: state.servers.filter(isUsableServer),
    adapters: state.adapters,
    serverId: state.browse.serverId,
    tags: state.browse.tags,
    limit: state.browse.limit,
    overrideRatingFilter: state.browse.overrideRatingFilter,
    results: state.browse.results,
    posts: state.browse.posts,
    selection: state.browse.selection,
    busy: state.browse.busy,
    error: state.browse.error,
    page: state.browse.page,
    queueCount: state.queue.summary.total,
  };
  renderBrowse(root, browseState, {
    onServerChange: (id) => {
      state.browse.serverId = id;
      state.browse.overrideRatingFilter = null;
      renderBrowseView();
    },
    onTagsChange: (tags) => {
      state.browse.tags = tags;
    },
    onLimitChange: (limit) => {
      state.browse.limit = limit;
      renderBrowseView();
    },
    onToggleRatingOverride: () => {
      const server = state.servers.find((entry) => entry.id === state.browse.serverId);
      const current = state.browse.overrideRatingFilter ?? server?.ratingFilterEnabled ?? false;
      state.browse.overrideRatingFilter = !current;
      renderBrowseView();
    },
    onSearch: (reset) => void runSearch(reset),
    onLoadMore: () => void runSearch(false),
    onToggleSelect: (postId) => {
      if (state.browse.selection.has(postId)) state.browse.selection.delete(postId);
      else state.browse.selection.add(postId);
      renderBrowseView();
    },
    onSelectAll: () => {
      state.browse.posts.forEach((post) => state.browse.selection.add(post.id));
      renderBrowseView();
    },
    onClearSelection: () => {
      state.browse.selection.clear();
      renderBrowseView();
    },
    onDownloadPost: async (post) => {
      const server = state.servers.find((entry) => entry.id === state.browse.serverId);
      const result = await send<{ filename: string; post: BooruPost }>({
        type: 'posts/download',
        payload: { serverId: server?.id ?? null, postId: post.id },
      });
      if (result) {
        toast(`Started original file download: ${result.filename}`, 'success');
      }
    },
    onQueueSelected: async () => {
      const server = state.servers.find((entry) => entry.id === state.browse.serverId);
      if (!server) return;
      const candidates: EnqueueCandidate[] = state.browse.posts
        .filter((post) => state.browse.selection.has(post.id))
        .map((post) => ({ id: post.id, label: `${post.siteType} #${post.id}${post.fileAvailability === 'preview' ? ' [preview only]' : ''}`, postUrl: post.postUrl, rating: post.rating, expectedFileHash: post.siteType === 'pawchive' ? post.md5 : null }));
      const result = await send<{ added: number; skipped: number; summary: QueueSummary }>({
        type: 'queue/enqueuePosts',
        payload: { serverId: server.id, posts: candidates },
      });
      if (result) {
        state.queue.summary = result.summary;
        state.browse.selection.clear();
        toast(`Queued ${result.added} post(s)${result.skipped ? `, ${result.skipped} skipped` : ''}`, 'success');
        await refreshQueue();
        renderNav();
        renderBrowseView();
      }
    },
    onQueueAll: async () => {
      const server = state.servers.find((entry) => entry.id === state.browse.serverId);
      if (!server) return;
      const candidates: EnqueueCandidate[] = state.browse.posts.map((post) => ({
        id: post.id,
        label: `${post.siteType} #${post.id}${post.fileAvailability === 'preview' ? ' [preview only]' : ''}`,
        postUrl: post.postUrl,
        rating: post.rating,
        expectedFileHash: post.siteType === 'pawchive' ? post.md5 : null,
      }));
      const result = await send<{ added: number; skipped: number; summary: QueueSummary }>({
        type: 'queue/enqueuePosts',
        payload: { serverId: server.id, posts: candidates },
      });
      if (result) {
        state.queue.summary = result.summary;
        toast(`Queued ${result.added} post(s)${result.skipped ? `, ${result.skipped} skipped by rating filter` : ''}`, 'success');
        await refreshQueue();
        renderNav();
        renderBrowseView();
      }
    },
    onOpenQueue: () => navigate('queue'),
    onQuickTag: (tag) => {
      state.browse.tags = [state.browse.tags.trim(), tag].filter(Boolean).join(' ');
      renderBrowseView();
    },
  });
}

async function runSearch(reset: boolean): Promise<void> {
  const server = state.servers.find((entry) => entry.id === state.browse.serverId) ?? state.servers.find((entry) => entry.isDefault);
  if (!server) {
    toast('Add a server first', 'warning');
    return;
  }
  state.browse.serverId = server.id;
  state.browse.busy = true;
  state.browse.error = null;
  if (reset) {
    state.browse.page = 1;
    state.browse.posts = [];
    state.browse.selection.clear();
  }
  renderBrowseView();

  const response = await platform.send({
    type: 'browse/search',
    payload: {
      serverId: server.id,
      spec: {
        tags: state.browse.tags,
        limit: state.browse.limit,
        page: state.browse.page,
        ...(state.browse.overrideRatingFilter === null ? {} : { ratingFilter: { enabled: state.browse.overrideRatingFilter, allowed: server.allowedRatings ?? [] } }),
      },
    },
  });
  state.browse.busy = false;
  if (!response.ok) {
    state.browse.error = response.error;
    renderBrowseView();
    return;
  }
  const result = response.data as SearchResult;
  state.browse.results = result;
  state.browse.posts = reset ? result.posts : [...state.browse.posts, ...result.posts];
  state.browse.page = reset ? 2 : state.browse.page + 1;
  renderBrowseView();
}

function renderQueueView(): void {
  const queueState: QueueState = {
    summary: state.queue.summary,
    items: state.queue.items,
    servers: state.servers,
    maxConcurrency: state.queue.maxConcurrency,
    busy: state.queue.busy,
  };
  renderQueue(root, queueState, {
    onRun: async () => {
      await send({ type: 'queue/run' });
      await refreshQueue();
    },
    onPause: async () => {
      await send({ type: 'queue/pause' });
      await refreshQueue();
    },
    onResume: async () => {
      await send({ type: 'queue/resume' });
      await refreshQueue();
    },
    onRetryFailed: async () => {
      if (state.queue.summary.unverified && !globalThis.confirm('Some earlier starts are unverified and may already be on disk. Check Chrome Downloads before retrying. Continue?')) return;
      const result = await sendOrToast<{ requeued: number }>({ type: 'queue/retryFailed' }, 'Failed or unverified items requeued');
      if (result) await refreshQueue();
    },
    onClear: async (scope) => {
      if (scope === 'all' && !globalThis.confirm('Remove inactive queue rows? Active transfers remain tracked.')) return;
      await send({ type: 'queue/clear', payload: { scope } });
      await refreshQueue();
    },
    onCancel: async (itemId) => {
      await send({ type: 'queue/cancel', payload: { itemId } });
      await refreshQueue();
    },
  });
}

function renderSettingsView(): void {
  if (!state.settings) return;
  void refreshHistoryCounts();
  const settingsState: SettingsState = {
    settings: state.settingsDraft ?? state.settings,
    saving: state.settingsSaving,
    hostAccess: state.hostAccess,
    servers: state.servers,
    adapters: state.adapters,
    historyCount: state.historyCount,
    searchCount: state.searchCount,
  };
  renderSettings(root, settingsState, {
    onChange: (patch) => {
      state.settingsDraft = { ...(state.settingsDraft ?? state.settings!), ...patch };
      renderSettingsView();
    },
    onSave: async () => {
      const draft = state.settingsDraft;
      if (!draft) return;
      state.settingsSaving = true;
      renderSettingsView();
      const saved = await send<ExtensionSettings>({ type: 'settings/save', payload: draft });
      state.settingsSaving = false;
      if (saved) {
        state.settings = saved;
        state.settingsDraft = null;
        toast('Settings saved', 'success');
      }
      renderSettingsView();
    },
    onReset: async () => {
      const saved = await send<ExtensionSettings>({ type: 'settings/reset' });
      if (saved) {
        state.settings = saved;
        state.settingsDraft = null;
        toast('Settings reset to defaults', 'success');
      }
      renderSettingsView();
    },
    onExport: async (includeSecrets) => {
      if (includeSecrets && !globalThis.confirm('Export INCLUDING API keys to a plain file? Keep it safe.')) return;
      const result = await send<{ json: string; includesSecrets: boolean }>({ type: 'servers/export', payload: { includeSecrets } });
      if (!result) return;
      const blob = new Blob([result.json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = h('a', { href: url, attrs: { download: `booru-servers-${includeSecrets ? 'with-keys' : 'safe'}.json` } });
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      toast(`Exported ${includeSecrets ? 'with' : 'without'} API keys`, 'success');
    },
    onImport: async (json, includeSecrets) => {
      const result = await send<{ imported: number; skipped: number; errors: string[] }>({
        type: 'servers/import',
        payload: { json, includeSecrets },
      });
      if (result) {
        toast(`Imported ${result.imported} server(s), skipped ${result.skipped}`, result.errors.length ? 'warning' : 'success');
        await refreshServers();
        renderSettingsView();
      }
    },
    onClearAllCredentials: async () => {
      if (!globalThis.confirm('Delete the stored API key of every saved server?')) return;
      for (const server of state.servers) {
        await send({ type: 'servers/clearCredentials', payload: { id: server.id } });
      }
      await refreshServers();
      toast('Stored credentials deleted', 'success');
      renderSettingsView();
    },
    onRequestHostAccess: async () => {
      if (!state.hostAccess) return;
      const granted = await platform.permissions.request(state.hostAccess.origin);
      state.hostAccess = { ...state.hostAccess, granted };
      renderSettingsView();
      toast(granted ? 'Host access granted' : 'Host access was not granted', granted ? 'success' : 'warning');
    },
    onSyncUserAgent: async () => {
      const result = await send<{ ok: boolean; applied: number; error?: string }>({ type: 'userAgent/sync' });
      if (result) toast(result.ok ? `User-Agent rules synced (${result.applied})` : `Sync failed: ${result.error ?? 'unknown'}`, result.ok ? 'success' : 'error');
    },
    onClearHistory: async () => {
      if (!globalThis.confirm('Forget every remembered download? Posts list again afterwards; files on disk are untouched.')) return;
      const result = await send<{ removed: number }>({ type: 'history/clear' });
      state.historyCount = 0;
      toast(`Download history reset (${result?.removed ?? 0} entries)`, 'success');
      renderSettingsView();
    },
    onClearSearches: async () => {
      const result = await send<{ removed: number }>({ type: 'searches/clear' });
      state.searchCount = 0;
      toast(`Search history cleared (${result?.removed ?? 0} entries)`, 'success');
      renderSettingsView();
    },
    onOpenServers: () => navigate('servers'),
  });
}

async function renderDiagnosticsView(): Promise<void> {
  if (!state.diagnostics) {
    state.diagnostics = await send<DiagnosticsInfo>({ type: 'diagnostics/info' });
  }
  if (!state.diagnostics) return;
  renderDiagnostics(root, state.diagnostics, {
    onSyncUserAgent: async () => {
      const result = await send<{ ok: boolean; applied: number; error?: string }>({ type: 'userAgent/sync' });
      if (result) toast(result.ok ? `Synced ${result.applied} rule(s)` : `Failed: ${result.error}`, result.ok ? 'success' : 'error');
      state.diagnostics = await send<DiagnosticsInfo>({ type: 'diagnostics/info' });
      renderDiagnosticsView();
    },
    onCopy: () => {
      if (state.diagnostics) copyDiagnostics(state.diagnostics);
    },
    onOpenApiDocs: (url) => globalThis.open(url, '_blank', 'noopener'),
  });
}

// -------------------------------------------------------------------- actions

function openEditor(server: ServerConfigView | null, siteType?: string): void {
  if (server) {
    state.editor = {
      draft: draftFromServer(server),
      isNew: false,
      apiKeyMask: server.apiKeyMask,
      validation: null,
      validating: false,
      saving: false,
      validatedSignature: null,
    };
  } else {
    const defaultType = siteType ?? state.servers.find((entry) => entry.isDefault)?.siteType ?? state.adapters[0]?.siteType ?? 'e621';
    state.editor = {
      draft: draftForSiteType(defaultType, state.adapters),
      isNew: true,
      apiKeyMask: '',
      validation: null,
      validating: false,
      saving: false,
      validatedSignature: null,
    };
  }
  navigate('editor');
}

function signature(draft: ServerFormDraft): string {
  return JSON.stringify({
    siteType: draft.siteType,
    baseUrl: draft.baseUrl,
    username: draft.username,
    apiKey: draft.apiKey,
    userId: draft.userId,
    customUserAgent: draft.customUserAgent,
  });
}

async function refreshServers(): Promise<void> {
  const servers = await send<ServerConfigView[]>({ type: 'servers/list' });
  if (servers) {
    state.servers = servers;
    const supported = servers.filter(isUsableServer);
    if (!state.browse.serverId || !supported.some((entry) => entry.id === state.browse.serverId)) {
      state.browse.serverId = supported.find((entry) => entry.isDefault)?.id ?? supported[0]?.id ?? null;
    }
    let origin: string | null = null;
    try { origin = supported[0] ? new URL(supported[0].baseUrl).origin : null; } catch { /* Invalid legacy profile. */ }
    state.hostAccess = origin ? { origin, granted: await platform.permissions.contains(origin) } : null;
  }
  renderNav();
  await render();
}

async function refreshQueue(): Promise<void> {
  const result = await send<{ summary: QueueSummary; items: QueueItem[]; maxConcurrency: number }>({ type: 'queue/list' });
  if (result) {
    state.queue = { ...result, busy: false };
    renderNav();
    if (state.view === 'queue') renderQueueView();
  }
}

async function refreshHistoryCounts(): Promise<boolean> {
  const [history, searches] = await Promise.all([
    send<{ total: number }>({ type: 'history/list' }),
    send<{ entries: unknown[] }>({ type: 'searches/list' }),
  ]);
  const before = `${state.historyCount}:${state.searchCount}`;
  state.historyCount = history?.total ?? 0;
  state.searchCount = searches?.entries.length ?? 0;
  const changed = before !== `${state.historyCount}:${state.searchCount}`;
  // One extra render so the counters are accurate; the second pass finds the
  // numbers unchanged and stops, so this cannot loop.
  if (changed && state.view === 'settings') renderSettingsView();
  return changed;
}

async function refreshDiagnostics(): Promise<void> {
  state.diagnostics = await send<DiagnosticsInfo>({ type: 'diagnostics/info' });
  if (state.diagnostics) {
    state.adapters = state.diagnostics.adapters;
    if (state.view === 'diagnostics') renderDiagnosticsView();
  }
}

// ----------------------------------------------------------------------- boot

async function boot(): Promise<void> {
  if (!isExtensionEnvironment()) {
    // Preview mode: build the same service graph in-page against mock boorus.
    const { startPreview } = await import('../preview/preview.js');
    await startPreview();
  }
  registerBuiltinAdapters();
  document.documentElement.dataset.environment = platform.environment;
  if (toastHost) document.body.appendChild(toastHost);

  const [servers, settings] = await Promise.all([
    send<ServerConfigView[]>({ type: 'servers/list' }),
    send<ExtensionSettings>({ type: 'settings/get' }),
  ]);
  state.servers = servers ?? [];
  state.settings = settings;
  const supported = state.servers.filter(isUsableServer);
  state.browse.serverId = supported.find((entry) => entry.isDefault)?.id ?? supported[0]?.id ?? null;
  await refreshDiagnostics();
  if (supported.length) {
    try {
      const origin = new URL(supported[0]!.baseUrl).origin;
      state.hostAccess = { origin, granted: await platform.permissions.contains(origin) };
    } catch { /* An invalid saved URL remains available for correction. */ }
  }
  await refreshQueue();

  // Queue progress polling (cheap: one message per tick while work is pending).
  globalThis.setInterval(() => {
    if (state.queue.summary.running || state.queue.summary.pending > 0) void refreshQueue();
  }, 1500);

  globalThis.addEventListener('hashchange', () => {
    const next = viewFromHash();
    if (next !== state.view) {
      state.view = next;
      renderNav();
      void render();
    }
  });

  state.view = viewFromHash();
  renderNav();
  await render();

  if (!state.servers.length) {
    toast('Add your first server to start downloading', 'info', 6000);
  }
  if (!isExtensionEnvironment()) {
    const banner = document.getElementById('preview-banner');
    if (banner) banner.hidden = false;
  }
}

void boot();
