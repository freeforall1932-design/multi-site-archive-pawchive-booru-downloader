import type { DiagnosticsInfo } from '../core/messages.js';
import { button, h } from './dom.js';
import { kindLabel, siteTypeChip, validationDot } from './format.js';
import { relativeOrNever } from './format.js';
import { toast } from './toast.js';

export interface DiagnosticsCallbacks {
  onSyncUserAgent(): void;
  onCopy(): void;
  onOpenApiDocs(url: string): void;
}

/**
 * Diagnostics: adapter capability catalogue + last validation traces.
 * Deliberately shows capability differences between sites instead of pretending
 * they behave identically.
 */
export function renderDiagnostics(container: HTMLElement, info: DiagnosticsInfo, callbacks: DiagnosticsCallbacks): void {
  container.replaceChildren();

  container.appendChild(
    h(
      'div',
      { class: 'view-header' },
      h('div', {}, h('h1', { text: 'Diagnostics' }), h('p', { class: 'muted', text: `Version ${info.version} · ${info.environment} environment` })),
      h(
        'div',
        { class: 'header-actions' },
        button('Copy diagnostics', { iconName: 'copy', onClick: () => callbacks.onCopy() }),
        button('Re-sync UA rules', { iconName: 'refresh', onClick: () => callbacks.onSyncUserAgent() }),
      ),
    ),
  );

  const adapterTable = h(
    'table',
    { class: 'data-table' },
    h('thead', {}, h('tr', {}, h('th', { text: 'Site type' }), h('th', { text: 'Capabilities' }), h('th', { text: 'Rating tokens' }), h('th', { text: 'Credential fields' }), h('th', { text: 'Docs' }))),
  );
  const adapterBody = h('tbody');
  for (const adapter of info.adapters) {
    adapterBody.appendChild(
      h(
        'tr',
        {},
        h('td', {}, siteTypeChip(adapter.siteType)),
        h('td', { class: 'small', text: adapter.capabilitySummary }),
        h('td', { class: 'small mono', text: adapter.ratingTokens.join(' · ') }),
        h(
          'td',
          { class: 'small' },
          adapter.credentialFields.map((field) => h('div', { text: `${field.label}${field.required ? ' *' : ''}${field.secret ? ' (secret)' : ''}` })),
        ),
        h('td', {}, h('a', { class: 'link small', href: adapter.apiDocsUrl, target: '_blank', rel: 'noreferrer', text: 'API docs', onClick: () => callbacks.onOpenApiDocs(adapter.apiDocsUrl) })),
      ),
    );
  }
  adapterTable.appendChild(adapterBody);

  container.appendChild(
    h(
      'section',
      { class: 'card' },
      h('h2', { class: 'section-title', text: 'Registered adapters' }),
      h('p', { class: 'muted small', text: 'Every site difference lives in one of these adapters. Adding a site means registering another adapter - no UI changes.' }),
      adapterTable,
    ),
  );

  const serversTable = h(
    'table',
    { class: 'data-table' },
    h('thead', {}, h('tr', {}, h('th', { text: 'Server' }), h('th', { text: 'Type' }), h('th', { text: 'Rating filter' }), h('th', { text: 'Key stored' }), h('th', { text: 'Status' }), h('th', { text: 'Last validated' }))),
  );
  const serversBody = h('tbody');
  for (const server of info.servers) {
    serversBody.appendChild(
      h(
        'tr',
        {},
        h('td', { text: server.label }),
        h('td', {}, siteTypeChip(server.siteType)),
        h('td', { text: server.ratingFilterEnabled ? 'on' : 'off' }),
        h('td', { text: server.hasApiKey ? 'yes' : 'no' }),
        h('td', {}, validationDot(server.validationStatus as never), h('span', { class: 'small', text: ` ${server.validationStatus}` })),
        h('td', { class: 'small', text: relativeOrNever(server.lastValidatedAt) }),
      ),
    );
  }
  serversTable.appendChild(serversBody);

  container.appendChild(
    h('section', { class: 'card' }, h('h2', { class: 'section-title', text: 'Saved servers' }), serversTable),
  );

  for (const server of info.servers) {
    if (!server.trace?.length) continue;
    const table = h('table', { class: 'data-table small' }, h('thead', {}, h('tr', {}, h('th', { text: 'Probe' }), h('th', { text: 'Request (redacted)' }), h('th', { text: 'HTTP' }), h('th', { text: 'Result' }))));
    const body = h('tbody');
    for (const entry of server.trace) {
      body.appendChild(
        h(
          'tr',
          {},
          h('td', { text: entry.label }),
          h('td', { class: 'mono', text: `${entry.method} ${entry.requestUrl}` }),
          h('td', { text: entry.status === null ? '—' : String(entry.status) }),
          h('td', { text: `${entry.ok ? 'OK' : kindLabel(entry.kind ?? 'unknown')} - ${entry.message}` }),
        ),
      );
    }
    table.appendChild(body);
    container.appendChild(
      h('section', { class: 'card' }, h('h2', { class: 'section-title', text: `Last validation probe trace: ${server.label}` }), table),
    );
  }

  container.appendChild(
    h(
      'section',
      { class: 'card' },
      h('h2', { class: 'section-title', text: 'Environment' }),
      h(
        'dl',
        { class: 'validation-facts' },
        h('div', { class: 'fact' }, h('dt', { text: 'Storage keys' }), h('dd', { class: 'mono small', text: info.storageKeys.join(', ') })),
        h('div', { class: 'fact' }, h('dt', { text: 'User-Agent rules' }), h('dd', { text: `${info.userAgentRules.applied} applied${info.userAgentRules.error ? ` (${info.userAgentRules.error})` : ''}` })),
        h('div', { class: 'fact' }, h('dt', { text: 'Request interval' }), h('dd', { text: `${info.settings.minRequestIntervalMs} ms` })),
        h('div', { class: 'fact' }, h('dt', { text: 'Parallel downloads' }), h('dd', { text: String(info.settings.maxConcurrency) })),
      ),
    ),
  );
}

export function copyDiagnostics(info: DiagnosticsInfo): void {
  // Server key fields are masked, but arbitrary site data may contain secrets.
  const payload = JSON.stringify({ ...info, generatedAt: new Date().toISOString() }, null, 2);
  void navigator.clipboard?.writeText(payload).then(
    () => toast('Diagnostics copied to clipboard', 'success'),
    () => toast('Clipboard unavailable - nothing copied', 'error'),
  );
}
