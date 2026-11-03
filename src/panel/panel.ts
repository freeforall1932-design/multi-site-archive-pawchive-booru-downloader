/**
 * Side panel controller.
 *
 * This is the daily-driver surface of the extension and follows the layout of the
 * sister side-panel downloaders (X Media Downloader / Rule 34 Downloader):
 *
 *   header  - product eyebrow, title, live status pill
 *   tabs    - Browse · Queue · Servers · Settings
 *   cards   - active-tab context, "this post", fetch card, list of rows
 *   dock    - fixed footer: concurrency, quality, Download selected, Pause/Stop
 *
 * The panel never talks to a booru, never sees a stored secret and never touches
 * the filesystem: it renders masked views from `servers/list` and sends
 * `UiRequest`s through the platform façade. In the preview harness the same
 * façade is backed by the offline mock booru, so the identical code path is
 * exercised without any network traffic.
 */
import { registerBuiltinAdapters } from '../adapters/index.js';
import type { AdapterCatalogEntry, DiagnosticsInfo, UiRequest } from '../core/messages.js';
import { fromToRange, parsePageRange } from '../core/pages.js';
import { composeSearchTags } from '../core/search.js';
import { getAdapter } from '../core/registry.js';
import { isUsableServer } from '../core/servers.js';
import { getPlatform, isExtensionEnvironment } from '../platform/index.js';
import type {
  BooruPost,
  DownloadHistoryEntry,
  ExtensionSettings,
  MediaFilter,
  MirrorLink,
  MirrorLinkStats,
  PanelTab,
  QueueItem,
  QueueSummary,
  RouteMatch,
  SearchResult,
  ServerConfigView,
  TaskView,
  ValidationResult,
} from '../shared/types.js';
import { safeUrl } from '../shared/util.js';
import { h, preserveInputFocus } from '../ui/dom.js';
import { OrderedUpdates } from '../ui/ordered-updates.js';
import { renderDiagnostics, copyDiagnostics } from '../ui/diagnostics-view.js';
import {
  pickFile,
  renderLinksCard,
  type LinkExportGrouping,
  type LinksState,
  type MirrorLinkRow,
  type TaskCardView,
} from '../ui/panel-links.js';
import { postMatchesMedia, renderListingCard, type ListingState } from '../ui/panel-listing.js';
import { renderPostCard, renderTabContext, type PostCardState, type TabContext } from '../ui/panel-context.js';
import { renderDock, renderQueueList, type DockState, type QueueListState, type QueueRowView } from '../ui/panel-queue.js';
import { draftForSiteType, draftFromServer, draftSaveDecision, draftValidationSignature, withSiteDefaults, renderServerForm, type ServerFormDraft } from '../ui/server-form.js';
import { renderServerList } from '../ui/server-list.js';
import { renderSettingsSections } from '../ui/settings-sections.js';
import { showError, toast } from '../ui/toast.js';

// ------------------------------------------------------------------ elements
const els = {
  tabs: document.getElementById('panel-tabs') as HTMLElement,
  statusPill: document.getElementById('engine-status') as HTMLElement,
  eyebrow: document.getElementById('panel-eyebrow') as HTMLElement,
  title: document.getElementById('panel-title') as HTMLElement,
  contextHost: document.getElementById('context-host') as HTMLElement,
  browsePane: document.getElementById('pane-browse') as HTMLElement,
  queuePane: document.getElementById('pane-queue') as HTMLElement,
  linksPane: document.getElementById('pane-links') as HTMLElement,
  serversPane: document.getElementById('pane-servers') as HTMLElement,
  settingsPane: document.getElementById('pane-settings') as HTMLElement,
  listingHost: document.getElementById('listing-host') as HTMLElement,
  browseListHost: document.getElementById('browse-list-host') as HTMLElement,
  queueHost: document.getElementById('queue-host') as HTMLElement,
  linksHost: document.getElementById('links-host') as HTMLElement,
  serversHost: document.getElementById('servers-host') as HTMLElement,
  settingsHost: document.getElementById('settings-host') as HTMLElement,
  dock: document.getElementById('dock') as HTMLElement,
  dockHost: document.getElementById('dock-host') as HTMLElement,
  previewBanner: document.getElementById('preview-banner') as HTMLElement,
};

const platform = getPlatform();
const TABS: Array<{ id: PanelTab; label: string }> = [
  { id: 'browse', label: 'Browse' },
  { id: 'queue', label: 'Queue' },
  { id: 'links', label: 'Links' },
  { id: 'servers', label: 'Servers' },
  { id: 'settings', label: 'Settings' },
];

/** Profiles whose API answers with the post bodies mirror links live in. */
const ARCHIVE_SITE_TYPES = new Set(['pawchive']);

interface ListingRuntime {
  serverId: string | null;
  tags: string;
  advanced: boolean;
  fromPage: string;
  toPage: string;
  rangeText: string;
  media: MediaFilter;
  skipDownloaded: boolean;
  ratingOverride: boolean | null;
  suggestions: string[];
  lastResult: SearchResult | null;
  matched: number | null;
  busy: 'idle' | 'search' | 'crawl';
  progress: { done: number; total: number; label: string } | null;
  error: { message: string; kind: string; hint: string | null } | null;
  skippedDownloaded: number;
}

interface EditorRuntime {
  draft: ServerFormDraft;
  isNew: boolean;
  apiKeyMask: string;
  validation: ValidationResult | null;
  validatedSignature: string | null;
  validating: boolean;
  saving: boolean;
}

interface LinksRuntime {
  serverId: string | null;
  query: string;
  links: MirrorLink[];
  stats: MirrorLinkStats;
  /** One entry per task (creator), newest first, as the worker knows them. */
  tasks: TaskView[];
  /** Task cards the user opened. */
  expanded: Set<string>;
  /** The task a collect run is currently filling (so scans join the right one). */
  activeTaskId: string | null;
  busyTaskId: string | null;
  selection: Set<string>;
  /** Rows seen at the last refresh, so nothing appears pre-ticked twice. */
  snapshot: Set<string>;
  busy: boolean;
  progress: { done: number; total: number; label: string } | null;
  exportGrouping: LinkExportGrouping;
  error: { message: string; kind: string; hint: string | null } | null;
}

interface PanelState {
  tab: PanelTab;
  servers: ServerConfigView[];
  adapters: AdapterCatalogEntry[];
  settings: ExtensionSettings | null;
  savingSettings: boolean;
  context: TabContext;
  post: PostCardState;
  listing: ListingRuntime;
  queue: { summary: QueueSummary; items: QueueItem[]; maxConcurrency: number; busy: boolean };
  links: LinksRuntime;
  selection: Set<string>;
  /** Pending rows seen at the last refresh, so new rows appear ticked. */
  pendingSnapshot: Set<string>;
  history: Map<string, DownloadHistoryEntry>;
  historyCount: number;
  searchCount: number;
  thumbnails: Map<string, string>;
  serverFilter: string;
  editor: EditorRuntime | null;
  diagnostics: DiagnosticsInfo | null;
  hostAccess: { origin: string; granted: boolean } | null;
  dockNotice: { text: string; tone: 'plain' | 'ok' | 'error' } | null;
  busyId: string | null;
  crawlAborted: boolean;
}

function emptySummary(): QueueSummary {
  return { pending: 0, running: 0, done: 0, failed: 0, skipped: 0, canceled: 0, unverified: 0, total: 0, paused: false, active: false };
}

const state: PanelState = {
  tab: 'browse',
  servers: [],
  adapters: [],
  settings: null,
  savingSettings: false,
  context: { checking: true, url: null, route: null, server: null, missingProfile: false, differentProfile: null },
  post: { loading: false, post: null, error: null, queued: false, saved: null, busy: false, blocked: false },
  listing: {
    serverId: null,
    tags: '',
    advanced: false,
    fromPage: '1',
    toPage: '',
    rangeText: '1',
    media: 'all',
    skipDownloaded: false,
    ratingOverride: null,
    suggestions: [],
    lastResult: null,
    matched: null,
    busy: 'idle',
    progress: null,
    error: null,
    skippedDownloaded: 0,
  },
  queue: { summary: emptySummary(), items: [], maxConcurrency: 2, busy: false },
  links: {
    serverId: null,
    query: '',
    links: [],
    stats: { total: 0, new: 0, queued: 0, done: 0, failed: 0, unverified: 0 },
    tasks: [],
    expanded: new Set(),
    activeTaskId: null,
    busyTaskId: null,
    selection: new Set(),
    snapshot: new Set(),
    busy: false,
    progress: null,
    exportGrouping: 'post',
    error: null,
  },
  selection: new Set(),
  pendingSnapshot: new Set(),
  history: new Map(),
  historyCount: 0,
  searchCount: 0,
  thumbnails: new Map(),
  serverFilter: '',
  editor: null,
  diagnostics: null,
  hostAccess: null,
  dockNotice: null,
  busyId: null,
  crawlAborted: false,
};

// ------------------------------------------------------------------ messaging

async function send<T>(request: UiRequest): Promise<T | null> {
  const response = await platform.send(request);
  if (!response.ok) {
    showError(response.error);
    return null;
  }
  return response.data as T;
}

// ----------------------------------------------------------------------- boot

async function boot(): Promise<void> {
  registerBuiltinAdapters();
  if (!isExtensionEnvironment()) {
    // The preview harness serves this page in a normal tab, so the mock service
    // graph has to be installed before the first request goes out.
    const preview = await import('../preview/preview.js');
    await preview.startPreview();
    els.previewBanner.hidden = false;
  }

  await Promise.all([refreshSettings(), refreshServers(), refreshQueue(), refreshHistory(), refreshLinks(), refreshDiagnostics()]);
  state.links.serverId =
    state.servers.find((entry) => ARCHIVE_SITE_TYPES.has(entry.siteType) && isUsableServer(entry))?.id ?? null;
  state.listing.media = state.settings?.mediaFilter ?? 'all';
  state.listing.skipDownloaded = state.settings?.skipDownloaded ?? false;
  state.tab = hashTab() ?? state.settings?.panelDefaultTab ?? 'browse';
  applyTheme(state.settings?.theme ?? 'system');
  render();
  void refreshContext();
  startPolling();
}

function applyTheme(theme: ExtensionSettings['theme']): void {
  const lightPreferred = globalThis.matchMedia?.('(prefers-color-scheme: light)').matches ?? false;
  document.documentElement.dataset.theme = theme === 'light' || (theme === 'system' && lightPreferred) ? 'light' : 'dark';
}

// ------------------------------------------------------------------- refreshes

async function refreshSettings(): Promise<void> {
  const settings = await send<ExtensionSettings>({ type: 'settings/get' });
  if (settings) state.settings = settings;
}

async function refreshServers(): Promise<void> {
  const servers = await send<ServerConfigView[]>({ type: 'servers/list' });
  if (!servers) return;
  state.servers = servers;
  const supported = servers.filter(isUsableServer);
  if (!state.listing.serverId || !supported.some((entry) => entry.id === state.listing.serverId)) {
    state.listing.serverId = supported.find((entry) => entry.isDefault)?.id ?? supported[0]?.id ?? null;
  }
  const origin = supported[0] ? safeUrl(supported[0].baseUrl)?.origin ?? null : null;
  state.hostAccess = origin ? { origin, granted: await platform.permissions.contains(origin) } : null;
  if (!state.links.serverId || !servers.some((entry) => entry.id === state.links.serverId && ARCHIVE_SITE_TYPES.has(entry.siteType) && isUsableServer(entry))) {
    state.links.serverId = servers.find((entry) => ARCHIVE_SITE_TYPES.has(entry.siteType) && isUsableServer(entry))?.id ?? null;
  }
  await refreshSuggestions();
}

async function refreshQueue(): Promise<void> {
  const result = await send<{ summary: QueueSummary; items: QueueItem[]; maxConcurrency: number }>({ type: 'queue/list' });
  if (!result) return;
  state.queue = { summary: result.summary, items: result.items, maxConcurrency: result.maxConcurrency, busy: state.queue.busy };
  const post = state.post.post;
  if (post) state.post = { ...state.post, queued: queueHasPost(post.serverId, post.id) };
  reconcileSelection();
}

async function refreshLinks(): Promise<void> {
  const result = await send<{ links: MirrorLink[]; stats: MirrorLinkStats }>({ type: 'links/list' });
  if (!result) return;
  state.links.links = result.links;
  state.links.stats = result.stats;
  await refreshTasks();
  reconcileLinksSelection();
}

/** The task list: one entry per creator, with its file statistics. */
async function refreshTasks(): Promise<void> {
  const result = await send<{ tasks: TaskView[] }>({ type: 'tasks/list' });
  if (!result) return;
  state.links.tasks = result.tasks;
  const known = new Set(result.tasks.map((entry) => entry.task.id));
  for (const id of [...state.links.expanded]) if (!known.has(id)) state.links.expanded.delete(id);
  if (state.links.activeTaskId && !known.has(state.links.activeTaskId)) state.links.activeTaskId = null;
}

async function refreshHistory(): Promise<void> {
  const result = await send<{ entries: DownloadHistoryEntry[]; total: number }>({ type: 'history/list' });
  if (!result) return;
  state.historyCount = result.total;
  // Legacy entries may be samples or start-only records. Neither can hide an original.
  state.history = new Map(result.entries.filter((entry) => entry.quality === 'original' && entry.completion === 'browser-complete').map((entry) => [entry.key, entry]));
  const post = state.post.post;
  if (post) {
    const entry = state.history.get(`${post.serverId}:${post.id}`);
    state.post = { ...state.post, saved: entry ? { filename: entry.filename, at: entry.at } : null };
  }
}

async function refreshSuggestions(): Promise<void> {
  if (!state.settings?.searchHistoryEnabled) {
    state.listing.suggestions = [];
    return;
  }
  const result = await send<{ entries: Array<{ query: string }> }>({
    type: 'searches/list',
    payload: { serverId: state.listing.serverId },
  });
  if (result) {
    state.listing.suggestions = result.entries.map((entry) => entry.query);
    state.searchCount = result.entries.length;
  }
}

async function refreshDiagnostics(): Promise<void> {
  const info = await send<DiagnosticsInfo>({ type: 'diagnostics/info' });
  if (!info) return;
  state.diagnostics = info;
  state.adapters = info.adapters;
}

/** Read the active tab, resolve it against the saved servers, render the cards. */
async function refreshContext(): Promise<void> {
  state.context = { ...state.context, checking: true };
  renderContext();
  const url = await platform.activeTabUrl();
  if (!url) {
    state.context = { checking: false, url: null, route: null, server: null, missingProfile: false, differentProfile: null };
    renderContext();
    return;
  }
  const route = await send<RouteMatch & { server: ServerConfigView | null }>({ type: 'routes/detect', payload: { url } });
  const server = route?.server ?? null;
  state.context = {
    checking: false,
    url,
    route: route ?? null,
    server,
    missingProfile: Boolean(route) && !server,
    differentProfile: null,
  };
  if (server) state.listing.serverId = server.id;
  // A creator page: make its profile the Links source and offer the creator as
  // the query (never overwriting what the user typed themselves).
  if (route && ARCHIVE_SITE_TYPES.has(route.siteType) && route.tags && !state.links.query) {
    state.links.query = route.tags;
  }
  if (server && ARCHIVE_SITE_TYPES.has(server.siteType)) state.links.serverId = server.id;
  render();

  if (route?.kind === 'post' && route.postId && server) {
    await loadPost(server.id, route.postId);
  } else {
    state.post = { loading: false, post: null, error: null, queued: false, saved: null, busy: false, blocked: false };
    if (route && route.kind !== 'post' && route.tags && !state.listing.tags) {
      state.listing.tags = route.tags;
    }
    render();
  }
  await refreshSuggestions();
  if (state.tab === 'browse') renderBrowse();
}

async function loadPost(serverId: string, postId: string): Promise<void> {
  state.post = { loading: true, post: null, error: null, queued: false, saved: null, busy: false, blocked: false };
  renderContext();
  const post = await send<BooruPost>({ type: 'posts/get', payload: { serverId, postId } });
  if (!post) {
    state.post = {
      loading: false,
      post: null,
      error: {
        message: 'The post could not be read from the site.',
        kind: 'parse-failure',
        hint: 'Check the server profile, then press ⟳ to try again.',
      },
      queued: false,
      saved: null,
      busy: false,
      blocked: false,
    };
    renderContext();
    return;
  }
  const historyEntry = state.history.get(`${post.serverId}:${post.id}`) ?? null;
  const server = state.servers.find((entry) => entry.id === post.serverId) ?? null;
  const blocked = Boolean(server && state.settings?.enforceRatingFilterOnDownload && !ratingAllowed(server, post.rating));
  state.thumbnails.set(`${post.serverId}:${post.id}`, post.previewUrl);
  state.post = {
    loading: false,
    post,
    error: null,
    queued: queueHasPost(post.serverId, post.id),
    saved: historyEntry ? { filename: historyEntry.filename, at: historyEntry.at } : null,
    busy: false,
    blocked,
  };
  render();
}

function queueHasPost(serverId: string, postId: string): boolean {
  return state.queue.items.some(
    (item) => item.serverId === serverId && item.postId === postId && (item.status === 'pending' || item.status === 'running'),
  );
}

/** Client-side mirror of the shared rating decision - used for the warning only. */
function ratingAllowed(server: ServerConfigView, rating: string): boolean {
  if (!server.ratingFilterEnabled) return true;
  const allowed = server.allowedRatings?.length ? server.allowedRatings : ['general', 'safe', 'sensitive'];
  return allowed.includes(rating as never);
}

// -------------------------------------------------------------------- render

function render(): void {
  renderShell();
  els.browsePane.hidden = state.tab !== 'browse';
  els.queuePane.hidden = state.tab !== 'queue';
  els.linksPane.hidden = state.tab !== 'links';
  els.serversPane.hidden = state.tab !== 'servers';
  els.settingsPane.hidden = state.tab !== 'settings';
  els.dock.hidden = state.tab !== 'browse' && state.tab !== 'queue';
  renderContext();
  if (state.tab === 'browse') renderBrowse();
  if (state.tab === 'queue') renderQueueTab();
  if (state.tab === 'links') renderLinksTab();
  if (state.tab === 'servers') renderServersTab();
  if (state.tab === 'settings') renderSettingsTab();
  renderDockBar();
}

function renderShell(): void {
  els.eyebrow.textContent = 'BOORU SERVER MANAGER';
  els.title.textContent = 'Download panel';
  els.statusPill.className = `status-pill ${pillTone()}`;
  els.statusPill.textContent = statusPillText();
  const active = state.servers.find((entry) => entry.id === state.listing.serverId) ?? null;
  els.tabs.replaceChildren();
  for (const tab of TABS) {
    const element = h('button', {
      type: 'button',
      class: `panelTab${state.tab === tab.id ? ' active' : ''}`,
      text: tab.label,
      dataset: { tab: tab.id },
      onClick: () => switchTab(tab.id),
    });
    if (tab.id === 'queue') {
      const pending = state.queue.summary.pending + state.queue.summary.running;
      if (pending) element.appendChild(h('span', { class: 'panelTabBadge', text: String(pending) }));
    }
    els.tabs.appendChild(element);
  }
  els.title.title = active ? `Searching with ${active.label}` : 'No server selected';
}

function switchTab(tab: PanelTab): void {
  if (state.tab === tab) return;
  state.tab = tab;
  // Deep links (#queue, #settings) and reload-friendly URLs.
  if (globalThis.location.hash.replace('#', '') !== tab) globalThis.location.hash = tab;
  render();
}

/** Tab named in the URL hash, when it is one of the known tabs. */
function hashTab(): PanelTab | null {
  const hash = globalThis.location.hash.replace(/^#/, '');
  return TABS.some((tab) => tab.id === hash) ? (hash as PanelTab) : null;
}

function pillTone(): string {
  if (state.queue.summary.running || state.queue.summary.active) return 'running';
  if (state.listing.busy === 'crawl') return 'crawling';
  if (state.listing.busy === 'search') return 'crawling';
  if (state.queue.summary.failed || state.queue.summary.unverified) return 'warn';
  if (!state.settings) return 'idle';
  return 'idle';
}

function statusPillText(): string {
  if (!state.settings) return 'Loading…';
  if (state.queue.summary.running) return `${state.queue.summary.running} downloading`;
  if (state.listing.busy === 'crawl') return 'fetching';
  if (state.listing.busy === 'search') return 'listing';
  if (state.queue.summary.failed) return `${state.queue.summary.failed} failed`;
  if (state.queue.summary.unverified) return `${state.queue.summary.unverified} unverified`;
  if (state.queue.summary.pending) return `${state.queue.summary.pending} queued`;
  return 'Ready';
}

function renderContext(): void {
  if (state.tab !== 'browse') return;
  const host = h('div');
  renderTabContext(host, state.context, {
    onRefresh: () => void refreshContext(),
    onAddServer: () => openEditor(null, state.context.route?.siteType ?? 'e621', state.context.route?.canonicalUrl),
    onUseRoute: () => {
      const route = state.context.route;
      if (!route?.tags) return;
      state.listing.tags = route.tags;
      toast(`Search box filled with “${route.tags}”`, 'info');
      renderBrowse();
    },
  });
  const children: HTMLElement[] = [];
  for (const child of Array.from(host.children)) children.push(child as HTMLElement);

  if (state.context.route?.kind === 'post' && (state.post.loading || state.post.post || state.post.error)) {
    const postHost = h('div');
    renderPostCard(postHost, state.post, {
      onDownload: () => void downloadPost(),
      onAddToList: () => void addPostToList(),
      onAddAllPawchiveFiles: state.context.server?.siteType === 'pawchive' ? () => void addAllPawchiveFiles() : undefined,
      onReload: () => {
        const route = state.context.route;
        if (route?.postId && state.context.server) void loadPost(state.context.server.id, route.postId);
      },
    });
    for (const child of Array.from(postHost.children)) children.push(child as HTMLElement);
  }
  els.contextHost.replaceChildren(...children);
}

// --------------------------------------------------------------------- browse

function renderBrowse(): void {
  const host = h('div');
  renderListingCard(host, buildListingState(), {
    onServerChange: (serverId) => {
      state.listing.serverId = serverId;
      state.listing.ratingOverride = null;
      state.listing.error = null;
      void refreshSuggestions().then(() => renderBrowse());
    },
    onTagsChange: (tags) => {
      state.listing.tags = tags;
      renderBrowse();
    },
    onSuggestion: (query) => {
      state.listing.tags = query;
      renderBrowse();
    },
    onClearSuggestions: () => {
      void send({ type: 'searches/clear', payload: { serverId: state.listing.serverId } })
        .then(() => refreshSuggestions())
        .then(() => renderBrowse());
    },
    onAdvancedToggle: (advanced) => {
      if (advanced) {
        state.listing.rangeText = fromToRange(state.listing.fromPage, state.listing.toPage) || '1';
      } else {
        const parsed = parsePageRange(state.listing.rangeText, { maxPages: pageLimit() });
        if (parsed.ok && parsed.selection.kind === 'list' && parsed.selection.pages.length) {
          state.listing.fromPage = String(parsed.selection.pages[0]);
          state.listing.toPage = String(parsed.selection.pages[parsed.selection.pages.length - 1]);
        }
      }
      state.listing.advanced = advanced;
      renderBrowse();
    },
    onFromToChange: (from, to) => {
      state.listing.fromPage = from;
      state.listing.toPage = to;
      state.listing.rangeText = fromToRange(from, to) || '1';
      renderBrowse();
    },
    onRangeTextChange: (text) => {
      state.listing.rangeText = text;
      renderBrowse();
    },
    onMediaChange: (media) => {
      state.listing.media = media;
      renderBrowse();
      renderDockBar();
    },
    onSkipDownloadedChange: (value) => {
      state.listing.skipDownloaded = value;
      renderBrowse();
    },
    onToggleRatingFilter: () => {
      const server = currentServer();
      const effective = state.listing.ratingOverride ?? server?.ratingFilterEnabled ?? false;
      state.listing.ratingOverride = !effective;
      renderBrowse();
    },
    onList: () => void runFetch({ mode: 'page' }),
    onFetchRange: () => void runFetch({ mode: 'range' }),
    onDownloadPage: () => void runFetch({ mode: 'page', download: true }),
    onStop: () => {
      state.crawlAborted = true;
      state.listing.busy = 'idle';
      state.listing.progress = null;
      state.dockNotice = { text: 'Fetch stopped. Rows already listed stay in the list.', tone: 'plain' };
      render();
    },
    onOpenServers: () => switchTab('servers'),
  });
  preserveInputFocus(els.listingHost, () => els.listingHost.replaceChildren(...Array.from(host.children) as HTMLElement[]));

  const listHost = h('div');
  renderQueueList(listHost, buildQueueListState(), listCallbacks());
  els.browseListHost.replaceChildren(...(Array.from(listHost.children) as HTMLElement[]));
}

function renderQueueTab(): void {
  const host = h('div');
  renderQueueList(host, buildQueueListState(), listCallbacks());
  els.queueHost.replaceChildren(...(Array.from(host.children) as HTMLElement[]));
}

// ---------------------------------------------------------------------- links

/**
 * Rows arrive ticked when they are new, exactly like queue rows; a link the user
 * unticked stays unticked across refreshes.
 */
function reconcileLinksSelection(): void {
  const available = new Set(state.links.links.map((link) => link.id));
  const next = new Set<string>();
  for (const id of state.links.selection) if (available.has(id)) next.add(id);
  for (const link of state.links.links) {
    if (link.status === 'done' || link.status === 'failed' || link.status === 'unverified') continue;
    if (!state.links.snapshot.has(link.id)) next.add(link.id);
  }
  state.links.selection = next;
  state.links.snapshot = available;
}

function currentLinksServer(): ServerConfigView | null {
  return state.servers.find((entry) => entry.id === state.links.serverId) ?? null;
}

function buildLinksState(): LinksState {
  const server = currentLinksServer();
  const rowLimit = state.settings?.queueRowLimit ?? 60;
  const byServer = new Map(state.servers.map((entry) => [entry.id, entry.label]));
  const rowFor = (link: MirrorLink): MirrorLinkRow => ({
    link,
    serverLabel: link.serverId ? byServer.get(link.serverId) ?? null : null,
    selected: state.links.selection.has(link.id),
  });
  const byId = new Map(state.links.links.map((link) => [link.id, link]));

  let budget = rowLimit;
  const tasks: TaskCardView[] = [];
  const claimed = new Set<string>();
  for (const view of state.links.tasks) {
    const members = view.task.memberIds
      .map((id) => byId.get(id))
      .filter((link): link is MirrorLink => !!link);
    for (const link of members) claimed.add(link.id);
    const expanded = state.links.expanded.has(view.task.id);
    const rows = expanded ? members.slice(0, Math.max(0, budget)) : [];
    budget -= rows.length;
    tasks.push({
      view,
      rows: expanded ? rows.map(rowFor) : [],
      hiddenRows: expanded ? Math.max(0, members.length - rows.length) : 0,
      expanded,
    });
  }

  // Everything a task does not own: bare imports, userscript exports, single links.
  const unfiledAll = state.links.links.filter((link) => !claimed.has(link.id));
  const unfiled = unfiledAll.slice(0, Math.max(0, budget)).map(rowFor);
  budget -= unfiled.length;

  return {
    servers: state.servers.filter((entry) => ARCHIVE_SITE_TYPES.has(entry.siteType) && isUsableServer(entry)),
    serverId: state.links.serverId,
    query: state.links.query,
    canCollect: !!server && ARCHIVE_SITE_TYPES.has(server.siteType) && isUsableServer(server),
    busy: state.links.busy,
    progress: state.links.progress,
    error: state.links.error,
    stats: state.links.stats,
    tasks,
    unfiled,
    unfiledHidden: Math.max(0, unfiledAll.length - unfiled.length),
    selectionCount: state.links.selection.size,
    exportGrouping: state.links.exportGrouping,
    filterMode: state.settings?.mirrorLinksFilter ?? 'downloads',
    queuePending: state.queue.items.filter((item) => item.kind === 'link' && item.status === 'pending').length,
  };
}

function renderLinksTab(): void {
  const host = h('div');
  renderLinksCard(host, buildLinksState(), {
    onServerChange: (serverId) => {
      state.links.serverId = serverId;
      renderLinksTab();
    },
    onQueryChange: (query) => {
      state.links.query = query;
    },
    onCollect: () => void collectLinks(),
    onStop: () => {
      state.crawlAborted = true;
      state.links.busy = false;
      state.links.progress = null;
      state.dockNotice = { text: 'Link collection stopped. Everything found so far is kept.', tone: 'plain' };
      render();
    },
    onToggleRow: (id) => {
      if (state.links.selection.has(id)) state.links.selection.delete(id);
      else state.links.selection.add(id);
      renderLinksTab();
    },
    onSelectAll: (select) => {
      const selectable = state.links.links.filter((link) => link.status !== 'done');
      state.links.selection = select ? new Set(selectable.map((link) => link.id)) : new Set();
      renderLinksTab();
    },
    onInvert: () => {
      const next = new Set<string>();
      for (const link of state.links.links) {
        if (link.status === 'done') continue;
        if (!state.links.selection.has(link.id)) next.add(link.id);
      }
      state.links.selection = next;
      renderLinksTab();
    },
    onAddToQueue: (ids) => void queueLinks(ids),
    onExport: (grouping) => void exportLinks(grouping),
    onImport: (text, filename) => void importTaskPackage(text, filename),
    onRemoveSelected: (ids) => void removeLinks(ids),
    onRemoveRow: (id) => void removeLinks([id]),
    onClear: (scope) => void clearLinks(scope),
    onOpenLink: (url) => globalThis.open(url, '_blank', 'noreferrer'),
    onOpenPost: (url) => globalThis.open(url, '_blank', 'noreferrer'),
    onOpenQueue: () => switchTab('queue'),
    onOpenSettings: () => switchTab('settings'),
    onToggleTask: (taskId) => {
      if (state.links.expanded.has(taskId)) state.links.expanded.delete(taskId);
      else state.links.expanded.add(taskId);
      renderLinksTab();
    },
    onTaskStart: (taskId, mode) => void runTask(taskId, mode),
    onTaskPause: (taskId) => void pauseTask(taskId),
    onTaskRescan: (taskId) => void rescanTask(taskId),
    onTaskExport: (taskId) => void exportTask(taskId),
    onTaskRemove: (taskId) => void removeTask(taskId),
  });
  preserveInputFocus(els.linksHost, () => els.linksHost.replaceChildren(...(Array.from(host.children) as HTMLElement[])));
}

/**
 * Walk a creator and harvest the mirror links of every post.
 *
 * One listing request per page, then one request per post - the panel drives the
 * loop so the progress bar moves, Stop is instant, and each request still goes
 * through the background worker's per-server rate limiter. Found links are
 * written to storage as they arrive, so closing the panel mid-scan loses nothing.
 */
async function collectLinks(): Promise<void> {
  const server = currentLinksServer();
  const query = state.links.query.trim();
  if (!server || !query) return;

  state.links.busy = true;
  state.links.error = null;
  state.links.progress = { done: 0, total: 0, label: 'Reading the creator listing…' };
  state.crawlAborted = false;
  renderLinksTab();

  // Every collect run belongs to a task (one per creator), so its files stay
  // traceable: what was scanned, what came in, what still fails.
  let taskId: string | null = state.links.activeTaskId;
  try {
    const begun = await send<{ task: TaskView; created: boolean }>({
      type: 'tasks/begin',
      payload: { serverId: server.id, query },
    });
    if (begun?.task) {
      taskId = begun.task.task.id;
      state.links.activeTaskId = taskId;
      if (begun.created) state.links.expanded.add(taskId);
    }
  } catch {
    // A task is bookkeeping, not a requirement: without it the scan still works.
    taskId = null;
  }

  const maxPosts = 1000;
  const pageLimit = Math.max(1, Math.ceil(maxPosts / 50));
  let scanned = 0;
  let found = 0;
  let duplicates = 0;
  let failed = 0;
  let postBudget = maxPosts;

  try {
    for (let page = 1; page <= pageLimit && !state.crawlAborted; page += 1) {
      const listing = await send<{
        posts: Array<{ id: string; label: string; postUrl: string }>;
        hasMore: boolean;
        totalCount: number | null;
        page: number;
      }>({ type: 'links/posts', payload: { serverId: server.id, query, page } });
      if (!listing) {
        state.links.error = {
          message: 'The creator listing could not be read.',
          kind: 'network-failure',
          hint: 'Check the profile, the wait between requests, then try again.',
        };
        break;
      }
      if (!listing.posts.length) break;
      const posts = listing.posts.slice(0, postBudget);
      postBudget -= posts.length;

      for (const post of posts) {
        if (state.crawlAborted) break;
        const result = await send<{ added: MirrorLink[]; duplicates: number; total: number }>({
          type: 'links/scanPost',
          payload: { serverId: server.id, postId: post.id, postUrl: post.postUrl, postTitle: post.label, creator: query, taskId },
        });
        scanned += 1;
        if (!result) {
          failed += 1;
        } else {
          found += result.added.length;
          duplicates += result.duplicates;
        }
        state.links.progress = {
          done: scanned,
          total: Math.min(maxPosts, listing.totalCount ?? maxPosts),
          label: `Scanned ${scanned} post(s) · ${found} new link(s)${duplicates ? ` · ${duplicates} already known` : ''}`,
        };
        renderLinksTab();
      }

      await refreshLinks();
      if (!listing.hasMore || postBudget <= 0) break;
    }

    const stats = state.links.stats;
    state.dockNotice = state.crawlAborted
      ? { text: `Stopped after ${scanned} post(s). ${found} new link(s) kept.`, tone: 'plain' }
      : {
          text: `${scanned} post(s) scanned · ${found} new link(s)${failed ? ` · ${failed} post(s) failed` : ''} · ${stats.total} in the list.`,
          tone: found ? 'ok' : 'plain',
        };
  } catch (error) {
    state.links.error = {
      message: error instanceof Error ? error.message : String(error),
      kind: 'unknown',
      hint: null,
    };
  } finally {
    state.links.busy = false;
    state.links.progress = null;
    await refreshLinks();
    render();
  }
}

async function queueLinks(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const unverified = state.links.links.filter((link) => ids.includes(link.id) && link.status === 'unverified').length;
  if (unverified && !globalThis.confirm(`${unverified} link(s) have unverified prior starts. They may already be on disk. Check Chrome Downloads before retrying. Queue them anyway?`)) return;
  const result = await send<{ queued: number; skipped: number; invalid: number }>({
    type: 'links/queue',
    payload: { ids },
  });
  if (!result) return;
  await Promise.all([refreshLinks(), refreshQueue()]);
  state.dockNotice = {
    text: `${result.queued} link(s) added to the download queue${result.skipped ? `, ${result.skipped} already queued` : ''}${
      result.invalid ? `, ${result.invalid} invalid` : ''
    }. Open the Queue tab to review and start them.`,
    tone: result.queued ? 'ok' : 'plain',
  };
  toast(`${result.queued} link(s) queued`, result.queued ? 'success' : 'info');
  render();
}

async function exportLinks(grouping: LinkExportGrouping): Promise<void> {
  state.links.exportGrouping = grouping;
  const result = await send<{ text: string; filename: string; count: number }>({
    type: 'links/export',
    payload: { grouping },
  });
  if (!result) return;
  if (!result.count) {
    toast('Nothing collected yet — nothing to export.', 'warning');
    renderLinksTab();
    return;
  }
  const blob = new Blob([result.text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = result.filename;
  anchor.click();
  globalThis.setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast(`Exported ${result.count} link(s) to ${result.filename}`, 'success');
  renderLinksTab();
}

async function importLinks(text: string, filename: string): Promise<void> {
  if (!text.trim()) {
    toast(`“${filename}” was empty or could not be read.`, 'error');
    return;
  }
  const result = await send<{ parsed: number; added: number; updated: number; invalid: number }>({
    type: 'links/import',
    payload: { text, serverId: state.links.serverId },
  });
  if (!result) return;
  await refreshLinks();
  state.dockNotice = {
    text: `${result.added} link(s) imported from ${filename}${result.updated ? `, ${result.updated} already known` : ''}${
      result.invalid ? `, ${result.invalid} unreadable line(s)` : ''
    }. Tick the ones you want, then press Add to download queue.`,
    tone: result.added ? 'ok' : 'plain',
  };
  toast(`${result.added} link(s) imported from ${filename}`, result.added ? 'success' : 'warning');
  render();
}

async function removeLinks(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const result = await send<{ removed: number }>({ type: 'links/remove', payload: { ids } });
  for (const id of ids) state.links.selection.delete(id);
  await Promise.all([refreshLinks(), refreshQueue()]);
  if (result) toast(`${result.removed} link(s) removed from the list`, 'info');
  render();
}

async function clearLinks(scope: 'all' | 'done' | 'pending'): Promise<void> {
  if (scope === 'all' && state.links.stats.total && !globalThis.confirm('Clear every collected link? Queued rows are dropped too. Files already downloaded stay on disk.')) {
    return;
  }
  const result = await send<{ removed: number }>({ type: 'links/clear', payload: { scope } });
  state.links.selection = new Set();
  await Promise.all([refreshLinks(), refreshQueue()]);
  if (result) toast(`${result.removed} link(s) cleared`, 'success');
  render();
}

// ----------------------------------------------------------------- task actions

/** Queue everything a task is missing (new files and retries) and start it. */
async function runTask(taskId: string, mode: 'missing' | 'all'): Promise<void> {
  const members = new Set(state.links.tasks.find((entry) => entry.task.id === taskId)?.task.memberIds ?? []);
  const unverified = state.links.links.filter((link) => members.has(link.id) && link.status === 'unverified').length;
  if (unverified && !globalThis.confirm(`${unverified} task file(s) have unverified prior starts. They may already be on disk. Check Chrome Downloads before retrying. Continue?`)) return;
  state.links.busyTaskId = taskId;
  renderLinksTab();
  const result = await send<{
    queued: number;
    skipped: number;
    started: boolean;
    plan: { alreadyDone: number; alreadyQueued: number; retrying: number; total: number };
  }>({ type: 'tasks/run', payload: { taskId, mode } });
  state.links.busyTaskId = null;
  if (!result) {
    renderLinksTab();
    return;
  }
  await Promise.all([refreshLinks(), refreshQueue()]);
  const parts = [`${result.queued} file(s) queued`];
  if (result.plan.retrying) parts.push(`${result.plan.retrying} retry`);
  if (result.plan.alreadyDone) parts.push(`${result.plan.alreadyDone} previously completed, skipped`);
  if (result.skipped) parts.push(`${result.skipped} already in the queue`);
  state.dockNotice = {
    text: `${parts.join(' · ')}.${result.started ? ' Downloading slowly in the background.' : ''}`,
    tone: result.queued ? 'ok' : 'plain',
  };
  toast(result.queued ? `${result.queued} file(s) queued` : 'Nothing left to download', result.queued ? 'success' : 'info');
  render();
}

/** Pause a task: its waiting rows leave the queue, files in flight are kept. */
async function pauseTask(taskId: string): Promise<void> {
  const result = await send<{ task: TaskView | null }>({ type: 'tasks/pause', payload: { taskId } });
  if (!result) return;
  await Promise.all([refreshLinks(), refreshQueue()]);
  state.dockNotice = { text: 'Task paused. Waiting starts were removed; already started transfers continue in Chrome.', tone: 'plain' };
  render();
}

/** Look for posts the task has never scanned (new uploads) and attach their files. */
async function rescanTask(taskId: string): Promise<void> {
  state.links.busyTaskId = taskId;
  renderLinksTab();
  const result = await send<{ scannedPosts: number; added: number; failed: number; hasMore: boolean }>({
    type: 'tasks/rescan',
    payload: { taskId, maxPosts: 200 },
  });
  state.links.busyTaskId = null;
  if (!result) {
    renderLinksTab();
    return;
  }
  await refreshLinks();
  state.dockNotice = {
    text: `${result.scannedPosts} new post(s) scanned · ${result.added} file(s) added${
      result.failed ? ` · ${result.failed} post(s) unreadable` : ''
    }${result.hasMore ? ' · more posts remain' : ''}. Press Download missing to fetch them.`,
    tone: result.added ? 'ok' : 'plain',
  };
  toast(result.added ? `${result.added} new file(s) found` : 'No new posts found', result.added ? 'success' : 'info');
  render();
}

/** Export the task's package: the manifest and the grouped list, both at once. */
async function exportTask(taskId: string): Promise<void> {
  const result = await send<{ files: Array<{ filename: string; text: string; mime: string }>; count: number }>({
    type: 'tasks/export',
    payload: { taskId },
  });
  if (!result?.files?.length) {
    toast('Nothing to export yet — collect or import some files first.', 'warning');
    return;
  }
  for (const file of result.files) {
    const blob = new Blob([file.text], { type: `${file.mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = file.filename;
    anchor.click();
    globalThis.setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
  toast(`Package written (${result.count} file(s)): ${result.files.map((file) => file.filename).join(' + ')}`, 'success');
  renderLinksTab();
}

async function removeTask(taskId: string): Promise<void> {
  const task = state.links.tasks.find((entry) => entry.task.id === taskId)?.task ?? null;
  const confirmed = globalThis.confirm(
    `Remove the task "${task?.name ?? taskId}"?\n\nThe files stay in the collected list and anything already downloaded stays on disk.`,
  );
  if (!confirmed) return;
  const result = await send<{ removed: boolean }>({ type: 'tasks/remove', payload: { taskId, keepFiles: true } });
  state.links.expanded.delete(taskId);
  if (state.links.activeTaskId === taskId) state.links.activeTaskId = null;
  await Promise.all([refreshLinks(), refreshQueue()]);
  if (result?.removed) toast('Task removed', 'info');
  render();
}

/**
 * "Pick from file": read a package someone sent (or a plain list) and show it as
 * a task.
 *
 * Nothing downloads here. The task arrives idle, and the user presses Download
 * missing when they are ready - which is also where the "skip what I already
 * have" rule lives, so re-importing the same file never re-downloads.
 */
async function importTaskPackage(text: string, filename: string): Promise<void> {
  if (!text.trim()) {
    toast(`“${filename}” was empty or could not be read.`, 'error');
    return;
  }
  const result = await send<{
    kind: 'json' | 'txt' | 'unknown';
    created: boolean;
    parsed: number;
    added: number;
    updated: number;
    invalid: number;
    task: TaskView | null;
    error: string | null;
  }>({ type: 'tasks/import', payload: { text, filename, serverId: state.links.serverId } });
  if (!result) return;
  if (result.error || !result.task) {
    toast(result.error ?? 'That file could not be read.', 'error');
    return;
  }
  if (result.task.task.id) state.links.expanded.add(result.task.task.id);
  await Promise.all([refreshLinks(), refreshQueue()]);
  const kind = result.kind === 'json' ? 'package' : 'link list';
  state.dockNotice = {
    text: `${result.task.task.name}: ${result.parsed} link(s) read from ${filename} (${kind}) · ${result.added} new${
      result.updated ? `, ${result.updated} already known` : ''
    }${result.invalid ? `, ${result.invalid} unreadable` : ''}. It is idle - press Download missing when you want it.`,
    tone: result.added ? 'ok' : 'plain',
  };
  toast(`${result.task.task.name} imported — ${result.added} new file(s), ${result.updated} already known`, result.added ? 'success' : 'info');
  render();
}

function currentServer(): ServerConfigView | null {
  return state.servers.find((entry) => entry.id === state.listing.serverId) ?? null;
}

function pageLimit(): number {
  return state.settings?.pageRangeLimit ?? 150;
}

function currentRange() {
  if (state.listing.advanced) return parsePageRange(state.listing.rangeText, { maxPages: pageLimit() });
  return parsePageRange(fromToRange(state.listing.fromPage, state.listing.toPage) || '1', { maxPages: pageLimit() });
}

function buildListingState(): ListingState {
  const server = currentServer();
  const adapter = state.adapters.find((entry) => entry.siteType === server?.siteType) ?? null;
  const parsed = currentRange();
  const composed = composeSearchTags({
    tags: state.listing.tags,
    blacklist: server?.siteType === 'pawchive' ? '' : state.settings?.tagBlacklist ?? '',
    globalSuffix: server?.siteType === 'pawchive' ? '' : state.settings?.globalTagSuffix ?? '',
  });
  return {
    servers: state.servers.filter(isUsableServer),
    adapters: state.adapters,
    serverId: state.listing.serverId,
    tags: state.listing.tags,
    suggestions: state.listing.suggestions,
    advanced: state.listing.advanced,
    fromPage: state.listing.fromPage,
    toPage: state.listing.toPage,
    rangeText: state.listing.rangeText,
    rangeLabel: parsed.ok ? `Will fetch ${parsed.label}` : null,
    rangeError: parsed.ok ? null : parsed.message,
    media: state.listing.media,
    skipDownloaded: state.listing.skipDownloaded,
    ratingEnabled: state.listing.ratingOverride ?? server?.ratingFilterEnabled ?? false,
    allowedRatings: server?.allowedRatings ?? [],
    supportsRatingFilter: adapter?.supportsRatingFilter ?? false,
    filters: { appended: composed.appended, excluded: composed.excluded },
    pageLimit: pageLimit(),
    busy: state.listing.busy,
    progress: state.listing.progress,
    error: state.listing.error,
    listedCount: state.queue.items.length,
    matchedCount: state.listing.matched,
    skippedDownloaded: state.listing.skippedDownloaded,
  };
}

function isVideoItem(item: QueueItem): boolean {
  const post = state.post.post;
  if (post && post.id === item.postId) return post.isVideo;
  return /\.(mp4|webm|mov|mkv)$/i.test(item.filename ?? '');
}

function mediaMatchesItem(item: QueueItem): boolean {
  // The media filter describes booru posts; a mirror link is neither picture nor
  // video until it is fetched, so it is never filtered out.
  if (item.kind === 'link') return true;
  if (state.listing.media === 'all') return true;
  return state.listing.media === 'video' ? isVideoItem(item) : !isVideoItem(item);
}

function buildQueueListState(): QueueListState {
  const items = state.queue.items.filter((item) => mediaMatchesItem(item));
  const limit = state.settings?.queueRowLimit ?? 60;
  const rows: QueueRowView[] = items.slice(0, limit).map((item) => {
    const isLink = item.kind === 'link';
    const historyEntry = isLink ? null : state.history.get(`${item.serverId}:${item.postId}`) ?? null;
    const stored = isLink ? state.links.links.find((link) => link.id === item.postId) ?? null : null;
    const url = item.url ?? item.postUrl;
    return {
      item,
      server: state.servers.find((entry) => entry.id === item.serverId) ?? null,
      selected: state.selection.has(item.id),
      savedFilename: historyEntry?.filename ?? null,
      thumbnail: state.settings?.showThumbnails === false || isLink ? '' : state.thumbnails.get(`${item.serverId}:${item.postId}`) ?? '',
      media: isVideoItem(item) ? 'video' : 'image',
      rating: item.rating ?? null,
      linkProvider: stored?.provider ?? null,
      linkHeadline: isLink ? (item.filename ?? url).replace(/^.*\//, '') || url : undefined,
    };
  });
  return {
    summary: state.queue.summary,
    rows,
    hiddenRows: Math.max(0, items.length - rows.length),
    filteredRows: Math.max(0, state.queue.items.length - items.length),
    showThumbnails: state.settings?.showThumbnails !== false,
    busy: state.queue.busy,
  };
}

function listCallbacks() {
  return {
    onToggleRow: (itemId: string) => {
      if (state.selection.has(itemId)) state.selection.delete(itemId);
      else state.selection.add(itemId);
      render();
    },
    onSelectAll: (select: boolean) => {
      state.selection = select ? new Set(selectableItems().map((item) => item.id)) : new Set();
      render();
    },
    onInvert: () => {
      const next = new Set<string>();
      for (const item of selectableItems()) if (!state.selection.has(item.id)) next.add(item.id);
      state.selection = next;
      render();
    },
    onRemoveSelected: () => void removeItems([...state.selection]),
    onRemoveRow: (itemId: string) => void removeItems([itemId]),
    onCancelRow: (itemId: string) => void cancelItem(itemId),
    onRetryFailed: () => void retryFailed(),
    onClearFinished: () => void clearQueue('completed'),
    onResetHistory: () => void resetHistory(),
    onClearList: () => void clearQueue('all'),
    onOpenPost: (item: QueueItem) => {
      if (item.postUrl) globalThis.open(item.postUrl, '_blank', 'noreferrer');
    },
  };
}

function selectableItems(): QueueItem[] {
  return state.queue.items.filter((item) => item.status === 'pending' && mediaMatchesItem(item));
}

/**
 * Tick marks: every newly listed pending row starts ticked (the sister panels do
 * the same), and a row the user unticked stays unticked across refreshes.
 */
function reconcileSelection(): void {
  const pending = new Set(state.queue.items.filter((item) => item.status === 'pending').map((item) => item.id));
  const next = new Set<string>();
  for (const id of state.selection) if (pending.has(id)) next.add(id);
  for (const id of pending) if (!state.pendingSnapshot.has(id)) next.add(id);
  state.selection = next;
  state.pendingSnapshot = pending;
}

// ----------------------------------------------------------------------- dock

function renderDockBar(): void {
  const selected = [...state.selection].filter((id) => state.queue.items.some((item) => item.id === id && item.status === 'pending'));
  const dockState: DockState = {
    concurrency: state.settings?.maxConcurrency ?? 2,
    selectedCount: selected.length,
    pendingCount: state.queue.summary.pending,
    running: state.queue.summary.running > 0 || state.queue.summary.active,
    dispatching: state.queue.summary.active,
    paused: state.queue.summary.paused,
    notice: state.dockNotice,
    busy: state.queue.busy,
  };
  renderDock(els.dockHost, dockState, {
    onConcurrencyChange: (value) => void patchSettings({ maxConcurrency: value }),
    onDownloadSelected: () => void downloadSelected(),
    onStart: () => void startQueue(),
    onPause: () => void pauseQueue(true),
    onResume: () => void pauseQueue(false),
    onStop: () => void stopQueue(),
  });
}

// ------------------------------------------------------------------- fetching

/**
 * Fetch posts and turn them into list rows.
 *
 * `mode: 'page'` lists one page; `mode: 'range'` walks the selected pages. Nothing
 * is downloaded unless `download` is set - the promise printed in the card
 * ("Fetching only adds rows to the list") is kept.
 */
async function runFetch(options: { mode: 'page' | 'range'; download?: boolean }): Promise<void> {
  const server = currentServer();
  if (!server) {
    toast('Add a server first', 'error');
    switchTab('servers');
    return;
  }
  const range = currentRange();
  if (!range.ok) {
    state.listing.error = { message: range.message, kind: 'incomplete-config', hint: 'Fix the page range and try again.' };
    renderBrowse();
    return;
  }
  state.listing.error = null;
  state.crawlAborted = false;
  state.listing.busy = options.mode === 'page' ? 'search' : 'crawl';
  state.listing.skippedDownloaded = 0;
  const totalPages = range.selection.kind === 'list' ? Math.max(1, range.selection.pages.length) : Math.max(1, pageLimit());
  state.listing.progress =
    options.mode === 'page' ? null : { done: 0, total: totalPages, label: `Preparing ${range.label}…` };
  renderBrowse();

  if (state.listing.tags.trim()) {
    void send({ type: 'searches/add', payload: { serverId: server.id, query: state.listing.tags.trim() } }).then(() => refreshSuggestions());
  }

  const collected: BooruPost[] = [];
  let skippedDownloaded = 0;
  let done = 0;
  let matched: number | null = state.listing.matched;

  const takePage = async (page: number): Promise<boolean> => {
    // Raw user tags go to the router: it adds the tag blacklist, and the adapter
    // appends the global suffix plus its per-site rating filter.
    const result = await fetchPage(server.id, state.listing.tags, page);
    if (!result) return false;
    if (matched === null && result.totalCount !== null) matched = result.totalCount;
    const added = collectPosts(collected, result);
    skippedDownloaded += added.skipped;
    done += 1;
    state.listing.progress = { done, total: totalPages, label: `Listed page ${page} · ${collected.length} post(s) so far` };
    renderBrowse();
    // A Pawchive page can have only text/deferred posts but later pages may
    // still have downloadable files.
    return result.posts.length > 0 || result.hasMore;
  };

  try {
    if (range.selection.kind === 'list') {
      const pages = options.mode === 'page' ? [range.selection.pages[0]!] : range.selection.pages;
      for (const page of pages) {
        if (state.crawlAborted) break;
        const more = await takePage(page);
        if (!more) break;
      }
    } else {
      let page = range.selection.kind === 'open' ? range.selection.start : 1;
      const limit = options.mode === 'page' ? 1 : pageLimit();
      for (let step = 0; step < limit; step += 1) {
        if (state.crawlAborted) break;
        const more = await takePage(page);
        if (!more) break;
        page += 1;
      }
    }

    state.listing.matched = matched;
    state.listing.skippedDownloaded = skippedDownloaded;

    if (collected.length) {
      const queued = await send<{ added: number; skipped: number; summary: QueueSummary }>({
        type: 'queue/enqueuePosts',
        payload: {
          serverId: server.id,
          posts: collected.map((post) => ({ id: post.id, label: postLabel(post), postUrl: post.postUrl, rating: post.rating, expectedFileHash: post.siteType === 'pawchive' ? post.md5 : null })),
        },
      });
      for (const post of collected) state.thumbnails.set(`${post.serverId}:${post.id}`, post.previewUrl);
      if (queued) {
        await refreshQueue();
        const bits = [`${queued.added} row(s) added`];
        if (queued.skipped) bits.push(`${queued.skipped} skipped (duplicate or rating filter)`);
        if (skippedDownloaded) bits.push(`${skippedDownloaded} previously completed`);
        state.dockNotice = { text: `${bits.join(' · ')}. Review the list, then press Download selected.`, tone: 'ok' };
      }
    } else {
      state.dockNotice = { text: 'Nothing new to list for that query and range.', tone: 'plain' };
    }

    if (options.download) await downloadSelected();
  } finally {
    state.listing.busy = 'idle';
    state.listing.progress = null;
    render();
  }
}

async function fetchPage(serverId: string, tags: string, page: number): Promise<SearchResult | null> {
  const server = currentServer();
  const effectiveRating = state.listing.ratingOverride ?? server?.ratingFilterEnabled ?? false;
  const result = await send<SearchResult>({
    type: 'browse/search',
    payload: {
      serverId,
      spec: {
        tags,
        limit: 60,
        page,
        ratingFilter: { enabled: effectiveRating, allowed: server?.allowedRatings ?? [] },
      },
    },
  });
  if (!result) {
    state.listing.error = {
      message: 'The site did not answer the listing request.',
      kind: 'network-failure',
      hint: 'Try again, or raise the wait between requests in Settings.',
    };
    return null;
  }
  return result;
}

/** Filter one page's posts into the collection, counting what was skipped. */
function collectPosts(collected: BooruPost[], result: SearchResult): { added: number; skipped: number } {
  let added = 0;
  let skipped = 0;
  const seen = new Set(collected.map((post) => post.id));
  for (const post of result.posts) {
    if (seen.has(post.id)) continue;
    if (!postMatchesMedia(post, state.listing.media)) {
      skipped += 1;
      continue;
    }
    if (state.listing.skipDownloaded && state.history.has(`${post.serverId}:${post.id}`)) {
      skipped += 1;
      continue;
    }
    seen.add(post.id);
    collected.push(post);
    added += 1;
  }
  return { added, skipped };
}

function postLabel(post: BooruPost): string {
  const label = post.tags[0] ? `#${post.id} ${post.tags[0]}` : `${post.siteType} #${post.id}`;
  return post.fileAvailability === 'preview' ? `${label} [preview only]` : label;
}

// -------------------------------------------------------------- queue actions

async function downloadSelected(): Promise<void> {
  const ids = [...state.selection].filter((id) => state.queue.items.some((item) => item.id === id && item.status === 'pending'));
  if (!ids.length) {
    state.dockNotice = { text: 'Tick at least one queued row first.', tone: 'error' };
    renderDockBar();
    return;
  }
  state.queue.busy = true;
  state.dockNotice = { text: `Starting ${ids.length} download(s) — the queue keeps running while you browse.`, tone: 'ok' };
  renderDockBar();
  await send({ type: 'queue/run', payload: { itemIds: ids } });
  await refreshQueue();
  state.queue.busy = false;
  render();
  void watchQueue();
}

async function startQueue(): Promise<void> {
  state.queue.busy = true;
  renderDockBar();
  await send({ type: 'queue/run' });
  await refreshQueue();
  state.queue.busy = false;
  render();
  void watchQueue();
}

async function pauseQueue(paused: boolean): Promise<void> {
  await send({ type: paused ? 'queue/pause' : 'queue/resume' });
  await refreshQueue();
  render();
  if (!paused) void watchQueue();
}

async function stopQueue(): Promise<void> {
  await send({ type: 'queue/pause' });
  for (const item of state.queue.items.filter((entry) => entry.status === 'pending' || entry.status === 'running')) {
    await send({ type: 'queue/cancel', payload: { itemId: item.id } });
  }
  state.dockNotice = { text: 'Stop requested. Chrome may take a moment to confirm cancellation; canceled rows remain in the list.', tone: 'plain' };
  await refreshQueue();
  render();
}

async function cancelItem(itemId: string): Promise<void> {
  await send({ type: 'queue/cancel', payload: { itemId } });
  await refreshQueue();
  render();
}

async function removeItems(itemIds: string[]): Promise<void> {
  if (!itemIds.length) return;
  const result = await send<{ removed: number }>({ type: 'queue/remove', payload: { itemIds } });
  for (const id of itemIds) state.selection.delete(id);
  await refreshQueue();
  state.dockNotice = { text: `${result?.removed ?? 0} row(s) removed. Active transfers remain tracked; files on disk were not touched.`, tone: 'plain' };
  render();
}

async function retryFailed(): Promise<void> {
  if (state.queue.summary.unverified && !globalThis.confirm(`${state.queue.summary.unverified} row(s) have unverified prior starts. They may already be on disk. Check Chrome Downloads before retrying. Continue?`)) return;
  const result = await send<{ requeued: number; summary: QueueSummary }>({ type: 'queue/retryFailed' });
  await refreshQueue();
  if (result) toast(`${result.requeued} row(s) queued again`, 'success');
  state.dockNotice = { text: `${result?.requeued ?? 0} failed or unverified row(s) are queued again.`, tone: 'plain' };
  render();
}

async function clearQueue(scope: 'completed' | 'failed' | 'all'): Promise<void> {
  if (scope === 'all' && state.queue.items.length && !globalThis.confirm('Clear inactive rows? Active transfers remain tracked, and files on disk are not touched.')) return;
  await send({ type: 'queue/clear', payload: { scope } });
  await refreshQueue();
  render();
}

async function resetHistory(): Promise<void> {
  const result = await send<{ removed: number }>({ type: 'history/clear' });
  await refreshHistory();
  state.listing.skippedDownloaded = 0;
  toast(`Download history reset (${result?.removed ?? 0} entr${(result?.removed ?? 0) === 1 ? 'y' : 'ies'})`, 'success');
  render();
}

async function clearSearches(): Promise<void> {
  await send({ type: 'searches/clear' });
  await refreshSuggestions();
  toast('Search history cleared', 'success');
  render();
}

async function downloadPost(): Promise<void> {
  const route = state.context.route;
  const server = state.context.server;
  if (!route?.postId || !server) return;
  state.post = { ...state.post, busy: true };
  renderContext();
  const result = await send<{ filename: string; viaFallback: boolean; post: BooruPost }>({
    type: 'posts/download',
    payload: { serverId: server.id, postId: state.post.post?.id ?? route.postId },
  });
  state.post = { ...state.post, busy: false };
  if (result) {
    toast(`Started original file download: ${result.filename}. Track it in the queue.`, 'success');
    state.post = { ...state.post, post: result.post };
    await Promise.all([refreshQueue(), refreshHistory()]);
  }
  render();
}

async function addPostToList(): Promise<void> {
  const route = state.context.route;
  const server = state.context.server;
  if (!route?.postId || !server) return;
  const post = state.post.post;
  const result = await send<{ added: number; skipped: number }>({
    type: 'queue/enqueue',
    payload: {
      items: [
        {
          serverId: server.id,
          postId: post?.id ?? route.postId,
          label: post ? postLabel(post) : `#${route.postId}`,
          postUrl: post?.postUrl ?? route.canonicalUrl,
          expectedFileHash: post?.siteType === 'pawchive' ? post.md5 : null,
        },
      ],
    },
  });
  if (post) state.thumbnails.set(`${post.serverId}:${post.id}`, post.previewUrl);
  await refreshQueue();
  state.post = { ...state.post, queued: true };
  state.dockNotice = {
    text: result?.added ? `${post ? postLabel(post) : `#${route.postId}`} added to the list.` : 'That post is already in the list.',
    tone: result?.added ? 'ok' : 'plain',
  };
  render();
}

async function addAllPawchiveFiles(): Promise<void> {
  const route = state.context.route;
  const server = state.context.server;
  if (!route?.postId || !server || server.siteType !== 'pawchive') return;
  state.post = { ...state.post, busy: true };
  renderContext();
  const result = await send<{ added: number; skipped: number; unavailable: number }>({
    type: 'queue/enqueuePawchivePost',
    payload: { serverId: server.id, postId: route.postId },
  });
  state.post = { ...state.post, busy: false };
  await refreshQueue();
  if (result) {
    const parts = [`${result.added} original file(s) added`];
    if (result.skipped) parts.push(`${result.skipped} already queued or filtered`);
    if (result.unavailable) parts.push(`${result.unavailable} unavailable or preview-only`);
    state.dockNotice = { text: `${parts.join(' · ')}. Press Download selected to start.`, tone: result.unavailable ? 'plain' : 'ok' };
  }
  render();
}

// ------------------------------------------------------------------ polling

let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollTick = 0;

function startPolling(): void {
  if (pollTimer !== null) globalThis.clearInterval(pollTimer);
  pollTimer = globalThis.setInterval(() => {
    void (async () => {
      const active = state.queue.summary.running > 0 || state.queue.summary.active;
      pollTick += 1;
      const shouldRefreshQueue = active || state.tab === 'queue' || state.queue.summary.pending > 0;
      if (shouldRefreshQueue) await refreshQueue();
      if (active || pollTick % 5 === 0) await refreshHistory();
      // While the Links tab is collecting, the card is re-rendered from the
      // loop itself; outside a scan, keep its queue counters honest.
      if (state.tab === 'links' && !state.links.busy) await refreshLinks();
      if (state.tab === 'browse' || state.tab === 'queue' || state.tab === 'links') render();
    })();
  }, 1200);
}

/** Wait until the queue stops running (used right after starting a run). */
async function watchQueue(): Promise<void> {
  for (let attempt = 0; attempt < 900; attempt += 1) {
    await refreshQueue();
    render();
    if (state.queue.summary.paused) return;
    if (state.queue.summary.running === 0 && !state.queue.summary.active) return;
    await new Promise((resolve) => globalThis.setTimeout(resolve, 900));
  }
}

// -------------------------------------------------------------- server actions

function openEditor(server: ServerConfigView | null, siteType: string, baseUrl?: string): void {
  const draft = server ? draftFromServer(server) : draftForSiteType(siteType, state.adapters);
  state.editor = {
    draft: baseUrl ? { ...draft, baseUrl: hostnameOf(baseUrl) } : draft,
    isNew: !server,
    apiKeyMask: server?.apiKeyMask ?? '',
    validation: null,
    validatedSignature: null,
    validating: false,
    saving: false,
  };
  state.tab = 'servers';
  render();
}

function hostnameOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return url;
  }
}

async function validateDraft(): Promise<void> {
  const editor = state.editor;
  if (!editor || editor.validating || editor.saving) return;
  const draft = { ...editor.draft };
  const submitted = draftValidationSignature(draft);
  editor.validating = true;
  editor.validation = null;
  editor.validatedSignature = null;
  renderServersTab();
  const result = await send<ValidationResult>({ type: 'servers/validateDraft', payload: { server: draft } });
  if (state.editor !== editor) return;
  editor.validating = false;
  if (result && draftValidationSignature(editor.draft) === submitted) {
    editor.validation = result;
    editor.validatedSignature = submitted;
    toast(result.ok ? `Validated: ${result.message}` : `Not valid: ${result.message}`, result.ok ? 'success' : 'error', 6000);
  } else if (result) {
    toast('The connection changed during validation. Validate the current values again.', 'warning', 6000);
  }
  renderServersTab();
}

async function saveDraft(options: { force: boolean }): Promise<void> {
  const editor = state.editor;
  if (!editor || editor.saving || editor.validating) return;
  const decision = draftSaveDecision(editor, options.force);
  if (decision === 'blocked') {
    toast('Validation failed. Use "Save anyway" to store these values.', 'warning', 6000);
    return;
  }
  if (decision === 'validate') {
    const draft = { ...editor.draft };
    const submitted = draftValidationSignature(draft);
    editor.validating = true;
    editor.validation = null;
    editor.validatedSignature = null;
    renderServersTab();
    const result = await send<ValidationResult>({ type: 'servers/validateDraft', payload: { server: draft } });
    if (state.editor !== editor) return;
    editor.validating = false;
    if (!result || draftValidationSignature(editor.draft) !== submitted) {
      renderServersTab();
      toast('Saved nothing: validation did not complete for the current values.', 'warning', 6000);
      return;
    }
    editor.validation = result;
    editor.validatedSignature = submitted;
    renderServersTab();
    if (!result.ok) {
      toast('Saved nothing yet - validation failed. Use "Save anyway" to store it regardless.', 'warning', 6000);
      return;
    }
  }
  editor.saving = true;
  const draft = { ...editor.draft };
  renderServersTab();
  const saved = await send<ServerConfigView>({ type: 'servers/save', payload: draft });
  if (state.editor !== editor) return;
  if (saved) {
    state.editor = null;
    await refreshServers();
    await refreshDiagnostics();
    toast(`Saved ${saved.label}`, 'success');
    render();
  } else {
    editor.saving = false;
    renderServersTab();
    if (!options.force) toast('Save failed — see the message above', 'error');
  }
}

async function duplicateServer(id: string): Promise<void> {
  const created = await send<ServerConfigView>({ type: 'servers/duplicate', payload: { id } });
  if (created) {
    await refreshServers();
    toast(`Duplicated as ${created.label}`, 'success');
    render();
  }
}

async function deleteServer(server: ServerConfigView): Promise<void> {
  if (!globalThis.confirm(`Delete “${server.label}” and its stored credentials?`)) return;
  const remaining = await send<ServerConfigView[]>({ type: 'servers/remove', payload: { id: server.id } });
  if (remaining) {
    state.servers = remaining;
    await refreshServers();
    await refreshDiagnostics();
    render();
  }
}

async function validateServer(server: ServerConfigView): Promise<void> {
  state.busyId = server.id;
  renderServersTab();
  const result = await send<ValidationResult>({ type: 'servers/validate', payload: { id: server.id } });
  state.busyId = null;
  if (result) toast(`${server.label}: ${result.message}`, result.ok ? 'success' : 'error', 7000);
  await refreshServers();
  await refreshDiagnostics();
  render();
}

async function requestHostAccess(): Promise<void> {
  if (!state.hostAccess) return;
  const granted = await platform.permissions.request(state.hostAccess.origin);
  state.hostAccess = { ...state.hostAccess, granted };
  toast(granted ? 'Host access granted' : 'Access was not granted', granted ? 'success' : 'warning');
  render();
}

async function syncUserAgent(): Promise<void> {
  const result = await send<{ ok: boolean; applied: number; error?: string }>({ type: 'userAgent/sync' });
  toast(result?.ok ? `User-Agent rules synced (${result.applied})` : `Sync failed${result?.error ? `: ${result.error}` : ''}`, result?.ok ? 'success' : 'error');
}

// ------------------------------------------------------------- settings actions

const settingsUpdates = new OrderedUpdates();
const pendingSettingsFields = new Set<keyof ExtensionSettings>();

function applyConfirmedSettings(settings: ExtensionSettings): void {
  state.settings = settings;
  if (pendingSettingsFields.has('theme')) applyTheme(settings.theme);
  if (pendingSettingsFields.has('maxConcurrency')) state.queue.maxConcurrency = settings.maxConcurrency;
  if (pendingSettingsFields.has('mediaFilter')) state.listing.media = settings.mediaFilter;
  if (pendingSettingsFields.has('skipDownloaded')) state.listing.skipDownloaded = settings.skipDownloaded;
  pendingSettingsFields.clear();
}

async function patchSettings(patch: Partial<ExtensionSettings>): Promise<void> {
  if (!state.settings) return;
  // Keep the editor current while prior storage writes are in flight. Otherwise
  // an older response can replace text the user has already typed.
  for (const key of Object.keys(patch) as Array<keyof ExtensionSettings>) pendingSettingsFields.add(key);
  state.settings = { ...state.settings, ...patch };
  if (patch.theme) applyTheme(patch.theme);
  if (patch.maxConcurrency) state.queue.maxConcurrency = patch.maxConcurrency;
  if (patch.mediaFilter) state.listing.media = patch.mediaFilter;
  if (patch.skipDownloaded !== undefined) state.listing.skipDownloaded = patch.skipDownloaded;
  await settingsUpdates.run(
    () => send<ExtensionSettings>({ type: 'settings/save', payload: patch }),
    async (saved, isLatest) => {
      if (patch.searchHistoryEnabled !== undefined || patch.searchHistoryLimit !== undefined) await refreshSuggestions();
      if (!isLatest()) return;
      const current = saved ?? await send<ExtensionSettings>({ type: 'settings/get' });
      if (!isLatest()) return;
      if (current) applyConfirmedSettings(current);
      render();
    },
  );
}

async function saveSettingsAll(): Promise<void> {
  const snapshot = { ...state.settings };
  state.savingSettings = true;
  renderSettingsTab();
  await settingsUpdates.run(
    () => send<ExtensionSettings>({ type: 'settings/save', payload: snapshot }),
    (saved, isLatest) => {
      state.savingSettings = false;
      if (saved) {
        if (isLatest()) applyConfirmedSettings(saved);
        toast('Settings saved — User-Agent rules re-applied', 'success');
      }
      if (isLatest()) render();
    },
  );
}

async function resetSettings(): Promise<void> {
  if (!globalThis.confirm('Reset every setting to its default? Saved servers and keys are kept.')) return;
  for (const field of ['theme', 'maxConcurrency', 'mediaFilter', 'skipDownloaded'] as const) pendingSettingsFields.add(field);
  await settingsUpdates.run(
    () => send<ExtensionSettings>({ type: 'settings/reset' }),
    (saved, isLatest) => {
      if (saved) {
        if (isLatest()) applyConfirmedSettings(saved);
        toast('Settings reset to defaults', 'success');
      }
      if (isLatest()) render();
    },
  );
}

async function exportServers(includeSecrets: boolean): Promise<void> {
  const result = await send<{ json: string; includesSecrets: boolean }>({ type: 'servers/export', payload: { includeSecrets } });
  if (!result) return;
  const blob = new Blob([result.json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `booru-servers${includeSecrets ? '-with-keys' : ''}.json`;
  anchor.click();
  globalThis.setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast(includeSecrets ? 'Export written — it contains your API keys' : 'Export written (no keys)', includeSecrets ? 'warning' : 'success');
}

async function importServers(json: string, includeSecrets: boolean): Promise<void> {
  const result = await send<{ imported: number; skipped: number; errors: string[] }>({ type: 'servers/import', payload: { json, includeSecrets } });
  if (!result) return;
  await refreshServers();
  await refreshDiagnostics();
  toast(`Imported ${result.imported} profile(s)${result.skipped ? `, ${result.skipped} skipped` : ''}`, 'success');
  render();
}

async function clearAllCredentials(): Promise<void> {
  for (const server of state.servers) await send({ type: 'servers/clearCredentials', payload: { id: server.id } });
  await refreshServers();
  toast('Stored keys deleted from every profile', 'success');
  render();
}

// ------------------------------------------------------------------ servers tab

function renderServersTab(): void {
  if (state.editor) {
    const editor = state.editor;
    const adapter = getAdapter(editor.draft.siteType);
    const host = h('div');
    renderServerForm(
      host,
      {
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
        validatedCurrentValues: editor.validatedSignature === draftValidationSignature(editor.draft),
        saving: editor.saving,
      },
      {
        onChange: (patch) => {
          if (state.editor !== editor || editor.saving) return;
          const before = draftValidationSignature(editor.draft);
          const previousSiteType = editor.draft.siteType;
          editor.draft = { ...editor.draft, ...patch };
          if (patch.siteType && patch.siteType !== previousSiteType) {
            editor.draft = withSiteDefaults(editor.draft, patch.siteType, state.adapters);
            editor.apiKeyMask = '';
          }
          if (draftValidationSignature(editor.draft) !== before) {
            editor.validation = null;
            editor.validatedSignature = null;
          }
          renderServersTab();
        },
        onValidate: () => void validateDraft(),
        onSave: (options) => void saveDraft(options),
        onCancel: () => {
          state.editor = null;
          render();
        },
        onSuggestUserAgent: () => {
          if (!state.editor) return;
          const current = getAdapter(state.editor.draft.siteType);
          const suggested = current?.suggestUserAgent({
            server: { username: state.editor.draft.username, userId: state.editor.draft.userId, customUserAgent: state.editor.draft.customUserAgent },
            baseUrl: state.editor.draft.baseUrl,
          });
          state.editor.draft = { ...state.editor.draft, customUserAgent: suggested ?? '' };
          state.editor.validation = null;
          state.editor.validatedSignature = null;
          renderServersTab();
        },
        onBackToList: () => {
          state.editor = null;
          render();
        },
      },
    );
    preserveInputFocus(els.serversHost, () => els.serversHost.replaceChildren(...(Array.from(host.children) as HTMLElement[])));
    return;
  }

  const container = h('div');
  const listHost = h('div');
  renderServerList(
    listHost,
    { servers: state.servers, adapters: state.adapters, busyId: state.busyId, filter: state.serverFilter },
    {
      onAdd: (siteType?: string) => openEditor(null, siteType ?? 'e621'),
      onEdit: (server) => openEditor(server, server.siteType),
      onDuplicate: (server) => void duplicateServer(server.id),
      onDelete: (server) => void deleteServer(server),
      onSetDefault: async (server) => {
        const updated = await send<ServerConfigView[]>({ type: 'servers/setDefault', payload: { id: server.id } });
        if (updated) {
          state.servers = updated;
          state.listing.serverId = server.id;
          toast(`${server.label} is now the default server`, 'success');
          render();
        }
      },
      onTest: (server) => void validateServer(server),
      onFilterChange: (value) => {
        state.serverFilter = value;
        renderServersTab();
      },
      onOpenQueue: () => switchTab('queue'),
    },
  );
  for (const child of Array.from(listHost.children)) container.appendChild(child);

  // Diagnostics live here too: "why did this profile fail" belongs next to the list.
  if (state.diagnostics) {
    const details = h('details', { class: 'psCard psDiagnostics' });
    details.appendChild(h('summary', { text: 'Diagnostics — adapter capabilities, environment, redacted traces (review before sharing)' }));
    const host = h('div');
    renderDiagnostics(host, state.diagnostics, {
      onSyncUserAgent: () => void syncUserAgent(),
      onCopy: () => {
        copyDiagnostics(state.diagnostics!);
        toast('Diagnostics copied — review before sharing', 'success');
      },
      onOpenApiDocs: (url: string) => globalThis.open(url, '_blank', 'noreferrer'),
    });
    for (const child of Array.from(host.children)) details.appendChild(child);
    container.appendChild(details);
  }
  preserveInputFocus(els.serversHost, () => els.serversHost.replaceChildren(...(Array.from(container.children) as HTMLElement[])));
}

// ------------------------------------------------------------------ settings tab

function renderSettingsTab(): void {
  if (!state.settings) {
    els.settingsHost.replaceChildren(h('p', { class: 'psMuted', text: 'Loading settings…' }));
    return;
  }
  const host = h('div');
  renderSettingsSections(
    host,
    {
      settings: state.settings,
      saving: state.savingSettings,
      servers: state.servers,
      adapters: state.adapters,
      historyCount: state.historyCount,
      searchCount: state.searchCount,
      hostAccess: state.hostAccess,
    },
    {
      onChange: (patch) => void patchSettings(patch),
      onSave: () => void saveSettingsAll(),
      onReset: () => void resetSettings(),
      onExport: (includeSecrets) => void exportServers(includeSecrets),
      onImport: (json, includeSecrets) => void importServers(json, includeSecrets),
      onClearAllCredentials: () => void clearAllCredentials(),
      onSyncUserAgent: () => void syncUserAgent(),
      onRequestHostAccess: () => void requestHostAccess(),
      onClearHistory: () => void resetHistory(),
      onClearSearches: () => void clearSearches(),
      onOpenServers: () => switchTab('servers'),
    },
  );
  preserveInputFocus(els.settingsHost, () => els.settingsHost.replaceChildren(...(Array.from(host.children) as HTMLElement[])));
}

// ---------------------------------------------------------------------- start

globalThis.addEventListener?.('hashchange', () => {
  const next = hashTab();
  if (next && next !== state.tab) {
    state.tab = next;
    render();
  }
});

void boot();
