import type { AdapterCatalogEntry } from '../core/messages.js';
import type { BooruPost, Rating, SearchResult, ServerConfigView } from '../shared/types.js';
import { failureLabel } from '../shared/errors.js';
import { button, h } from './dom.js';
import { ratingChip, siteTypeChip } from './format.js';

export interface BrowseState {
  servers: ServerConfigView[];
  adapters: AdapterCatalogEntry[];
  serverId: string | null;
  tags: string;
  limit: number;
  overrideRatingFilter: boolean | null;
  results: SearchResult | null;
  posts: BooruPost[];
  /** Post ids selected for queueing. */
  selection: Set<string>;
  busy: boolean;
  error: { message: string; kind: string; hint: string | null } | null;
  page: number;
  queueCount: number;
}

export interface BrowseCallbacks {
  onServerChange(id: string): void;
  onTagsChange(tags: string): void;
  onLimitChange(limit: number): void;
  onToggleRatingOverride(): void;
  onSearch(reset: boolean): void;
  onLoadMore(): void;
  onToggleSelect(postId: string): void;
  onSelectAll(): void;
  onClearSelection(): void;
  onDownloadPost(post: BooruPost): void;
  onQueueSelected(): void;
  onQueueAll(): void;
  onOpenQueue(): void;
  onQuickTag(tag: string): void;
}

const QUICK_TAGS = ['rating:safe', 'order:score', 'order:random', 'score:>100'];

/** Browse/search screen: fetch a tag listing from any saved server. */
export function renderBrowse(container: HTMLElement, state: BrowseState, callbacks: BrowseCallbacks): void {
  container.replaceChildren();
  const server = state.servers.find((entry) => entry.id === state.serverId) ?? null;
  const adapter = server ? state.adapters.find((entry) => entry.siteType === server.siteType) ?? null : null;
  const supportsRatingFilter = adapter?.supportsRatingFilter ?? false;

  container.appendChild(
    h(
      'div',
      { class: 'view-header' },
      h('div', {}, h('h1', { text: 'Browse' }), h('p', { class: 'muted', text: 'Tag search across your saved servers.' })),
      h('div', { class: 'header-actions' }, button('Open queue', { iconName: 'queue', onClick: () => callbacks.onOpenQueue() })),
    ),
  );

  if (!state.servers.length) {
    container.appendChild(h('div', { class: 'empty-state' }, h('h2', { text: 'No servers yet' }), h('p', { class: 'muted', text: 'Add a server on the Servers tab first.' })));
    return;
  }

  // -------------------------------------------------------------- search bar
  const serverSelect = h('select', {
    class: 'input',
    on: { change: (event) => callbacks.onServerChange((event.target as HTMLSelectElement).value) },
  });
  for (const entry of state.servers) {
    serverSelect.appendChild(
      h('option', { value: entry.id, text: `${entry.label} · ${entry.siteType}${entry.isDefault ? ' (default)' : ''}`, selected: entry.id === state.serverId }),
    );
  }

  const tagInput = h('input', {
    class: 'input',
    type: 'search',
    placeholder: 'e.g. cat solo rating:safe  (site tag syntax)',
    value: state.tags,
    on: {
      input: (event) => callbacks.onTagsChange((event.target as HTMLInputElement).value),
      keydown: (event) => {
        if ((event as KeyboardEvent).key === 'Enter') {
          event.preventDefault();
          callbacks.onSearch(true);
        }
      },
    },
  });

  const limitSelect = h('select', {
    class: 'input',
    on: { change: (event) => callbacks.onLimitChange(Number((event.target as HTMLSelectElement).value)) },
  });
  for (const value of [10, 25, 50, 100]) {
    limitSelect.appendChild(h('option', { value: String(value), text: `${value} posts`, selected: value === state.limit }));
  }

  container.appendChild(
    h(
      'div',
      { class: 'card search-bar' },
      h('div', { class: 'search-row' }, serverSelect, tagInput, limitSelect, button(state.busy ? 'Searching…' : 'Search', { variant: 'primary', iconName: 'search', disabled: state.busy, onClick: () => callbacks.onSearch(true) })),
      h(
        'div',
        { class: 'search-row wrap' },
        ...QUICK_TAGS.map((tag) => button(tag, { variant: 'subtle', onClick: () => callbacks.onQuickTag(tag) })),
        supportsRatingFilter && server
          ? h(
              'label',
              { class: 'checkbox-chip' },
              h('input', {
                type: 'checkbox',
                checked: state.overrideRatingFilter !== null ? state.overrideRatingFilter : server.ratingFilterEnabled,
                on: { change: () => callbacks.onToggleRatingOverride() },
              }),
              h('span', { text: `apply rating filter (${(server.allowedRatings ?? []).join(', ') || 'none'})` }),
            )
          : h('span', { class: 'muted small', text: 'This site type has no rating filter support.' }),
      ),
    ),
  );

  if (state.error) {
    container.appendChild(
      h(
        'div',
        { class: 'card error-panel' },
        h('strong', { text: failureLabel(state.error.kind as never) ?? 'Request failed' }),
        h('p', { text: state.error.message }),
        state.error.hint ? h('p', { class: 'muted small', text: state.error.hint }) : null,
      ),
    );
  }

  if (!state.results && !state.busy) {
    container.appendChild(h('p', { class: 'muted', text: 'Enter tags and press Search. Two tags work everywhere; site-specific metatags pass through unchanged.' }));
    return;
  }

  // ------------------------------------------------------------- result grid
  const selectionCount = state.selection.size;
  container.appendChild(
    h(
      'div',
      { class: 'result-toolbar' },
      h('span', {
        class: 'muted small',
        text: `${state.posts.length} post(s) loaded${state.results?.totalCount ? ` of ~${state.results.totalCount}` : ''} · page ${state.page}`,
      }),
      h('span', { class: 'muted small mono', text: state.results ? `query: ${state.results.appliedTags || '(none)'}` : '' }),
      h('div', { class: 'header-actions' }, [
        button('Select all', { variant: 'subtle', onClick: () => callbacks.onSelectAll() }),
        button(`Clear (${selectionCount})`, { variant: 'subtle', onClick: () => callbacks.onClearSelection() }),
        button(`Queue selected (${selectionCount})`, { variant: 'primary', iconName: 'queue', disabled: selectionCount === 0, onClick: () => callbacks.onQueueSelected() }),
        button('Queue all loaded', { iconName: 'download', onClick: () => callbacks.onQueueAll() }),
      ]),
    ),
  );

  const grid = h('div', { class: 'post-grid' });
  for (const post of state.posts) grid.appendChild(postCard(post, state, callbacks));
  container.appendChild(grid);

  const footer = h('div', { class: 'result-footer' });
  if (state.results?.hasMore) footer.appendChild(button('Load more', { iconName: 'plus', disabled: state.busy, onClick: () => callbacks.onLoadMore() }));
  footer.appendChild(h('span', { class: 'muted small', text: `${state.queueCount} item(s) in queue` }));
  container.appendChild(footer);
}

function postCard(post: BooruPost, state: BrowseState, callbacks: BrowseCallbacks): HTMLElement {
  const selected = state.selection.has(post.id);
  const blocked = (post.rating === 'questionable' || post.rating === 'explicit') && !selected;
  return h(
    'article',
    { class: `post-card${selected ? ' is-selected' : ''}${blocked ? ' is-gated' : ''}` },
    h(
      'label',
      { class: 'post-select' },
      h('input', {
        type: 'checkbox',
        checked: selected,
        on: { change: () => callbacks.onToggleSelect(post.id) },
      }),
    ),
    h('img', {
      class: 'post-thumb',
      src: post.previewUrl || undefined,
      alt: `${post.siteType} post ${post.id}`,
      loading: 'lazy',
      on: { error: (event) => ((event.target as HTMLImageElement).classList.add('is-broken')) },
    }),
    h(
      'div',
      { class: 'post-info' },
      h('div', { class: 'post-title' }, h('strong', { text: `#${post.id}` }), ratingChip(post.rating),
        post.fileAvailability === 'preview' ? h('span', { class: 'chip chip-soft', text: 'preview only' }) : null),
      h('div', { class: 'muted small', text: `${post.ext ?? '?'} · ${post.width ?? '?'}×${post.height ?? '?'}${post.score !== null ? ` · score ${post.score}` : ''}` }),
      h('div', { class: 'muted small truncate', text: post.tags.slice(0, 6).join(' ') || '(no tags reported)' }),
      siteTypeChip(post.siteType),
    ),
    h(
      'div',
      { class: 'post-actions' },
      button('Download', { iconName: 'download', onClick: () => callbacks.onDownloadPost(post) }),
      button('Queue', { iconName: 'queue', onClick: () => callbacks.onToggleSelect(post.id) }),
      h('a', { class: 'link', href: post.postUrl, target: '_blank', rel: 'noreferrer', text: 'Open post' }),
    ),
  );
}

export const RATING_ORDER: Rating[] = ['general', 'safe', 'sensitive', 'questionable', 'explicit'];
