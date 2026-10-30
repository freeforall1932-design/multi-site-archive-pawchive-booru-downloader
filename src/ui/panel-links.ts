/**
 * The Links tab - download tasks (the "package" view) plus the raw link list.
 *
 * The tab is organised around **tasks**: one creator on one site, the files that
 * belong to them, what each file is doing and what the last pass did. That is the
 * unit a package is exported as and the unit a second person imports - open the
 * file, see *one task: artist A*, click it and read the brief (how many files,
 * how many arrived, which failed, when it last ran).
 *
 * Under the tasks sits the plain link list: everything that is not part of a task
 * (a bare URL list import, a userscript export, a single link). Both levels use
 * the same rows, so a file's status reads the same wherever it appears.
 *
 * The card never talks to a site and never touches storage: every action goes
 * through a `UiRequest` handled by the background worker.
 */
import { manualMirrorProvider } from '../core/links.js';
import type { MirrorLink, MirrorLinkFilter, MirrorLinkStats, ServerConfigView, TaskRun, TaskView } from '../shared/types.js';
import { formatBytes, relativeTime } from '../shared/util.js';
import { button, h } from './dom.js';

export type LinkExportGrouping = 'post' | 'provider' | 'plain';

export interface MirrorLinkRow {
  link: MirrorLink;
  /** Row context resolved by the panel (the link only stores ids). */
  serverLabel: string | null;
  selected: boolean;
}

export interface TaskCardView {
  view: TaskView;
  rows: MirrorLinkRow[];
  /** Files of the task that are not drawn because of the row limit. */
  hiddenRows: number;
  expanded: boolean;
}

export interface LinksState {
  servers: ServerConfigView[];
  serverId: string | null;
  query: string;
  /** True when the selected profile is a Pawchive. */
  canCollect: boolean;
  busy: boolean;
  progress: { done: number; total: number; label: string } | null;
  error: { message: string; kind: string; hint: string | null } | null;
  stats: MirrorLinkStats;
  tasks: TaskCardView[];
  /** Links that belong to no task (bare imports, single URLs). */
  unfiled: MirrorLinkRow[];
  unfiledHidden: number;
  selectionCount: number;
  exportGrouping: LinkExportGrouping;
  filterMode: MirrorLinkFilter;
  /** Duplicate URLs already in the queue, for the notice line. */
  queuePending: number;
}

export interface LinksCallbacks {
  onServerChange(serverId: string): void;
  onQueryChange(query: string): void;
  onCollect(): void;
  onStop(): void;
  onToggleRow(id: string): void;
  onSelectAll(select: boolean): void;
  onInvert(): void;
  onAddToQueue(ids: string[]): void;
  onExport(grouping: LinkExportGrouping): void;
  onImport(text: string, filename: string): void;
  onRemoveSelected(ids: string[]): void;
  onRemoveRow(id: string): void;
  onClear(scope: 'all' | 'done' | 'pending'): void;
  onOpenLink(url: string): void;
  onOpenPost(url: string): void;
  onOpenQueue(): void;
  onOpenSettings(): void;
  // ------------------------------------------------------------ task actions
  onToggleTask(taskId: string): void;
  onTaskStart(taskId: string, mode: 'missing' | 'all'): void;
  onTaskPause(taskId: string): void;
  onTaskRescan(taskId: string): void;
  onTaskExport(taskId: string): void;
  onTaskRemove(taskId: string): void;
}

const STATUS_LABELS: Record<MirrorLink['status'], string> = {
  new: 'not downloaded',
  queued: 'in the queue',
  done: 'completed',
  failed: 'failed',
  unverified: 'unverified',
};

const COMPLETION_LABELS: Record<TaskView['completion'], string> = {
  empty: 'no files yet',
  idle: 'ready',
  'in-progress': 'downloading',
  complete: 'all completed',
  partial: 'partial',
  failed: 'failed',
};

export function renderLinksCard(container: HTMLElement, state: LinksState, callbacks: LinksCallbacks): void {
  container.replaceChildren();
  container.className = 'psCard psLinksCard';

  const server = state.servers.find((entry) => entry.id === state.serverId) ?? null;
  // Kept so the query box can enable/disable *Collect links* as you type, without
  // re-rendering the card (which would steal the caret).
  let collectButton: HTMLButtonElement | null = null;

  // ------------------------------------------------------------------ header
  container.appendChild(
    h(
      'div',
      { class: 'psLinksHead' },
      h('h2', { text: 'Mirror links' }),
      h('span', {
        class: 'psMuted psSmall',
        text: 'Collects off-site links inside a creator’s posts. Direct file URLs can be queued; Mega and other share pages must be opened or exported for a provider downloader.',
      }),
    ),
  );

  // ------------------------------------------------------------------ source
  const serverRow = h('div', { class: 'psServerRow' });
  serverRow.appendChild(h('span', { class: 'psMuted psSmall', text: 'Profile' }));
  const select = h('select', {
    class: 'psSelect',
    title: 'Which saved profile the links are collected with. Pawchive only - the mirror links live in its post bodies.',
    on: {
      change: (event) => callbacks.onServerChange((event.target as HTMLSelectElement).value),
    },
  });
  if (!state.servers.length) select.appendChild(h('option', { value: '', text: 'No Pawchive profile saved yet' }));
  for (const entry of state.servers) {
    select.appendChild(
      h('option', {
        value: entry.id,
        text: `${entry.label} · ${entry.siteType}`,
        selected: entry.id === state.serverId,
      }),
    );
  }
  serverRow.appendChild(select);
  serverRow.appendChild(
    h('span', {
      class: 'psMuted psSmall',
      text: state.canCollect ? 'archive API' : 'add a Pawchive profile',
    }),
  );
  container.appendChild(serverRow);

  const searchRow = h('div', { class: 'psSearchRow' });
  searchRow.appendChild(
    h('input', {
      class: 'psInput',
      id: 'psLinksQuery',
      type: 'text',
      placeholder: 'creator: fanbox/1245946, a creator URL, tag:name or a title',
      value: state.query,
      autocomplete: 'off',
      spellcheck: 'false',
      on: {
        input: (event) => {
          const value = (event.target as HTMLInputElement).value;
          callbacks.onQueryChange(value);
          if (collectButton) collectButton.disabled = !value.trim() || !state.canCollect || !state.serverId || state.busy;
        },
        keydown: (event) => {
          if ((event as KeyboardEvent).key === 'Enter' && state.canCollect && !state.busy) {
            event.preventDefault();
            callbacks.onCollect();
          }
        },
      },
    }),
  );
  container.appendChild(searchRow);
  container.appendChild(
    h('p', {
      class: 'psHint',
      text: 'Rescanning updates this task. Confirmed completions are skipped; older starts are unverified. Chrome completion does not verify file contents.',
    }),
  );

  // --------------------------------------------------------------- action row
  collectButton = button(state.busy ? 'Collecting…' : 'Collect links', {
    variant: 'primary',
    disabled: state.busy || !state.canCollect || !state.serverId || !state.query.trim(),
    onClick: () => callbacks.onCollect(),
  }) as HTMLButtonElement;
  container.appendChild(
    h(
      'div',
      { class: 'psActionRow' },
      collectButton,
      button('Stop', {
        variant: 'danger',
        disabled: !state.busy,
        title: 'Stop after the post being scanned right now. Everything collected so far is kept.',
        onClick: () => callbacks.onStop(),
      }),
    ),
  );

  if (state.progress) {
    const percent = state.progress.total ? Math.round((state.progress.done / state.progress.total) * 100) : 0;
    container.appendChild(
      h(
        'div',
        { class: 'psProgress' },
        h('div', { class: 'psBar' }, h('i', { style: `width: ${percent}%` })),
        h('span', { class: 'psMuted psSmall', text: state.progress.label }),
      ),
    );
  }

  if (state.error) {
    container.appendChild(
      h(
        'div',
        { class: 'psError' },
        h('strong', { text: state.error.kind }),
        h('p', { text: state.error.message }),
        state.error.hint ? h('small', { class: 'psHint', text: state.error.hint }) : null,
      ),
    );
  }

  // ------------------------------------------------------------------ package
  container.appendChild(
    h(
      'div',
      { class: 'psActionRow' },
      button('Import package…', {
        variant: 'subtle',
        title: 'Read a task package (.json) or a link list (.txt) - as exported by this tab, or written by the Pawchive Link Collector userscript. It appears as a task, idle, until you start it.',
        onClick: () => pickFile((text, name) => callbacks.onImport(text, name)),
      }),
      button(`Export .txt`, {
        title: 'Write the whole collected list to a text file (grouped by post by default). A task exports its own package from its card.',
        disabled: state.stats.total === 0,
        onClick: () => callbacks.onExport(state.exportGrouping),
      }),
    ),
  );

  // ------------------------------------------------------------------ summary
  container.appendChild(
    h(
      'div',
      { class: 'psSummary' },
      summaryTile(state.stats.total, 'collected'),
      summaryTile(state.stats.new, 'to download'),
      summaryTile(state.stats.done, 'completed'),
      summaryTile(state.stats.failed, 'failed'),
      summaryTile(state.stats.unverified, 'unverified'),
    ),
  );

  if (state.stats.unverified) {
    container.appendChild(h('p', { class: 'psHint warn', text: `${state.stats.unverified} older or missing download record(s) are unverified. Check Chrome Downloads before retrying.` }));
  }

  // ------------------------------------------------------------------- tasks
  if (state.tasks.length) {
    const list = h('div', { class: 'psTaskList' });
    for (const card of state.tasks) list.appendChild(taskCard(card, callbacks));
    container.appendChild(list);
  }

  // ------------------------------------------------------------ unfiled links
  const unfiledIds = state.unfiled.filter((row) => row.selected).map((row) => row.link.id);
  if (state.unfiled.length || !state.tasks.length) {
    const toolbar = h('div', { class: 'psToolbar' });
    toolbar.appendChild(
      h(
        'label',
        { class: 'psCheck' },
        h('input', {
          type: 'checkbox',
          checked: state.unfiled.length > 0 && state.unfiled.every((row) => row.selected),
          on: { change: (event) => callbacks.onSelectAll((event.target as HTMLInputElement).checked) },
        }),
        h('span', { text: state.tasks.length ? 'Unfiled links' : 'Select all' }),
      ),
    );
    toolbar.appendChild(h('button', { class: 'psTextButton', type: 'button', text: 'Invert', onClick: () => callbacks.onInvert() }));
    toolbar.appendChild(
      h('button', {
        class: 'psTextButton',
        type: 'button',
        text: `Remove selected (${unfiledIds.length})`,
        disabled: unfiledIds.length === 0,
        title: 'Drop these links from the collected list (and their pending queue rows).',
        onClick: () => callbacks.onRemoveSelected(unfiledIds),
      }),
    );
    container.appendChild(toolbar);
    if (state.unfiled.length) {
      container.appendChild(
        h(
          'div',
          { class: 'psToolbar psToolbarSecondary' },
          button(`Add to download queue (${unfiledIds.length})`, {
            variant: 'subtle',
            disabled: unfiledIds.length === 0,
            title: 'Queue the ticked links. They download one at a time at the request spacing from Settings.',
            onClick: () => callbacks.onAddToQueue(unfiledIds),
          }),
        ),
      );
    }
  }

  const groupingRow = h('div', { class: 'psRangeRow' });
  groupingRow.appendChild(h('label', { class: 'psRangeLabel', text: 'Export as' }));
  const grouping = h('select', {
    class: 'psSelect',
    title: 'How the exported text file groups its lines.',
    on: { change: (event) => callbacks.onExport((event.target as HTMLSelectElement).value as LinkExportGrouping) },
  });
  for (const option of [
    { value: 'post', label: 'Grouped by post' },
    { value: 'provider', label: 'Grouped by provider' },
    { value: 'plain', label: 'Plain URL list' },
  ] as const) {
    grouping.appendChild(h('option', { value: option.value, text: option.label, selected: option.value === state.exportGrouping }));
  }
  groupingRow.appendChild(grouping);
  groupingRow.appendChild(
    h('button', {
      class: 'psTextButton',
      type: 'button',
      text: `filter: ${state.filterMode === 'any' ? 'every external link' : 'downloads only'}`,
      title: 'Which links the collector keeps. Change it under Settings → Mirror links.',
      onClick: () => callbacks.onOpenSettings(),
    }),
  );
  container.appendChild(groupingRow);

  if (state.stats.total) {
    container.appendChild(
      h(
        'div',
        { class: 'psToolbar psToolbarSecondary' },
        h('button', {
          class: 'psTextButton',
          type: 'button',
          text: `Clear completed (${state.stats.done})`,
          disabled: state.stats.done === 0,
          onClick: () => callbacks.onClear('done'),
        }),
        h('button', {
          class: 'psTextButton danger',
          type: 'button',
          text: 'Clear list',
          title: 'Forget every collected link and task. Pending queue rows are dropped as well.',
          onClick: () => callbacks.onClear('all'),
        }),
      ),
    );
  }

  if (state.queuePending) {
    container.appendChild(
      h(
        'p',
        { class: 'psHint' },
        h('span', { text: `${state.queuePending} link(s) are waiting in the download queue. ` }),
        h('button', { class: 'psTextButton', type: 'button', text: 'Open the queue', onClick: () => callbacks.onOpenQueue() }),
      ),
    );
  }

  // ---------------------------------------------------------- unfiled rows
  if (state.unfiled.length) {
    const list = h('div', { class: 'psQueue psLinkGroups' });
    for (const row of state.unfiled) list.appendChild(linkRow(row, callbacks));
    container.appendChild(list);
  }

  if (state.unfiledHidden > 0) {
    container.appendChild(
      h('div', { class: 'psQueueMore', text: `${state.unfiledHidden} more unfiled link(s) not drawn (Settings → Queue rows shown)` }),
    );
  }

  if (!state.tasks.length && !state.unfiled.length) {
    container.appendChild(
      h(
        'div',
        { class: 'psEmptyState' },
        h('div', { class: 'psEmptyIcon', text: '⛓' }),
        h('h2', { text: 'No links collected yet' }),
        h('p', {
          class: 'psMuted',
          text: state.busy
            ? 'Scanning… links appear here as they are found.'
            : 'Pick a Pawchive profile, paste the creator, then press Collect links - or open a package someone sent you with Import package.',
        }),
      ),
    );
    return;
  }
}

// ------------------------------------------------------------------ task card

function taskCard(card: TaskCardView, callbacks: LinksCallbacks): HTMLElement {
  const { task, stats, completion, lastRun } = card.view;
  const element = h('div', { class: `psTask psTask-${completion}`, dataset: { taskId: task.id } });

  const head = h('div', { class: 'psTaskHead' });
  const title = h('div', { class: 'psTaskTitle' });
  title.appendChild(
    h('button', {
      class: 'psTaskToggle',
      type: 'button',
      text: card.expanded ? '▾' : '▸',
      title: card.expanded ? 'Hide the files' : 'Show the files',
      ariaLabel: card.expanded ? 'Hide the files' : 'Show the files',
      onClick: () => callbacks.onToggleTask(task.id),
    }),
  );
  title.appendChild(h('strong', { text: task.name, title: task.name }));
  if (task.siteType) title.appendChild(h('span', { class: 'psTypeBadge server', text: task.siteType }));
  if (task.service) title.appendChild(h('span', { class: 'psMuted psSmall', text: task.service }));
  title.appendChild(h('span', { class: `psItemStatus ${completion === 'complete' ? 'done' : completion === 'failed' ? 'failed' : completion === 'in-progress' ? 'running' : 'pending'}`, text: COMPLETION_LABELS[completion] }));
  head.appendChild(title);

  const meta = h('div', { class: 'psItemMeta' });
  meta.appendChild(h('span', { class: 'psMuted psSmall', text: `${stats.done}/${stats.total} file(s) completed` }));
  if (stats.failed) meta.appendChild(h('span', { class: 'psMuted psSmall', text: `${stats.failed} failed` }));
  if (stats.unverified) meta.appendChild(h('span', { class: 'psMuted psSmall', text: `${stats.unverified} unverified` }));
  if (stats.pending) meta.appendChild(h('span', { class: 'psMuted psSmall', text: `${stats.pending} still missing` }));
  if (stats.bytes !== null) meta.appendChild(h('span', { class: 'psMuted psSmall', text: formatBytes(stats.bytes) }));
  if (task.lastScanAt) meta.appendChild(h('span', { class: 'psMuted psSmall', text: `scanned ${relativeTime(task.lastScanAt)}` }));
  meta.appendChild(h('span', { class: 'psMuted psSmall', text: `${task.memberIds.length} file(s) in the task` }));
  head.appendChild(meta);

  if (lastRun) head.appendChild(h('div', { class: 'psItemMeta' }, h('span', { class: 'psMuted psSmall', text: runLabel(lastRun) })));

  const actions = h('div', { class: 'psTaskActions' });
  const missing = stats.pending;
  actions.appendChild(
    button(missing ? `Download missing (${missing})` : 'Download missing', {
      variant: 'subtle',
      disabled: missing === 0,
      title:
        'Queue uncompleted links, including failures and unverified starts. Provider share pages still need to be opened or exported.',
      onClick: () => callbacks.onTaskStart(task.id, 'missing'),
    }),
  );
  if (stats.queued) {
    actions.appendChild(
      button('Pause', {
        variant: 'danger',
        title: 'Drop the files of this task that are still waiting in the queue. A download already running is not interrupted.',
        onClick: () => callbacks.onTaskPause(task.id),
      }),
    );
  }
  actions.appendChild(
    button('Rescan', {
      variant: 'ghost',
      title: 'Look for posts the task has not scanned yet (new uploads) and add their files.',
      disabled: !task.query,
      onClick: () => callbacks.onTaskRescan(task.id),
    }),
  );
  actions.appendChild(
    button('Export package', {
      variant: 'ghost',
      title: 'Write the task manifest (.json) and the grouped link list (.txt) - both files, ready to send.',
      disabled: task.memberIds.length === 0,
      onClick: () => callbacks.onTaskExport(task.id),
    }),
  );
  actions.appendChild(
    h('button', {
      class: 'psRowButton',
      type: 'button',
      text: '✕',
      title: 'Remove this task. Its files stay in the list unless you clear them.',
      ariaLabel: 'Remove this task',
      onClick: () => callbacks.onTaskRemove(task.id),
    }),
  );
  head.appendChild(actions);
  element.appendChild(head);

  if (card.expanded) {
    const rows = h('div', { class: 'psQueue psLinkGroups psTaskFiles' });
    for (const row of card.rows) rows.appendChild(linkRow(row, callbacks));
    element.appendChild(rows);
    if (card.hiddenRows > 0) {
      element.appendChild(h('div', { class: 'psQueueMore', text: `${card.hiddenRows} more file(s) not drawn` }));
    }
  }

  return element;
}

/** One line of run history: what the last pass did, and when. */
function runLabel(run: TaskRun): string {
  const when = relativeTime(run.startedAt);
  const bits: string[] = [`last run ${when}`];
  if (run.scannedPosts) bits.push(`${run.scannedPosts} post(s) scanned`);
  if (run.added) bits.push(`${run.added} new file(s)`);
  if (run.queued) bits.push(`${run.queued} queued`);
  if (run.done || run.failed) {
    const completed = run.completionTracking === 'browser-complete' ? 'completed' : 'starts (unverified)';
    bits.push(`${run.done} ${completed} · ${run.failed} failed`);
  }
  if (!run.finishedAt) bits.push('still running');
  return bits.join(' · ');
}

// ---------------------------------------------------------------------- rows

function linkRow(row: MirrorLinkRow, callbacks: LinksCallbacks): HTMLElement {
  const { link } = row;
  const element = h('div', {
    class: `psQueueItem psStatus-${link.status === 'done' ? 'done' : link.status === 'failed' ? 'failed' : link.status === 'queued' ? 'running' : 'pending'}${
      row.selected ? ' psSelected' : ''
    }`,
    dataset: { linkId: link.id },
  });

  element.appendChild(
    h('input', {
      type: 'checkbox',
      class: 'psRowCheck',
      checked: row.selected,
      title: 'Include this link in the selection',
      on: { change: () => callbacks.onToggleRow(link.id) },
    }),
  );

  const info = h('div', { class: 'psItemInfo' });
  const title = h('div', { class: 'psItemTitle' });
  title.appendChild(h('span', { class: 'psTypeBadge server', text: link.provider }));
  if (manualMirrorProvider(link.url)) {
    title.appendChild(h('span', { class: 'psTypeBadge', text: 'open/export', title: 'This share page needs its provider’s downloader.' }));
  }
  if (link.postTitle) title.appendChild(h('span', { class: 'psMuted psSmall psTruncate', text: link.postTitle, title: link.postTitle }));
  if (link.status === 'done' && link.filename) {
    title.appendChild(h('span', { class: 'psTypeBadge saved', text: 'completed', title: `Chrome reported complete: ${link.filename}` }));
  }
  info.appendChild(title);

  info.appendChild(
    h(
      'div',
      { class: 'psItemMeta' },
      h('a', {
        class: 'psFile',
        href: link.url,
        target: '_blank',
        rel: 'noreferrer',
        text: shortenUrl(link.url, 88),
        title: link.url,
        onClick: (event) => {
          event.preventDefault();
          callbacks.onOpenLink(link.url);
        },
      }),
    ),
  );

  const meta = h('div', { class: 'psItemMeta' });
  if (link.host) meta.appendChild(h('span', { class: 'psMuted psSmall', text: link.host }));
  if (link.bytes !== null) meta.appendChild(h('span', { class: 'psMuted psSmall', text: formatBytes(link.bytes) }));
  if (link.attempts > 0) meta.appendChild(h('span', { class: 'psMuted psSmall', text: `attempt ${link.attempts}` }));
  if (link.status !== 'new') meta.appendChild(h('span', { class: 'psMuted psSmall', text: relativeTime(link.updatedAt) }));
  if (link.postUrl) {
    meta.appendChild(
      h('a', {
        class: 'psMuted psSmall',
        href: link.postUrl,
        target: '_blank',
        rel: 'noreferrer',
        text: 'post',
        onClick: (event) => {
          event.preventDefault();
          callbacks.onOpenPost(link.postUrl!);
        },
      }),
    );
  }
  if (row.serverLabel) meta.appendChild(h('span', { class: 'psMuted psSmall', text: row.serverLabel }));
  info.appendChild(meta);

  if (link.error) {
    info.appendChild(h('div', { class: 'psItemError', title: link.error }, h('span', { class: 'psTruncate', text: link.error })));
  }
  element.appendChild(info);

  const right = h('div', { class: 'psItemRight' });
  right.appendChild(h('span', { class: `psItemStatus ${link.status === 'queued' ? 'running' : link.status}`, text: STATUS_LABELS[link.status] }));
  const actions = h('div', { class: 'psItemActions' });
  actions.appendChild(
    h('button', {
      class: 'psRowButton',
      type: 'button',
      text: '✕',
      title: 'Remove this link from the collected list (the file on disk is not touched)',
      ariaLabel: 'Remove this link',
      onClick: () => callbacks.onRemoveRow(link.id),
    }),
  );
  right.appendChild(actions);
  element.appendChild(right);
  return element;
}

function summaryTile(value: number, label: string): HTMLElement {
  return h('div', {}, h('strong', { text: String(Math.max(0, value)) }), h('span', { text: label }));
}

function shortenUrl(url: string, max: number): string {
  if (url.length <= max) return url;
  const head = url.slice(0, Math.floor(max / 2) - 1);
  const tail = url.slice(-Math.floor(max / 2));
  return `${head}…${tail}`;
}

/**
 * Open a file picker and hand the text to the caller.
 *
 * Same pattern as the settings screen's server import: a hidden `<input
 * type="file">`, `file.text()`, no network and no form submission.
 */
export function pickFile(onText: (text: string, filename: string) => void): void {
  const input = h('input', {
    type: 'file',
    accept: '.txt,.json,text/plain,application/json',
    style: 'display:none',
  });
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (!file) return;
    void file
      .text()
      .then((text) => onText(text, file.name))
      .catch(() => onText('', file.name))
      .finally(() => input.remove());
  });
  document.body.appendChild(input);
  input.click();
}
