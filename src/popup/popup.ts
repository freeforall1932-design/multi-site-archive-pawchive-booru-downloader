/**
 * Popup: quick switching between saved servers, post-page download, and a small
 * tag search that feeds the same batch queue as the options page.
 */
import { registerBuiltinAdapters } from '../adapters/index.js';
import type { UiRequest } from '../core/messages.js';
import { isUsableServer } from '../core/servers.js';
import { getPlatform, isExtensionEnvironment } from '../platform/index.js';
import type {
  BooruPost,
  QueueSummary,
  RouteMatch,
  SearchResult,
  ServerConfigView,
} from '../shared/types.js';
import { button, clear, h } from '../ui/dom.js';
import { ratingChip, siteTypeChip, validationDot } from '../ui/format.js';
import { postImage } from '../ui/post-image.js';
import { showError, toast } from '../ui/toast.js';

const platform = getPlatform();
const view = document.getElementById('popup-view') as HTMLElement;

interface PopupState {
  servers: ServerConfigView[];
  activeServerId: string | null;
  route: (RouteMatch & { server: ServerConfigView | null }) | null;
  post: BooruPost | null;
  postError: string | null;
  results: SearchResult | null;
  tags: string;
  busy: boolean;
  summary: QueueSummary;
}

const state: PopupState = {
  servers: [],
  activeServerId: null,
  route: null,
  post: null,
  postError: null,
  results: null,
  tags: '',
  busy: false,
  summary: { pending: 0, running: 0, done: 0, failed: 0, skipped: 0, canceled: 0, unverified: 0, total: 0, paused: false, active: false },
};

async function send<T>(request: UiRequest): Promise<T | null> {
  const response = await platform.send(request);
  if (!response.ok) {
    showError(response.error);
    return null;
  }
  return response.data as T;
}

function activeServer(): ServerConfigView | null {
  return state.servers.find((server) => server.id === state.activeServerId) ?? state.servers.find((server) => server.isDefault) ?? state.servers[0] ?? null;
}

function render(): void {
  clear(view);

  if (!state.servers.length) {
    view.appendChild(
      h(
        'div',
        { class: 'popup-card popup-empty' },
        h('h2', { text: 'No servers yet' }),
        h('p', { class: 'muted', text: 'Add a server profile (site type, base URL, credentials) to start downloading.' }),
        button('Open server manager', { variant: 'primary', onClick: () => platform.openOptions('servers') }),
      ),
    );
    return;
  }

  const server = activeServer();

  // ------------------------------------------------------------- server card
  const select = h('select', {
    class: 'input',
    on: {
      change: async (event) => {
        state.activeServerId = (event.target as HTMLSelectElement).value;
        render();
      },
    },
  });
  for (const entry of state.servers) {
    select.appendChild(
      h('option', { value: entry.id, text: `${entry.label} · ${entry.siteType}`, selected: entry.id === server?.id }),
    );
  }

  view.appendChild(
    h(
      'div',
      { class: 'popup-card' },
      h('h2', { text: 'Server' }),
      h('div', { class: 'popup-row' }, select),
      h(
        'div',
        { class: 'popup-row', style: 'flex-wrap:wrap' },
        server ? validationDot(server.validationStatus, server.validationMessage) : null,
        server ? siteTypeChip(server.siteType) : null,
        server ? h('span', { class: 'muted small', text: server.ratingFilterEnabled ? `ratings: ${(server.allowedRatings ?? []).join(', ') || 'all'}` : 'rating filter off' }) : null,
        server && !server.isDefault ? button('Make default', { variant: 'subtle', onClick: () => void makeDefault(server.id) }) : h('span', { class: 'chip chip-default', text: 'DEFAULT' }),
      ),
      h(
        'div',
        { class: 'popup-row' },
        button('Manager', { variant: 'subtle', iconName: 'settings', onClick: () => platform.openOptions('servers') }),
        button('Browse', { variant: 'subtle', iconName: 'search', onClick: () => platform.openOptions('browse') }),
        button('Queue', { variant: 'subtle', iconName: 'queue', onClick: () => platform.openOptions('queue') }),
      ),
    ),
  );

  // -------------------------------------------------------------- page card
  view.appendChild(renderPageCard(server));

  // ------------------------------------------------------------ search card
  const tagsInput = h('input', {
    class: 'input',
    type: 'search',
    placeholder: 'tags…',
    value: state.tags,
    on: {
      input: (event) => {
        state.tags = (event.target as HTMLInputElement).value;
      },
      keydown: (event) => {
        if ((event as KeyboardEvent).key === 'Enter') void search();
      },
    },
  });
  view.appendChild(
    h(
      'div',
      { class: 'popup-card' },
      h('h2', { text: 'Quick search' }),
      h('div', { class: 'popup-row' }, tagsInput, button(state.busy ? '…' : 'Go', { variant: 'primary', disabled: state.busy, onClick: () => void search() })),
      state.results
        ? h(
            'div',
            {},
            h('p', { class: 'muted small', text: `${state.results.posts.length} result(s) · ${state.results.appliedTags || 'no tags'}` }),
            h(
              'div',
              { class: 'popup-grid' },
              ...state.results.posts.slice(0, 9).map((post) => postTile(post)),
            ),
            h(
              'div',
              { class: 'popup-row' },
              button('Queue all', { iconName: 'queue', onClick: () => void queueAll() }),
              button('Open in manager', { variant: 'subtle', onClick: () => platform.openOptions('browse') }),
            ),
          )
        : null,
    ),
  );

  // ------------------------------------------------------------- queue card
  view.appendChild(
    h(
      'div',
      { class: 'popup-card popup-footer' },
      h('span', { text: `${state.summary.pending} pending · ${state.summary.running} running · ${state.summary.done} done` }),
      h(
        'div',
        { class: 'popup-row' },
        button('Start', { variant: 'subtle', iconName: 'play', disabled: state.summary.active || state.summary.pending === 0, onClick: () => void runQueue() }),
        button('Queue', { variant: 'subtle', onClick: () => platform.openOptions('queue') }),
      ),
    ),
  );
}

function renderPageCard(server: ServerConfigView | null): HTMLElement {
  if (!state.route) {
    return h(
      'div',
      { class: 'popup-card' },
      h('h2', { text: 'This page' }),
      h('p', { class: 'muted small', text: 'Not a recognized booru post page. Open a post on a saved server, or use quick search below.' }),
    );
  }
  if (state.route.kind !== 'post') {
    const route = state.route;
    return h(
      'div',
      { class: 'popup-card' },
      h('h2', { text: 'This page' }),
      h('div', { class: 'popup-row' }, siteTypeChip(route.siteType), h('span', { class: 'muted small', text: `${route.kind} page` })),
      route.tags
        ? button('Search these tags', {
            variant: 'subtle',
            iconName: 'search',
            onClick: () => {
              state.tags = route.tags ?? '';
              void search();
            },
          })
        : null,
    );
  }

  const post = state.post;
  return h(
    'div',
    { class: 'popup-card' },
    h('h2', { text: 'This post' }),
    state.postError
      ? h('p', { class: 'muted small', text: state.postError })
      : post
        ? h(
            'div',
            { class: 'popup-post' },
            postImage(post, { alt: `post ${post.id}` }),
            h(
              'div',
              {},
              h('div', { class: 'popup-row' }, h('strong', { text: `#${post.id}` }), ratingChip(post.rating),
                post.fileAvailability === 'preview' ? h('span', { class: 'chip chip-soft', text: 'preview only' }) : null),
              h('div', { class: 'muted small', text: `${post.ext ?? '?'} · ${post.width ?? '?'}×${post.height ?? '?'}` }),
              h('div', { class: 'muted small truncate', text: post.tags.slice(0, 5).join(' ') }),
              h(
                'div',
                { class: 'popup-row' },
                button('Download', { variant: 'primary', iconName: 'download', onClick: () => void downloadPost(post) }),
                button('Queue', { iconName: 'queue', onClick: () => void queuePost(post) }),
              ),
            ),
          )
        : h('p', { class: 'muted small', text: 'Loading post…' }),
    post ? h('div', { class: 'popup-row' }, post.siteType === 'hydrus'
      ? h('span', { class: 'muted small', text: 'Open this file in the Hydrus client.' })
      : h('a', { class: 'link small', href: post.postUrl, target: '_blank', rel: 'noreferrer', text: 'Open post page' })) : null,
    server ? h('span', { class: 'muted small', text: `via ${server.label}` }) : null,
  );
}

function postTile(post: BooruPost): HTMLElement {
  return h(
    'figure',
    {},
    postImage(post, {
      alt: `post ${post.id}`,
      title: post.siteType === 'hydrus' ? 'Open this file in the Hydrus client' : `${post.tags.slice(0, 8).join(' ')}`,
      loading: 'lazy',
      on: { click: () => { if (post.siteType !== 'hydrus') globalThis.open(post.postUrl, '_blank', 'noopener'); } },
    }),
    post.fileAvailability === 'preview' ? h('figcaption', { class: 'small', text: 'preview only' }) : null,
    h('div', { class: 'popup-grid-actions' }, button('↓', { title: 'Download', onClick: () => void downloadPost(post) }), button('+', { title: 'Add to queue', onClick: () => void queuePost(post) })),
  );
}

// ------------------------------------------------------------------- actions

async function makeDefault(id: string): Promise<void> {
  const servers = await send<ServerConfigView[]>({ type: 'servers/setDefault', payload: { id } });
  if (servers) {
    state.servers = servers.filter(isUsableServer);
    state.activeServerId = id;
    toast('Default server updated', 'success');
    render();
  }
}

async function downloadPost(post: BooruPost): Promise<void> {
  const result = await send<{ filename: string; post: BooruPost }>({ type: 'posts/download', payload: { serverId: post.serverId, postId: post.id } });
  if (result) {
    toast(`Started original file download: ${result.filename}`, 'success');
  }
}

async function queuePost(post: BooruPost): Promise<void> {
  const result = await send<{ added: number; skipped: number; summary: QueueSummary }>({
    type: 'queue/enqueuePosts',
    payload: { serverId: post.serverId, posts: [{ id: post.id, label: `${post.siteType} #${post.id}${post.fileAvailability === 'preview' ? ' [preview only]' : ''}`, postUrl: post.postUrl, rating: post.rating, expectedFileHash: post.siteType === 'pawchive' ? post.md5 : null }] },
  });
  if (result) {
    state.summary = result.summary;
    toast(result.added ? 'Added to queue' : 'Already in the queue or filtered out', result.added ? 'success' : 'warning');
    render();
  }
}

async function queueAll(): Promise<void> {
  const server = activeServer();
  if (!server || !state.results) return;
  const result = await send<{ added: number; skipped: number; summary: QueueSummary }>({
    type: 'queue/enqueuePosts',
    payload: {
      serverId: server.id,
      posts: state.results.posts.map((post) => ({ id: post.id, label: `${post.siteType} #${post.id}${post.fileAvailability === 'preview' ? ' [preview only]' : ''}`, postUrl: post.postUrl, rating: post.rating, expectedFileHash: post.siteType === 'pawchive' ? post.md5 : null })),
    },
  });
  if (result) {
    state.summary = result.summary;
    toast(`Queued ${result.added}${result.skipped ? `, skipped ${result.skipped}` : ''}`, 'success');
    render();
  }
}

async function search(): Promise<void> {
  const server = activeServer();
  if (!server) return;
  state.busy = true;
  render();
  const result = await send<SearchResult>({
    type: 'browse/search',
    payload: { serverId: server.id, spec: { tags: state.tags, limit: 9, page: 1 } },
  });
  state.busy = false;
  state.results = result;
  render();
}

async function runQueue(): Promise<void> {
  await send({ type: 'queue/run' });
  await refreshQueue();
  toast('Queue started', 'success');
}

async function refreshQueue(): Promise<void> {
  const result = await send<{ summary: QueueSummary }>({ type: 'queue/list' });
  if (result) state.summary = result.summary;
}

async function loadPostForRoute(): Promise<void> {
  if (!state.route || state.route.kind !== 'post') return;
  const server = state.route.server ?? activeServer();
  if (!server) return;
  const post = await send<BooruPost>({ type: 'posts/get', payload: { serverId: server.id, postId: state.route.postId ?? '' } });
  if (post) state.post = post;
  else state.postError = 'Could not load this post. Check the server credentials or validation status.';
  render();
}

async function boot(): Promise<void> {
  if (!isExtensionEnvironment()) {
    const { startPreview } = await import('../preview/preview.js');
    await startPreview();
  }
  registerBuiltinAdapters();
  const [servers, tabUrl, queue] = await Promise.all([
    send<ServerConfigView[]>({ type: 'servers/list' }),
    platform.activeTabUrl(),
    send<{ summary: QueueSummary }>({ type: 'queue/list' }),
  ]);
  state.servers = (servers ?? []).filter(isUsableServer);
  state.summary = queue?.summary ?? state.summary;
  state.activeServerId = state.servers.find((server) => server.isDefault)?.id ?? state.servers[0]?.id ?? null;

  if (tabUrl) {
    state.route = await send<RouteMatch & { server: ServerConfigView | null }>({ type: 'routes/detect', payload: { url: tabUrl } });
  }

  document.getElementById('open-options')?.addEventListener('click', () => platform.openOptions('servers'));
  document.getElementById('open-panel')?.addEventListener('click', () => {
    void platform.openPanel().then((opened) => {
      if (opened) globalThis.close();
      else platform.openOptions('settings');
    });
  });
  render();
  if (state.route?.kind === 'post') void loadPostForRoute();
}

void boot();
