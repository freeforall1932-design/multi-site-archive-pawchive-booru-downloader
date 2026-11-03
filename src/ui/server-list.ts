import type { AdapterCatalogEntry } from '../core/messages.js';
import { isUsableServer } from '../core/servers.js';
import type { ServerConfigView } from '../shared/types.js';
import { h, button, icon } from './dom.js';
import { accountLine, ratingFilterLine, siteTypeChip, siteTypeLabel, validationDot } from './format.js';
import { relativeOrNever } from './format.js';

export interface ServerListState {
  servers: ServerConfigView[];
  adapters: AdapterCatalogEntry[];
  /** Server currently being validated (spinner instead of the Test button). */
  busyId: string | null;
  filter: string;
}

export interface ServerListCallbacks {
  onAdd(siteType?: string): void;
  onEdit(server: ServerConfigView): void;
  onDuplicate(server: ServerConfigView): void;
  onDelete(server: ServerConfigView): void;
  onSetDefault(server: ServerConfigView): void;
  onTest(server: ServerConfigView): void;
  onFilterChange(value: string): void;
  onOpenQueue(): void;
}

/**
 * Server list screen - the first-class entry point of the extension.
 * Shows every saved profile with its connection state, and exposes
 * add / edit / delete / set default / test / duplicate.
 */
export function renderServerList(container: HTMLElement, state: ServerListState, callbacks: ServerListCallbacks): void {
  container.replaceChildren();

  const query = state.filter.trim().toLowerCase();
  const servers = query
    ? state.servers.filter((server) =>
        [server.label, server.siteType, server.baseUrl, server.username].join(' ').toLowerCase().includes(query),
      )
    : state.servers;

  const header = h(
    'div',
    { class: 'view-header' },
    h(
      'div',
      {},
      h('h1', { text: 'Servers' }),
      h('p', {
        class: 'muted',
        text: `${state.servers.length} saved server${state.servers.length === 1 ? '' : 's'} · credentials stay on this device`,
      }),
    ),
    h(
      'div',
      { class: 'header-actions' },
      state.servers.length
        ? h('input', {
            class: 'search-input',
            id: 'server-filter',
            type: 'search',
            placeholder: 'Filter servers…',
            value: state.filter,
            on: { input: (event) => callbacks.onFilterChange((event.target as HTMLInputElement).value) },
          })
        : null,
      button('Add server', { variant: 'primary', iconName: 'plus', onClick: () => callbacks.onAdd() }),
    ),
  );
  container.appendChild(header);

  if (!state.servers.length) {
    container.appendChild(emptyState(state.adapters, callbacks));
    return;
  }

  const list = h('div', { class: 'server-list' });
  for (const server of servers) list.appendChild(serverCard(server, state, callbacks));
  if (!servers.length) {
    list.appendChild(h('p', { class: 'muted', text: 'No server matches that filter.' }));
  }
  container.appendChild(list);
}

function emptyState(adapters: AdapterCatalogEntry[], callbacks: ServerListCallbacks): HTMLElement {
  return h(
    'div',
    { class: 'empty-state' },
    h('div', { class: 'empty-icon' }, icon('servers', 28)),
    h('h2', { text: 'Add your first server' }),
    h('p', {
      class: 'muted',
      text: 'One entry per site account. You can save several profiles (even for the same site) and pick which one is the default target for downloads.',
    }),
    h(
      'div',
      { class: 'preset-row' },
      ...adapters.map((adapter) =>
        button(`Add ${adapter.displayName}`, { onClick: () => callbacks.onAdd(adapter.siteType) }),
      ),
    ),
    h('p', { class: 'muted small', text: 'Credentials are stored locally and used for configured sites. Review the security notes, especially for redirects and HTTP.' }),
  );
}

function serverCard(server: ServerConfigView, state: ServerListState, callbacks: ServerListCallbacks): HTMLElement {
  const busy = state.busyId === server.id;
  const adapter = state.adapters.find((entry) => entry.siteType === server.siteType);
  const usable = !!adapter && isUsableServer(server);

  return h(
    'article',
    { class: `card server-card${server.isDefault ? ' is-default' : ''}` },
    h(
      'div',
      { class: 'server-card-main' },
      h(
        'div',
        { class: 'server-title' },
        validationDot(server.validationStatus, server.validationMessage),
        h('strong', { text: server.label || siteTypeLabel(server.siteType) }),
        server.isDefault ? h('span', { class: 'chip chip-default', text: 'DEFAULT' }) : null,
        siteTypeChip(server.siteType),
      ),
      h('div', { class: 'mono server-url', text: server.baseUrl }),
      !adapter
        ? h('div', { class: 'muted small', text: 'This legacy site is no longer supported. Its profile is kept for export or deletion; it cannot be used for downloads.' })
        : !usable ? h('div', { class: 'muted small', text: 'This profile has an unsupported or invalid URL. Edit it to choose a supported site URL.' }) : null,
      h(
        'div',
        { class: 'server-meta' },
        h('span', { class: 'chip chip-soft', text: ratingFilterLine(server) }),
        h('span', { class: 'chip chip-soft', text: `key ${server.apiKeyMask || '—'}` }),
        adapter?.requiresUserAgent ? h('span', { class: 'chip chip-soft', text: 'UA policy' }) : null,
      ),
      h('div', { class: 'server-meta' }, accountLine(server)),
      h('div', {
        class: 'muted small',
        text: `Last validation: ${relativeOrNever(server.lastValidatedAt)}${
          server.validationMessage ? ` - ${server.validationMessage}` : ''
        }`,
      }),
    ),
    h(
      'div',
      { class: 'server-card-actions' },
      busy
        ? h('span', { class: 'spinner', attrs: { 'aria-label': 'Validating' } })
        : button('Test', { iconName: 'refresh', disabled: !adapter, onClick: () => callbacks.onTest(server) }),
      button('Edit', { iconName: 'edit', disabled: !adapter, onClick: () => callbacks.onEdit(server) }),
      button('Duplicate', { iconName: 'copy', disabled: !adapter, onClick: () => callbacks.onDuplicate(server) }),
      server.isDefault
        ? null
        : button('Set default', { iconName: 'star', disabled: !usable, onClick: () => callbacks.onSetDefault(server) }),
      button('Delete', { variant: 'danger', iconName: 'trash', onClick: () => callbacks.onDelete(server) }),
    ),
  );
}
