/**
 * The listing card - the panel's main control surface.
 *
 * Layout and behaviour follow the sister side-panel extensions:
 *
 *   [ server ▾ ]                      <- which profile is being searched
 *   [ tag / search box …………………… ]   <- recent searches appear as suggestions
 *   [ List this page ] [ Download page ]
 *   From [ 1 ] To [ last ]  advanced / batch / ?
 *   [ media filter ▾ ] [ skip downloaded ]
 *   [ Fetch selected pages ] [ Download selected ] [ Stop ]
 *   ---- progress bar while a crawl runs ----
 *
 * Fetching never downloads by itself: it adds reviewed rows to the list, and the
 * dock's "Download selected" is what starts the queue (same promise as the Rule
 * 34 panel: "Fetching only adds checked posts to the queue").
 */
import type { AdapterCatalogEntry } from '../core/messages.js';
import type { BooruPost, MediaFilter, Rating, ServerConfigView } from '../shared/types.js';
import { button, h } from './dom.js';
import { kindLabel } from './format.js';

export interface ListingFilters {
  /** Tags added by the settings (global suffix). */
  appended: string[];
  /** Tags excluded by the settings (blacklist). */
  excluded: string[];
}

export interface ListingState {
  servers: ServerConfigView[];
  adapters: AdapterCatalogEntry[];
  serverId: string | null;
  tags: string;
  suggestions: string[];
  /** Simple From/To row vs. the advanced page box. */
  advanced: boolean;
  fromPage: string;
  toPage: string;
  rangeText: string;
  /** Human label + error produced by the pure range parser. */
  rangeLabel: string | null;
  rangeError: string | null;
  media: MediaFilter;
  skipDownloaded: boolean;
  /** Rating filter authoritatively used for this fetch. */
  ratingEnabled: boolean;
  allowedRatings: Rating[];
  supportsRatingFilter: boolean;
  filters: ListingFilters;
  /** Pages the current selection covers (for the hint). */
  pageLimit: number;
  busy: 'idle' | 'search' | 'crawl';
  progress: { done: number; total: number; label: string } | null;
  error: { message: string; kind: string; hint: string | null } | null;
  /** Results already fetched, for the "n listed" hint. */
  listedCount: number;
  matchedCount: number | null;
  skippedDownloaded: number;
}

export interface ListingCallbacks {
  onServerChange(serverId: string): void;
  onTagsChange(tags: string): void;
  onSuggestion(query: string): void;
  onClearSuggestions(): void;
  onAdvancedToggle(advanced: boolean): void;
  onFromToChange(from: string, to: string): void;
  onRangeTextChange(text: string): void;
  onMediaChange(media: MediaFilter): void;
  onSkipDownloadedChange(value: boolean): void;
  onToggleRatingFilter(): void;
  /** List the first page (or the current range) without downloading. */
  onList(): void;
  /** List everything in the selected range. */
  onFetchRange(): void;
  /** List and immediately download the current page. */
  onDownloadPage(): void;
  onStop(): void;
  onOpenServers(): void;
}

export function renderListingCard(container: HTMLElement, state: ListingState, callbacks: ListingCallbacks): void {
  container.replaceChildren();
  container.className = 'psCard';
  const server = state.servers.find((entry) => entry.id === state.serverId) ?? null;
  const adapter = state.adapters.find((entry) => entry.siteType === server?.siteType) ?? null;

  // ---------------------------------------------------------------- server row
  const serverRow = h('div', { class: 'psRow' });
  if (!state.servers.length) {
    serverRow.appendChild(h('div', { class: 'psEmpty' }, h('strong', { text: 'No server saved yet' })));
    serverRow.appendChild(
      h('div', { class: 'psActionRow' }, button('Add your first server', { variant: 'primary', onClick: () => callbacks.onOpenServers() })),
    );
    container.appendChild(serverRow);
    return;
  }

  const serverSelect = h('select', {
    class: 'psSelect',
    id: 'psServerSelect',
    title: 'Which saved profile this search runs against',
    on: { change: (event) => callbacks.onServerChange((event.target as HTMLSelectElement).value) },
  });
  for (const entry of state.servers) {
    serverSelect.appendChild(
      h('option', {
        value: entry.id,
        text: `${entry.label} · ${entry.siteType}${entry.isDefault ? ' (default)' : ''}`,
        selected: entry.id === state.serverId,
      }),
    );
  }
  serverRow.appendChild(serverSelect);
  if (server) {
    serverRow.appendChild(
      h('span', {
        class: 'psMuted psSmall',
        text: `${server.ratingFilterEnabled ? `ratings: ${(server.allowedRatings ?? []).join(', ') || 'none'}` : 'rating filter off'}`,
      }),
    );
  }
  container.appendChild(serverRow);

  // ---------------------------------------------------------------- search row
  const searchRow = h('div', { class: 'psSearchRow' });
  const tagInput = h('input', {
    class: 'psInput',
    id: 'psTagInput',
    type: 'search',
    placeholder: 'tags, e.g. cat solo rating:safe',
    value: state.tags,
    autocomplete: 'off',
    spellcheck: 'false',
    on: {
      input: (event) => callbacks.onTagsChange((event.target as HTMLInputElement).value),
      keydown: (event) => {
        if ((event as KeyboardEvent).key === 'Enter') {
          event.preventDefault();
          callbacks.onList();
        }
      },
    },
  });
  const listId = 'psSearchSuggestions';
  tagInput.setAttribute('list', listId);
  const datalist = h('datalist', { id: listId });
  for (const suggestion of state.suggestions) datalist.appendChild(h('option', { value: suggestion }));
  searchRow.appendChild(tagInput);
  searchRow.appendChild(datalist);
  searchRow.appendChild(
    h('button', {
      class: 'psIconButton',
      type: 'button',
      title: 'Clear the search box',
      ariaLabel: 'Clear the search box',
      text: '×',
      onClick: () => callbacks.onTagsChange(''),
    }),
  );
  container.appendChild(searchRow);

  const filterBits = [
    state.filters.appended.length ? `+${state.filters.appended.length} always-on tag(s)` : '',
    state.filters.excluded.length ? `−${state.filters.excluded.length} blacklisted` : '',
  ].filter(Boolean);
  container.appendChild(
    h('p', {
      class: 'psHint',
      text: filtersentence(state, filterBits),
    }),
  );

  // -------------------------------------------------------------- action rows
  container.appendChild(
    h(
      'div',
      { class: 'psActionRow' },
      button(state.busy === 'search' ? 'Listing…' : 'List this page', {
        variant: 'primary',
        disabled: state.busy !== 'idle' || !server,
        onClick: () => callbacks.onList(),
      }),
      button('Download page', {
        disabled: state.busy !== 'idle' || !server,
        title: 'List this page and start downloading what the filters allow',
        onClick: () => callbacks.onDownloadPage(),
      }),
    ),
  );

  // --------------------------------------------------------------- page range
  const fromToRow = h('div', { class: `psRangeRow${state.advanced ? ' psHidden' : ''}` });
  fromToRow.appendChild(h('label', { class: 'psRangeLabel', text: 'From', for: 'psFromPage' }));
  fromToRow.appendChild(
    h('input', {
      class: 'psInput psNumeric',
      id: 'psFromPage',
      inputmode: 'numeric',
      autocomplete: 'off',
      spellcheck: 'false',
      placeholder: '1',
      value: state.fromPage,
      on: { input: (event) => callbacks.onFromToChange((event.target as HTMLInputElement).value, state.toPage) },
    }),
  );
  fromToRow.appendChild(h('label', { class: 'psRangeLabel', text: 'To', for: 'psToPage' }));
  fromToRow.appendChild(
    h('input', {
      class: 'psInput psNumeric',
      id: 'psToPage',
      inputmode: 'numeric',
      autocomplete: 'off',
      spellcheck: 'false',
      placeholder: 'last',
      value: state.toPage,
      on: { input: (event) => callbacks.onFromToChange(state.fromPage, (event.target as HTMLInputElement).value) },
    }),
  );
  fromToRow.appendChild(
    h('button', {
      class: 'psTextButton',
      type: 'button',
      text: 'advanced',
      title: 'Exact pages / ranges such as 2,4,6-10',
      onClick: () => callbacks.onAdvancedToggle(true),
    }),
  );
  container.appendChild(fromToRow);

  const advancedRow = h('div', { class: `psRangeRow${state.advanced ? '' : ' psHidden'}` });
  advancedRow.appendChild(h('label', { class: 'psRangeLabel', text: 'Pages', for: 'psRangeText' }));
  advancedRow.appendChild(
    h('input', {
      class: 'psInput psMono',
      id: 'psRangeText',
      autocomplete: 'off',
      spellcheck: 'false',
      placeholder: '2,4,6-10 · 1-99 · 50- · all',
      value: state.rangeText,
      on: { input: (event) => callbacks.onRangeTextChange((event.target as HTMLInputElement).value) },
    }),
  );
  advancedRow.appendChild(
    h('button', {
      class: 'psTextButton',
      type: 'button',
      text: 'simple',
      title: 'Back to From / To',
      onClick: () => callbacks.onAdvancedToggle(false),
    }),
  );
  container.appendChild(advancedRow);

  container.appendChild(
    h(
      'div',
      { class: 'psRangeControls' },
      h('span', {
        class: `psHint${state.rangeError ? ' error' : ''}`,
        text: state.rangeError ?? state.rangeLabel ?? `up to ${state.pageLimit} pages per fetch`,
      }),
      button('batch', { variant: 'subtle', onClick: () => callbacks.onFromToChange(state.fromPage || '1', String(Number(state.fromPage || '1') + 4)) }),
    ),
  );

  // ------------------------------------------------------------------- filters
  container.appendChild(
    h(
      'div',
      { class: 'psSourceOptions' },
      h(
        'label',
        { class: 'psInline' },
        h('span', { text: 'Media' }),
        (() => {
          const select = h('select', {
            class: 'psSelect',
            title: 'Which post kinds a fetch may add to the list',
            on: { change: (event) => callbacks.onMediaChange((event.target as HTMLSelectElement).value as MediaFilter) },
          });
          for (const option of [
            { value: 'all', label: 'Pics + videos' },
            { value: 'video', label: 'Videos only' },
            { value: 'image', label: 'Pics only' },
          ] as const) {
            select.appendChild(h('option', { value: option.value, text: option.label, selected: option.value === state.media }));
          }
          return select;
        })(),
      ),
      h(
        'label',
        { class: 'psCheck', title: 'Hides originals Chrome reported complete. Older unverified starts are not hidden; this does not verify file contents.' },
        h('input', {
          type: 'checkbox',
          checked: state.skipDownloaded,
          on: { change: (event) => callbacks.onSkipDownloadedChange((event.target as HTMLInputElement).checked) },
        }),
        h('span', { text: 'Skip completed downloads' }),
      ),
    ),
  );

  if (state.supportsRatingFilter && server) {
    container.appendChild(
      h(
        'label',
        { class: 'psCheck psCheckWide' },
        h('input', {
          type: 'checkbox',
          checked: state.ratingEnabled,
          on: { change: () => callbacks.onToggleRatingFilter() },
        }),
        h('span', {
          text: `apply this profile's rating filter (${(state.allowedRatings ?? []).join(', ') || 'none allowed'})`,
        }),
      ),
    );
  }

  // ------------------------------------------------------------------- crawl
  container.appendChild(
    h(
      'div',
      { class: 'psActionRow' },
      button(state.busy === 'crawl' ? 'Fetching…' : 'Fetch selected pages', {
        variant: 'subtle',
        disabled: state.busy !== 'idle' || !server || Boolean(state.rangeError),
        onClick: () => callbacks.onFetchRange(),
      }),
      button(state.busy === 'crawl' ? 'Stop fetch' : 'Stop', {
        variant: 'danger',
        disabled: state.busy !== 'crawl',
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
        h('strong', { text: kindLabel(state.error.kind) }),
        h('p', { text: state.error.message }),
        state.error.hint ? h('small', { class: 'psHint', text: state.error.hint }) : null,
      ),
    );
  }

  const summaryBits: string[] = [];
  if (state.listedCount) summaryBits.push(`${state.listedCount} row(s) in the list`);
  if (state.matchedCount !== null && state.matchedCount !== undefined) summaryBits.push(`~${state.matchedCount} match(es) on the site`);
  if (state.skippedDownloaded) summaryBits.push(`${state.skippedDownloaded} previously completed, skipped`);
  container.appendChild(
    h('p', {
      class: 'psHint',
      text:
        summaryBits.join(' · ') ||
        'Fetching only adds rows to the list. Review or untick them, then press Download selected - it never downloads every page on its own.',
    }),
  );

  if (adapter?.notes?.length) {
    container.appendChild(h('small', { class: 'psHint', text: adapter.notes[0]! }));
  }
}

function filtersentence(state: ListingState, bits: string[]): string {
  const parts: string[] = [];
  if (state.media === 'video') parts.push('videos only');
  if (state.media === 'image') parts.push('pictures only');
  if (bits.length) parts.push(bits.join(' · '));
  if (!parts.length) return 'Two tags work on every site; metatags (rating:, score:>100) pass straight through to the site.';
  return `This fetch: ${parts.join(' · ')}.`;
}

/** Re-exported so the panel can show the same wording in the dock notice. */
export function mediaFilterLabel(media: MediaFilter): string {
  return media === 'video' ? 'videos' : media === 'image' ? 'pictures' : 'pictures and videos';
}

/** Does a post survive the listing filters? Pure - used by the panel and tests. */
export function postMatchesMedia(post: Pick<BooruPost, 'isVideo'>, media: MediaFilter): boolean {
  if (media === 'video') return post.isVideo;
  if (media === 'image') return !post.isVideo;
  return true;
}
