import type { QueueItem, QueueSummary, ServerConfigView } from '../shared/types.js';
import { failureLabel } from '../shared/errors.js';
import { bytesOrDash } from './format.js';
import { button, h } from './dom.js';

export interface QueueState {
  summary: QueueSummary;
  items: QueueItem[];
  servers: ServerConfigView[];
  maxConcurrency: number;
  busy: boolean;
}

export interface QueueCallbacks {
  onRun(): void;
  onPause(): void;
  onResume(): void;
  onRetryFailed(): void;
  onClear(scope: 'completed' | 'failed' | 'all'): void;
  onCancel(itemId: string): void;
}

/** Batch queue screen: progress, per-item status and retry controls. */
export function renderQueue(container: HTMLElement, state: QueueState, callbacks: QueueCallbacks): void {
  container.replaceChildren();
  const { summary } = state;

  container.appendChild(
    h(
      'div',
      { class: 'view-header' },
      h(
        'div',
        {},
        h('h1', { text: 'Queue' }),
        h('p', {
          class: 'muted',
          text: `${summary.total} item(s) · ${summary.pending} pending · ${summary.running} downloading · ${state.maxConcurrency} start worker(s)`,
        }),
      ),
      h(
        'div',
        { class: 'header-actions' },
        summary.paused
          ? button('Resume', { variant: 'primary', iconName: 'play', onClick: () => callbacks.onResume() })
          : button(summary.active ? 'Starting…' : 'Start', { variant: 'primary', iconName: 'play', disabled: summary.active || summary.pending === 0, onClick: () => callbacks.onRun() }),
        button('Pause', { iconName: 'pause', disabled: summary.paused, onClick: () => callbacks.onPause() }),
        button('Retry failed / unverified', { iconName: 'refresh', disabled: summary.failed + summary.skipped + summary.unverified === 0, onClick: () => callbacks.onRetryFailed() }),
        button('Clear completed', { variant: 'ghost', onClick: () => callbacks.onClear('completed') }),
        button('Clear all', { variant: 'danger', onClick: () => callbacks.onClear('all') }),
      ),
    ),
  );

  container.appendChild(
    h(
      'div',
      { class: 'progress-bar' },
      h('div', { class: 'progress-fill', style: `width: ${summary.total ? Math.round((summary.done / summary.total) * 100) : 0}%` }),
    ),
  );

  container.appendChild(h('p', { class: 'muted small', text: 'Completed means Chrome reported the transfer complete; file contents are not verified. Older starts are unverified.' }));

  if (!state.items.length) {
    container.appendChild(
      h(
        'div',
        { class: 'empty-state' },
        h('h2', { text: 'Queue is empty' }),
        h('p', { class: 'muted', text: 'Add posts from Browse, or from the extension popup on a post page.' }),
      ),
    );
    return;
  }

  const table = h(
    'table',
    { class: 'queue-table' },
    h(
      'thead',
      {},
      h(
        'tr',
        {},
        h('th', { text: 'Post' }),
        h('th', { text: 'Server' }),
        h('th', { text: 'Status' }),
        h('th', { text: 'File' }),
        h('th', { text: 'Error' }),
        h('th', { text: '' }),
      ),
    ),
  );
  const body = h('tbody');
  for (const item of state.items) {
    const server = state.servers.find((entry) => entry.id === item.serverId);
    body.appendChild(
      h(
        'tr',
        { class: `queue-row queue-${item.status}` },
        h(
          'td',
          {},
          h('strong', { text: `#${item.postId}` }),
          item.postUrl ? h('a', { class: 'link small', href: item.postUrl, target: '_blank', rel: 'noreferrer', text: 'open' }) : null,
        ),
        h('td', { text: server?.label ?? item.serverId }),
        h('td', {}, h('span', { class: `chip chip-status chip-${item.status}`, text: item.cancelRequested && item.status === 'running' ? 'canceling' : item.status === 'done' ? 'completed' : item.status }), item.attempts > 1 ? h('span', { class: 'muted small', text: ` try ${item.attempts}` }) : null),
        h('td', { class: 'mono small truncate', text: item.filename ?? '—' }),
        h(
          'td',
          { class: 'small' },
          item.error ? h('span', { title: item.error, text: item.errorKind ? failureLabel(item.errorKind) : item.error }) : h('span', { class: 'muted', text: bytesOrDash(item.bytes) }),
        ),
        h(
          'td',
          {},
          item.status === 'pending' || item.status === 'running'
            ? button('Cancel', { variant: 'danger', onClick: () => callbacks.onCancel(item.id) })
            : null,
        ),
      ),
    );
  }
  table.appendChild(body);
  container.appendChild(table);
}
