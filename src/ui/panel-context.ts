/**
 * The two "what am I looking at?" cards at the top of the side panel.
 *
 *  - **Tab status** - reads the active tab, says which saved server it belongs
 *    to (or that the page is not a supported booru) and offers a refresh button.
 *    This is the Rule 34 / X-downloader pattern: the panel never makes the user
 *    guess which profile will be used.
 *  - **This post** - when the active tab *is* a post page: thumbnail, title,
 *    meta, "Download this post" and "Add to list".
 */
import type { BooruPost, RouteMatch, ServerConfigView } from '../shared/types.js';
import { relativeTime } from '../shared/util.js';
import { postImage } from './post-image.js';
import { button, h } from './dom.js';
import { kindLabel, ratingChip, siteTypeChip } from './format.js';

export interface TabContext {
  checking: boolean;
  url: string | null;
  route: RouteMatch | null;
  /** Saved profile that owns the route, when one is configured. */
  server: ServerConfigView | null;
  /** True when the page is a booru page but no saved profile matches it. */
  missingProfile: boolean;
  /** True when the route resolved against a *different* profile than the selected one. */
  differentProfile: ServerConfigView | null;
}

export interface TabContextCallbacks {
  onRefresh(): void;
  onAddServer(): void;
  onUseRoute(): void;
}

/** Status dot + one-line explanation of the active tab. */
export function renderTabContext(container: HTMLElement, state: TabContext, callbacks: TabContextCallbacks): void {
  container.replaceChildren();
  container.className = 'psTabStatus';

  const tone = state.checking ? 'active' : state.route ? (state.server ? 'ok' : 'warn') : 'warn';
  container.classList.add(tone);

  container.appendChild(h('span', { class: 'psDot', attrs: { 'aria-hidden': 'true' } }));

  const text = h('div', { class: 'psTabText' });
  if (state.checking) {
    text.appendChild(h('strong', { text: 'Reading the active tab…' }));
    text.appendChild(h('span', { text: 'Checking whether this page belongs to one of your servers.' }));
  } else if (!state.url) {
    text.appendChild(h('strong', { text: 'No active tab' }));
    text.appendChild(h('span', { text: 'Open a booru page, or just search below - the panel works without one.' }));
  } else if (state.route && state.server) {
    text.appendChild(
      h(
        'strong',
        {},
        siteTypeChip(state.route.siteType),
        h('span', { text: describeRoute(state.route, state.server) }),
      ),
    );
    text.appendChild(
      h('span', {
        text:
          state.route.serverId && state.route.serverId !== state.server.id
            ? `Saved profile: ${state.server.label} (another profile also matches this host)`
            : `Saved profile: ${state.server.label}`,
      }),
    );
  } else if (state.route) {
    text.appendChild(
      h('strong', {}, siteTypeChip(state.route.siteType), h('span', { text: describeRoute(state.route, null) })),
    );
    text.appendChild(h('span', { text: 'No saved profile for this host yet - add one to download from it.' }));
  } else {
    text.appendChild(h('strong', { text: 'This page is not a supported booru' }));
    text.appendChild(
      h('span', {
        text: state.url ? shortUrl(state.url) : 'Nothing to detect. Search below to use the panel as a browser.',
      }),
    );
  }
  container.appendChild(text);

  const actions = h('div', { class: 'psTabActions' });
  if (state.route && !state.server) {
    actions.appendChild(button('Add server', { variant: 'subtle', onClick: () => callbacks.onAddServer() }));
  } else if (state.route && state.route.kind !== 'post' && state.server) {
    actions.appendChild(button('Use this search', { variant: 'subtle', onClick: () => callbacks.onUseRoute() }));
  }
  actions.appendChild(
    h('button', {
      class: 'psIconButton',
      type: 'button',
      title: 'Re-read the active tab',
      ariaLabel: 'Re-read the active tab',
      text: '⟳',
      onClick: () => callbacks.onRefresh(),
    }),
  );
  container.appendChild(actions);
}

function describeRoute(route: RouteMatch, server: ServerConfigView | null): string {
  const kind: Record<RouteMatch['kind'], string> = {
    post: 'post',
    search: 'search page',
    tag: 'tag listing',
    pool: 'pool',
    index: 'index page',
    unknown: 'page',
  };
  const bits: string[] = [`${kind[route.kind]}`];
  if (route.postId) bits.push(`#${route.postId}`);
  if (route.tags) bits.push(`“${route.tags}”`);
  if (route.page && route.page > 1) bits.push(`page ${route.page}`);
  if (server) bits.push(server.isDefault ? 'default profile' : '');
  return ` — ${bits.filter(Boolean).join(' · ')}`;
}

function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`.slice(0, 70);
  } catch {
    return url.slice(0, 70);
  }
}

export interface PostCardState {
  loading: boolean;
  post: BooruPost | null;
  error: { message: string; kind: string; hint: string | null } | null;
  /** Post is already in the queue as a pending/running item. */
  queued: boolean;
  /** Post was downloaded before (found in the download history). */
  saved: { filename: string; at: string } | null;
  busy: boolean;
  /** Rating filter blocks this post (so "Download" would be refused). */
  blocked: boolean;
}

export interface PostCardCallbacks {
  onDownload(): void;
  onAddToList(): void;
  /** Available for Pawchive post pages, including when the first file is deferred. */
  onAddAllPawchiveFiles?(): void;
  onReload(): void;
}

/** The card shown when the active tab is a single post. */
export function renderPostCard(container: HTMLElement, state: PostCardState, callbacks: PostCardCallbacks): void {
  container.replaceChildren();
  container.className = 'psCard';
  if (state.loading) {
    container.appendChild(h('div', { class: 'psCardHead' }, h('strong', { text: 'Loading this post…' })));
    return;
  }
  if (state.error) {
    container.appendChild(
      h(
        'div',
        { class: 'psCardHead' },
        h('strong', { text: `${kindLabel(state.error.kind)} — could not read this post` }),
      ),
    );
    container.appendChild(h('p', { class: 'psHint', text: state.error.message }));
    if (state.error.hint) container.appendChild(h('p', { class: 'psHint', text: state.error.hint }));
    container.appendChild(
      h('div', { class: 'psActionRow' },
        button('Try again', { variant: 'subtle', onClick: () => callbacks.onReload() }),
        callbacks.onAddAllPawchiveFiles ? button('Add all available files', {
          disabled: state.busy, onClick: () => callbacks.onAddAllPawchiveFiles?.(),
        }) : null,
      ),
    );
    return;
  }
  const post = state.post;
  if (!post) {
    container.appendChild(h('div', { class: 'psCardHead' }, h('strong', { text: 'No post selected' })));
    return;
  }

  const row = h('div', { class: 'psPostRow' });
  row.appendChild(
    postImage(post, {
      class: 'psPostThumb',
      alt: `Preview of post ${post.id}`,
      loading: 'lazy',
      on: { error: (event) => (event.target as HTMLImageElement).classList.add('psBroken') },
    }),
  );
  const info = h('div', { class: 'psPostInfo' });
  info.appendChild(
    h(
      'strong',
      { class: 'psPostTitle' },
      `#${post.id}`,
      ratingChip(post.rating),
      post.isVideo ? h('span', { class: 'psBadge psBadgeVideo', text: 'video' }) : null,
      post.fileAvailability === 'preview' ? h('span', { class: 'psBadge', text: 'preview only' }) : null,
    ),
  );
  info.appendChild(
    h('span', {
      class: 'psMuted',
      text: `${post.ext ?? '?'} · ${post.width ?? '?'}×${post.height ?? '?'}${post.score !== null ? ` · score ${post.score}` : ''} · ${post.tags.length} tag(s)`,
    }),
  );
  info.appendChild(h('span', { class: 'psMuted psTruncate', text: post.tags.slice(0, 8).join(' ') || '(no tags reported)' }));
  if (state.saved) {
    info.appendChild(
      h('span', { class: 'psBadge psBadgeSaved', text: `completed ${relativeTime(state.saved.at)} — ${state.saved.filename}` }),
    );
  }
  if (state.queued) info.appendChild(h('span', { class: 'psBadge psBadgeQueued', text: 'already in the queue' }));
  row.appendChild(info);
  container.appendChild(row);

  if (post.fileAvailability === 'preview' || !post.fileUrl) {
    container.appendChild(h('p', {
      class: 'psHint warn',
      text: 'The original is unavailable. A preview may be displayed, but it will not be downloaded.',
    }));
  }
  if (state.blocked) {
    container.appendChild(
      h('p', {
        class: 'psHint warn',
        text: 'The rating allow-list of this profile excludes this post, so a download would be refused. Change the profile or turn off rating enforcement in Settings.',
      }),
    );
  }

  container.appendChild(
    h(
      'div',
      { class: 'psActionRow' },
      button(state.busy ? 'Downloading…' : 'Download this file', {
        variant: 'primary',
        disabled: state.busy || state.blocked || post.fileAvailability === 'preview' || !post.fileUrl,
        onClick: () => callbacks.onDownload(),
      }),
      button(state.queued ? 'In the queue' : 'Add to list', {
        variant: 'subtle',
        disabled: state.queued || state.busy,
        onClick: () => callbacks.onAddToList(),
      }),
      callbacks.onAddAllPawchiveFiles ? button('Add all available files', {
        variant: 'subtle',
        disabled: state.busy,
        title: 'Queue every available original attachment from this Pawchive post; external links are collected separately.',
        onClick: () => callbacks.onAddAllPawchiveFiles?.(),
      }) : null,
    ),
  );
  container.appendChild(
    h('p', {
      class: 'psHint',
      text: callbacks.onAddAllPawchiveFiles
        ? 'The first button downloads one file. “Add all” lists this post’s available originals; external links are separate. Press Download selected to start.'
        : '“Add to list” only adds the row - nothing is downloaded until you press Download selected on the dock.',
    }),
  );
}
