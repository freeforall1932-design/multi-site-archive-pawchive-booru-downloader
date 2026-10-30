/**
 * The panel's list of rows - the vertical, tickable queue used by both the
 * Browse tab (review before downloading) and the Queue tab (progress).
 *
 * Row anatomy, borrowed from the sister side panels:
 *
 *   [x] [thumb]  #1500000  [video] [completed]      completed      [×]
 *                e621 · 4.2 MB · bsm/folder/file.jpg
 *                [====== progress ======]
 *
 * Everything is drawn from the core queue: a row *is* a persisted `QueueItem`,
 * so closing the panel never loses work and a service-worker restart resumes it.
 */
import type { QueueItem, QueueSummary, Rating, ServerConfigView } from '../shared/types.js';
import { formatBytes, relativeTime } from '../shared/util.js';
import { button, h } from './dom.js';
import { kindLabel, ratingChip } from './format.js';

export interface QueueRowView {
  item: QueueItem;
  server: ServerConfigView | null;
  /** Row is ticked for the next download run. */
  selected: boolean;
  /** Post was downloaded before this run (found in the history notebook). */
  savedFilename: string | null;
  /** Preview image ('' when thumbnails are off or unknown). */
  thumbnail: string;
  media: 'video' | 'image';
  /** Canonical rating of the post (shown as a chip so the list stays rating-aware). */
  rating: Rating | null;
  /** Provider label of a mirror-link row (`Mega`, `Google Drive`, …). */
  linkProvider?: string | null;
  /** What a mirror-link row shows as its title (filename or host). */
  linkHeadline?: string;
}

export interface QueueListState {
  summary: QueueSummary;
  rows: QueueRowView[];
  /** Rows hidden by the row limit, for the "n more" footer. */
  hiddenRows: number;
  /** Rows hidden by the media filter, for the footer too. */
  filteredRows: number;
  showThumbnails: boolean;
  busy: boolean;
}

export interface QueueListCallbacks {
  onToggleRow(itemId: string): void;
  onSelectAll(select: boolean): void;
  onInvert(): void;
  onRemoveSelected(): void;
  onRemoveRow(itemId: string): void;
  onCancelRow(itemId: string): void;
  onRetryFailed(): void;
  onClearFinished(): void;
  onResetHistory(): void;
  onClearList(): void;
  onOpenPost(item: QueueItem): void;
}

export function renderQueueList(container: HTMLElement, state: QueueListState, callbacks: QueueListCallbacks): void {
  container.replaceChildren();
  container.className = 'psCard psQueueCard';
  const { summary } = state;

  // --------------------------------------------------------------- summary
  container.appendChild(
    h(
      'div',
      { class: 'psSummary' },
      summaryTile(summary.total - summary.done - summary.failed - summary.skipped - summary.canceled, 'listed'),
      summaryTile(state.rows.filter((row) => row.selected).length, 'selected'),
      summaryTile(summary.done, 'completed'),
    ),
  );

  container.appendChild(h('p', { class: 'psHint warn', text: 'Completed means Chrome reported the transfer complete; file contents are not verified. Older starts are unverified.' }));
  if (summary.unverified) {
    container.appendChild(h('p', { class: 'psHint warn', text: `${summary.unverified} unverified row(s): check Chrome Downloads before retrying to avoid duplicates.` }));
  }

  // --------------------------------------------------------------- toolbars
  const selectedCount = state.rows.filter((row) => row.selected).length;
  container.appendChild(
    h(
      'div',
      { class: 'psToolbar' },
      h(
        'label',
        { class: 'psCheck' },
        h('input', {
          type: 'checkbox',
          checked: state.rows.length > 0 && selectedCount === state.rows.length,
          on: {
            change: (event) => callbacks.onSelectAll((event.target as HTMLInputElement).checked),
          },
        }),
        h('span', { text: 'Select all' }),
      ),
      h('button', { class: 'psTextButton', type: 'button', text: 'Invert', title: 'Invert the selection of the rows shown', onClick: () => callbacks.onInvert() }),
      h('button', {
        class: 'psTextButton',
        type: 'button',
        text: `Remove selected (${selectedCount})`,
        disabled: selectedCount === 0,
        title: 'Delete the ticked rows from this list. Nothing is deleted from disk.',
        onClick: () => callbacks.onRemoveSelected(),
      }),
    ),
  );

  container.appendChild(
    h(
      'div',
      { class: 'psToolbar psToolbarSecondary' },
      h('button', {
        class: 'psTextButton',
        type: 'button',
        text: `Retry failed / unverified (${summary.failed + summary.skipped + summary.unverified})`,
        disabled: summary.failed + summary.skipped + summary.unverified === 0,
        onClick: () => callbacks.onRetryFailed(),
      }),
      h('button', {
        class: 'psTextButton',
        type: 'button',
        text: 'Clear finished',
        title: 'Remove completed rows, keeping active and unverified rows.',
        onClick: () => callbacks.onClearFinished(),
      }),
      h('button', {
        class: 'psTextButton',
        type: 'button',
        text: 'Reset history',
        title: 'Forget download history, so completed posts can be listed again.',
        onClick: () => callbacks.onResetHistory(),
      }),
      h('button', { class: 'psTextButton danger', type: 'button', text: 'Clear list', onClick: () => callbacks.onClearList() }),
    ),
  );

  // -------------------------------------------------------------- empty state
  if (!state.rows.length) {
    container.appendChild(
      h(
        'div',
        { class: 'psEmptyState' },
        h('div', { class: 'psEmptyIcon', text: '↓' }),
        h('h2', { text: state.filteredRows ? 'Nothing matches this filter' : 'Nothing listed yet' }),
        h('p', {
          class: 'psMuted',
          text: state.filteredRows
            ? 'Switch the media filter back to "Pics + videos" to see the rows that are hidden right now.'
            : 'Open a booru page and press List this page, or type tags in the search box above, then press Fetch selected pages.',
        }),
      ),
    );
    return;
  }

  // -------------------------------------------------------------------- rows
  const list = h('div', { class: 'psQueue' });
  for (const row of state.rows) list.appendChild(queueRow(row, state, callbacks));
  container.appendChild(list);

  if (state.hiddenRows > 0 || state.filteredRows > 0) {
    const bits: string[] = [];
    if (state.filteredRows) bits.push(`${state.filteredRows} hidden by the media filter`);
    if (state.hiddenRows) bits.push(`${state.hiddenRows} more row(s) not drawn (Settings → Queue rows shown)`);
    container.appendChild(h('div', { class: 'psQueueMore', text: bits.join(' · ') }));
  }
}

function summaryTile(value: number, label: string): HTMLElement {
  return h('div', {}, h('strong', { text: String(Math.max(0, value)) }), h('span', { text: label }));
}

function queueRow(row: QueueRowView, state: QueueListState, callbacks: QueueListCallbacks): HTMLElement {
  const { item } = row;
  const finished = item.status === 'done';
  const isLink = item.kind === 'link';
  const url = item.url ?? item.postUrl;
  const element = h('div', {
    class: `psQueueItem psStatus-${item.status}${row.selected ? ' psSelected' : ''}${isLink ? ' psLinkRow' : ''}`,
    dataset: { itemId: item.id },
  });

  element.appendChild(
    h('input', {
      type: 'checkbox',
      class: 'psRowCheck',
      checked: row.selected,
      disabled: item.status !== 'pending',
      title: finished ? 'Previously completed' : 'Include this post in the next download run',
      on: { change: () => callbacks.onToggleRow(item.id) },
    }),
  );

  if (state.showThumbnails && !isLink) {
    element.appendChild(
      row.thumbnail
        ? h('img', {
            class: 'psThumb',
            src: row.thumbnail,
            alt: '',
            loading: 'lazy',
            on: { error: (event) => (event.target as HTMLImageElement).classList.add('psBroken') },
          })
        : h('span', { class: 'psThumb psThumbEmpty', text: row.media === 'video' ? '▶' : '▣', ariaLabel: 'no preview' }),
    );
  }

  const info = h('div', { class: 'psItemInfo' });
  const title = h('div', { class: 'psItemTitle' });
  if (isLink) {
    // A mirror link is not a post: the URL *is* the title, and the label keeps
    // the post title it was collected from readable in the row.
    title.appendChild(h('span', { class: 'psTypeBadge server', text: 'link' }));
    title.appendChild(
      h('span', {
        class: 'psTruncate',
        text: row.linkProvider ? `${row.linkProvider} — ${row.linkHeadline}` : row.linkHeadline,
        title: url,
      }),
    );
  } else {
    title.appendChild(
      item.postUrl
        ? h('a', {
            href: item.postUrl,
            target: '_blank',
            rel: 'noreferrer',
            text: `#${item.postId}`,
            title: 'Open the post on the site',
            onClick: (event) => {
              event.preventDefault();
              callbacks.onOpenPost(item);
            },
          })
        : h('span', { text: `#${item.postId}` }),
    );
    title.appendChild(h('span', { class: `psTypeBadge${row.media === 'video' ? ' video' : ''}`, text: row.media === 'video' ? 'video' : 'pic' }));
    if (row.rating) title.appendChild(ratingChip(row.rating));
    if (row.server) title.appendChild(h('span', { class: 'psTypeBadge server', text: row.server.siteType }));
  }
  if (row.savedFilename) {
    title.appendChild(h('span', { class: 'psTypeBadge saved', text: 'completed', title: `Chrome reported complete: ${row.savedFilename}` }));
  }
  info.appendChild(title);

  const meta = h('div', { class: 'psItemMeta' });
  const file = item.filename ?? row.savedFilename;
  if (file) meta.appendChild(h('span', { class: 'psFile', text: file, title: file }));
  if (item.status === 'running' && item.bytesReceived != null) {
    const total = item.totalBytes != null && item.totalBytes > 0 ? ` / ${formatBytes(item.totalBytes)}` : '';
    meta.appendChild(h('span', { text: `${formatBytes(item.bytesReceived)}${total} received` }));
  } else if (item.bytes !== null) {
    meta.appendChild(h('span', { text: formatBytes(item.bytes) }));
  }
  if (item.attempts > 1) meta.appendChild(h('span', { text: `attempt ${item.attempts}` }));
  if (item.status === 'done' || item.status === 'failed') meta.appendChild(h('span', { text: relativeTime(item.updatedAt) }));
  info.appendChild(meta);

  if (item.error) {
    info.appendChild(
      h('div', { class: 'psItemError', title: item.error }, h('span', { text: kindLabel(item.errorKind ?? 'unknown') }), h('span', { class: 'psTruncate', text: item.error })),
    );
  }
  element.appendChild(info);

  const right = h('div', { class: 'psItemRight' });
  right.appendChild(h('span', { class: `psItemStatus ${item.status}`, text: item.status === 'running' && item.cancelRequested ? 'canceling' : statusLabel(item.status) }));
  if (item.status === 'running' && item.bytesReceived != null && item.totalBytes != null && item.totalBytes > 0) {
    const percent = Math.max(0, Math.min(100, Math.round((item.bytesReceived / item.totalBytes) * 100)));
    right.appendChild(h('div', { class: 'psItemProgress', title: `${percent}% received` }, h('i', { style: `width: ${percent}%` })));
  }
  const actions = h('div', { class: 'psItemActions' });
  if (item.status === 'pending' || item.status === 'running') {
    actions.appendChild(
      h('button', {
        class: 'psRowButton',
        type: 'button',
        text: '✕',
        title: item.cancelRequested ? 'Cancellation requested' : 'Cancel this download',
        ariaLabel: 'Cancel this download',
        disabled: !!item.cancelRequested,
        onClick: () => callbacks.onCancelRow(item.id),
      }),
    );
  } else {
    actions.appendChild(
      h('button', {
        class: 'psRowButton',
        type: 'button',
        text: '✕',
        title: 'Remove this row from the list (the file on disk is not touched)',
        ariaLabel: 'Remove this row',
        onClick: () => callbacks.onRemoveRow(item.id),
      }),
    );
  }
  right.appendChild(actions);
  element.appendChild(right);

  return element;
}

function statusLabel(status: QueueItem['status']): string {
  const labels: Record<QueueItem['status'], string> = {
    pending: 'queued',
    running: 'downloading',
    done: 'completed',
    failed: 'failed',
    unverified: 'unverified',
    skipped: 'skipped',
    canceled: 'canceled',
  };
  return labels[status];
}

/** Dock-level controls: start workers, original-only quality, run/stop. */
export interface DockState {
  concurrency: number;
  selectedCount: number;
  pendingCount: number;
  /** At least one start worker or Chrome transfer is active. */
  running: boolean;
  /** Workers are currently preparing/starting the selected rows. */
  dispatching: boolean;
  paused: boolean;
  notice: { text: string; tone: 'plain' | 'ok' | 'error' } | null;
  busy: boolean;
}

export interface DockCallbacks {
  onConcurrencyChange(value: number): void;
  onDownloadSelected(): void;
  onStart(): void;
  onPause(): void;
  onResume(): void;
  onStop(): void;
}

export function renderDock(container: HTMLElement, state: DockState, callbacks: DockCallbacks): void {
  container.replaceChildren();
  container.className = 'psDock';

  const controls = h('div', { class: 'psDockControls' });

  const concurrency = h('div', { class: 'psConcurrency', title: 'Queue workers prepare download starts; active Chrome transfers are not capped.' });
  concurrency.appendChild(h('span', { text: 'Start workers' }));
  const segmented = h('div', { class: 'psSegmented', attrs: { role: 'group', 'aria-label': 'Queue start workers' } });
  for (const value of [1, 2, 3, 5]) {
    segmented.appendChild(
      h('button', {
        type: 'button',
        text: String(value),
        class: value === state.concurrency ? 'selected' : '',
        title: value === 3 ? 'Recommended default' : `${value} queue start worker(s)`,
        onClick: () => callbacks.onConcurrencyChange(value),
      }),
    );
  }
  concurrency.appendChild(segmented);
  controls.appendChild(concurrency);

  controls.appendChild(h('span', {
    class: 'psMuted',
    text: 'Originals only',
    title: 'Samples and previews are never substituted for an unavailable original.',
  }));
  container.appendChild(controls);

  const actions = h('div', { class: 'psDockActions' });
  actions.appendChild(
    button(state.dispatching ? 'Starting…' : `Download selected (${state.selectedCount})`, {
      variant: 'primary',
      disabled: state.busy || state.dispatching || state.selectedCount === 0,
      title: 'Start only the ticked rows. Everything else stays in the list.',
      onClick: () => callbacks.onDownloadSelected(),
    }),
  );
  if (state.running || (state.paused && state.pendingCount > 0)) {
    actions.appendChild(
      button(state.paused ? 'Resume' : 'Pause', {
        variant: 'subtle',
        onClick: () => (state.paused ? callbacks.onResume() : callbacks.onPause()),
      }),
    );
    actions.appendChild(button('Stop', { variant: 'danger', onClick: () => callbacks.onStop() }));
  }
  if (state.pendingCount > 0 && !state.dispatching && !state.paused) {
    actions.appendChild(
      button(`Start queued (${state.pendingCount})`, {
        variant: 'subtle',
        disabled: state.busy,
        title: 'Run every queued row, not just the ticked ones',
        onClick: () => callbacks.onStart(),
      }),
    );
  }
  container.appendChild(actions);

  container.appendChild(
    h('p', {
      class: `psNotice${state.notice ? ` ${state.notice.tone}` : ''}`,
      text:
        state.notice?.text ??
        'Tick rows (or Select all), then download. Downloads keep running while you browse other pages.',
    }),
  );
}
