import type { AdapterCatalogEntry } from '../core/messages.js';
import type { CredentialField } from '../core/adapter.js';
import type { Rating, ServerConfigView, ValidationResult } from '../shared/types.js';
import { ALL_RATINGS } from '../shared/types.js';
import { button, field, h } from './dom.js';
import { failureChip, kindLabel, siteTypeLabel, validationDot } from './format.js';

export interface ServerFormDraft {
  id?: string;
  label: string;
  siteType: string;
  baseUrl: string;
  ratingFilterEnabled: boolean;
  allowedRatings: Rating[];
  username: string;
  apiKey: string;
  userId: string;
  customUserAgent: string;
  isDefault: boolean;
}

/** Connection fields whose validation result becomes stale when edited. */
export function draftValidationSignature(draft: ServerFormDraft): string {
  return JSON.stringify({
    siteType: draft.siteType, baseUrl: draft.baseUrl, username: draft.username,
    apiKey: draft.apiKey, userId: draft.userId, customUserAgent: draft.customUserAgent,
  });
}

/** Keep both editors consistent about validation and the explicit offline override. */
export function draftSaveDecision(editor: {
  draft: ServerFormDraft;
  isNew: boolean;
  validation: ValidationResult | null;
  validatedSignature: string | null;
}, force: boolean): 'save' | 'validate' | 'blocked' {
  if (force) return 'save';
  const current = editor.validatedSignature === draftValidationSignature(editor.draft);
  if (current && editor.validation && !editor.validation.ok) return 'blocked';
  if (!editor.isNew && (!current || !editor.validation)) return 'validate';
  return 'save';
}

/** Switching family must not silently retain the old endpoint or credentials. */
export function withSiteDefaults(draft: ServerFormDraft, siteType: string, adapters: AdapterCatalogEntry[]): ServerFormDraft {
  const next = adapters.find((entry) => entry.siteType === siteType);
  return {
    ...draft, siteType, baseUrl: next?.baseUrl ?? '', label: next?.displayName ?? siteType,
    allowedRatings: next?.defaultRatings ?? [], ratingFilterEnabled: next?.supportsRatingFilter ?? true,
    customUserAgent: '', username: '', userId: '', apiKey: '',
  };
}

export interface ServerFormState {
  draft: ServerFormDraft;
  adapters: AdapterCatalogEntry[];
  /** Adapter credential fields for the selected site type. */
  credentialFields: CredentialField[];
  isNew: boolean;
  /** Existing masked key, shown as a placeholder while editing. */
  apiKeyMask: string;
  suggestedUserAgent: string;
  validation: ValidationResult | null;
  validating: boolean;
  /** True once the current form values have been validated in this session. */
  validatedCurrentValues: boolean;
  saving: boolean;
}

export interface ServerFormCallbacks {
  onChange(patch: Partial<ServerFormDraft>): void;
  onValidate(): void;
  onSave(options: { force: boolean }): void;
  onCancel(): void;
  onSuggestUserAgent(): void;
  onBackToList(): void;
}

/**
 * Add/edit server screen.
 * Fields follow the product schema (site type, base URL, rating filter, username,
 * API key, user id, optional User-Agent) and are driven by the selected adapter's
 * capability metadata - a new site type needs no changes here.
 */
export function renderServerForm(container: HTMLElement, state: ServerFormState, callbacks: ServerFormCallbacks): void {
  container.replaceChildren();
  const { draft, adapters } = state;
  const adapter = adapters.find((entry) => entry.siteType === draft.siteType) ?? null;
  const capabilityNotes = adapter?.notes ?? [];

  container.appendChild(
    h(
      'div',
      { class: 'view-header' },
      h(
        'div',
        {},
        h('h1', { text: state.isNew ? 'Add server' : `Edit ${draft.label || 'server'}` }),
        h('p', { class: 'muted', text: 'Credentials are stored locally. Review the security notes before using sensitive keys.' }),
      ),
      h('div', { class: 'header-actions' }, button('Back to list', { iconName: 'servers', onClick: () => callbacks.onBackToList() })),
    ),
  );

  const form = h('form', {
    class: 'card form-grid',
    on: {
      submit: (event) => {
        event.preventDefault();
        if (!state.saving && !state.validating) callbacks.onSave({ force: state.validation?.ok === true && state.validatedCurrentValues });
      },
    },
  });

  // ------------------------------------------------------------- connection
  const siteTypeSelect = h('select', {
    class: 'input',
    name: 'siteType',
    on: {
      change: (event) => callbacks.onChange({ siteType: (event.target as HTMLSelectElement).value }),
    },
  });
  for (const entry of adapters) {
    siteTypeSelect.appendChild(
      h('option', { value: entry.siteType, text: `${entry.displayName} (${entry.authStyle})`, selected: entry.siteType === draft.siteType }),
    );
  }
  form.appendChild(field('Site type', siteTypeSelect, { help: 'Which adapter talks to this server. Drives auth style, endpoints and rating tokens.' }));

  form.appendChild(
    field(
      'Label',
      h('input', {
        class: 'input',
        type: 'text',
        name: 'label',
        value: draft.label,
        placeholder: adapter ? `e.g. ${adapter.displayName} main` : 'My server',
        on: { input: (event) => callbacks.onChange({ label: (event.target as HTMLInputElement).value }) },
      }),
      { help: 'Shown in the server list and usable as {serverLabel} in filenames.' },
    ),
  );

  form.appendChild(
    field(
      'Base URL',
      h('input', {
        class: 'input mono',
        type: 'url',
        name: 'baseUrl',
        value: draft.baseUrl,
        placeholder: adapter?.baseUrl ?? 'https://example.com',
        on: { input: (event) => callbacks.onChange({ baseUrl: (event.target as HTMLInputElement).value }) },
      }),
      { help: 'Site root, without /posts or /index.php. When changing a saved target, re-enter its key or clear the old credentials first.' },
    ),
  );

  form.appendChild(
    h(
      'div',
      { class: 'inline-toggle' },
      h('input', {
        type: 'checkbox',
        id: 'rating-filter-toggle',
        checked: draft.ratingFilterEnabled,
        on: { change: (event) => callbacks.onChange({ ratingFilterEnabled: (event.target as HTMLInputElement).checked }) },
      }),
      h('label', { attrs: { for: 'rating-filter-toggle' }, text: 'Rating filter enabled' }),
      h('span', { class: 'muted small', text: 'Adds exclusion tags such as -rating:explicit to every search and queue add.' }),
    ),
  );

  form.appendChild(
    h(
      'div',
      { class: 'rating-choices' },
      ...ALL_RATINGS.map((rating) =>
        h(
          'label',
          { class: 'checkbox-chip' },
          h('input', {
            type: 'checkbox',
            checked: draft.allowedRatings.includes(rating),
            disabled: !draft.ratingFilterEnabled,
            on: {
              change: (event) => {
                const checked = (event.target as HTMLInputElement).checked;
                const next = checked
                  ? [...draft.allowedRatings, rating]
                  : draft.allowedRatings.filter((value) => value !== rating);
                callbacks.onChange({ allowedRatings: next });
              },
            },
          }),
          h('span', { text: rating }),
        ),
      ),
    ),
  );

  // ----------------------------------------------------------- credentials
  form.appendChild(h('h2', { class: 'section-title', text: 'Account' }));
  for (const spec of state.credentialFields) {
    const key = spec.key;
    const value = String(draft[key] ?? '');
    const isSecret = spec.secret;
    const control =
      spec.type === 'password'
        ? h('input', {
            class: 'input mono',
            type: 'password',
            name: key,
            value,
            placeholder: state.isNew ? spec.placeholder ?? '' : state.apiKeyMask || spec.placeholder || '',
            autocomplete: 'off',
            on: { input: (event) => callbacks.onChange({ [key]: (event.target as HTMLInputElement).value } as Partial<ServerFormDraft>) },
          })
        : h('input', {
            class: 'input',
            type: 'text',
            name: key,
            value,
            placeholder: spec.placeholder ?? '',
            autocomplete: 'off',
            on: { input: (event) => callbacks.onChange({ [key]: (event.target as HTMLInputElement).value } as Partial<ServerFormDraft>) },
          });
    const helpParts = [spec.help];
    if (spec.required) helpParts.push('Required.');
    else if (spec.requiredForAuth) helpParts.push('Required when credentials are used.');
    if (isSecret && !state.isNew && state.apiKeyMask) helpParts.push(`Stored: ${state.apiKeyMask} - leave blank to keep it.`);
    form.appendChild(field(spec.label, control, { help: helpParts.filter(Boolean).join(' ') }));

    if (key === 'customUserAgent' && adapter?.requiresUserAgent) {
      form.appendChild(
        h(
          'div',
          { class: 'inline-hint' },
          h('code', { class: 'mono', text: state.suggestedUserAgent }),
          button('Use suggested', { variant: 'subtle', iconName: 'check', onClick: () => callbacks.onSuggestUserAgent() }),
        ),
      );
    }
  }

  if (capabilityNotes.length) {
    form.appendChild(
      h(
        'details',
        { class: 'capability-notes' },
        h('summary', { text: `${siteTypeLabel(draft.siteType)} adapter notes` }),
        h('ul', {}, ...capabilityNotes.map((note) => h('li', { text: note }))),
        adapter ? h('p', { class: 'muted small', text: `API docs: ${adapter.apiDocsUrl}` }) : null,
      ),
    );
  }

  // --------------------------------------------------------------- actions
  form.appendChild(
    h(
      'div',
      { class: 'form-actions' },
      button(state.validating ? 'Validating…' : 'Validate client', {
        iconName: 'shield',
        disabled: state.validating,
        onClick: () => callbacks.onValidate(),
      }),
      button(state.saving ? 'Saving…' : state.isNew ? 'Save server' : 'Save changes', {
        variant: 'primary',
        iconName: 'check',
        disabled: state.saving || state.validating,
        onClick: () => callbacks.onSave({ force: state.validation?.ok === true && state.validatedCurrentValues }),
      }),
      button('Cancel', { variant: 'ghost', onClick: () => callbacks.onCancel() }),
      state.validation && !state.validation.ok
        ? button('Save anyway', {
            variant: 'ghost',
            title: 'Save without a successful validation (for offline setups)',
            onClick: () => callbacks.onSave({ force: true }),
          })
        : null,
    ),
  );

  // The controller intentionally ignores edits while a save is in flight.
  // Disable those controls so typing cannot appear to succeed and then vanish.
  if (state.saving) {
    for (const control of form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>('input, select, textarea, button')) {
      control.disabled = true;
    }
  }
  container.appendChild(form);
  container.appendChild(validationPanel(state));
}

/** Validation result panel: distinguishes auth / endpoint / network / unsupported. */
function validationPanel(state: ServerFormState): HTMLElement {
  const { validation } = state;
  if (!validation) {
    return h(
      'section',
      { class: 'card validation-panel muted' },
      h('h2', { class: 'section-title', text: 'Validation' }),
      h('p', { text: 'Run "Validate client" to check endpoint compatibility and credentials before saving.' }),
    );
  }

  const statusClass = validation.ok ? 'ok' : `fail fail-${validation.kind}`;
  const panel = h(
    'section',
    { class: `card validation-panel ${statusClass}` },
    h(
      'div',
      { class: 'validation-head' },
      validationDot(validation.ok ? 'valid' : validation.endpointOk === false ? 'invalid' : 'partial', validation.message),
      h('strong', { text: validation.ok ? 'Validation succeeded' : kindLabel(validation.kind) }),
      !validation.ok ? failureChip(validation.kind as never, validation.message) : null,
      h('span', { class: 'muted small', text: `${validation.durationMs ?? 0} ms` }),
    ),
    h('p', { text: validation.message }),
    validation.warnings.length
      ? h('ul', { class: 'warnings' }, ...validation.warnings.map((warning) => h('li', { text: warning })))
      : null,
    h(
      'dl',
      { class: 'validation-facts' },
      fact('Endpoint reachable', validation.endpointOk === null ? 'not checked' : validation.endpointOk ? 'yes' : 'no'),
      fact('Credentials accepted', validation.authOk === null ? 'no credentials supplied' : validation.authOk ? 'yes' : 'no'),
      validation.account?.username ? fact('Signed in as', validation.account.username) : null,
      validation.account?.userId ? fact('Account id', validation.account.userId) : null,
      validation.account?.level ? fact('Account level', validation.account.level) : null,
    ),
  );

  if (validation.trace.length) {
    const table = h(
      'table',
      { class: 'trace-table' },
      h(
        'thead',
        {},
        h('tr', {}, h('th', { text: 'Check' }), h('th', { text: 'Request' }), h('th', { text: 'Status' }), h('th', { text: 'Result' })),
      ),
    );
    const body = h('tbody');
    for (const entry of validation.trace) {
      body.appendChild(
        h(
          'tr',
          {},
          h('td', { text: entry.label }),
          h('td', { class: 'mono small', text: `${entry.method} ${entry.requestUrl}` }),
          h('td', { text: entry.status === null ? '—' : String(entry.status) }),
          h('td', { text: entry.message }),
        ),
      );
    }
    table.appendChild(body);
    panel.appendChild(h('details', { class: 'trace' }, h('summary', { text: `Probe trace (${validation.trace.length})` }), table));
  }

  return panel;
}

function fact(label: string, value: string): HTMLElement {
  return h('div', { class: 'fact' }, h('dt', { text: label }), h('dd', { text: value }));
}

/** Build a draft from a saved (masked) server view. */
export function draftFromServer(server: ServerConfigView): ServerFormDraft {
  return {
    id: server.id,
    label: server.label,
    siteType: server.siteType,
    baseUrl: server.baseUrl,
    ratingFilterEnabled: server.ratingFilterEnabled,
    allowedRatings: server.allowedRatings ?? [],
    username: server.username,
    apiKey: '',
    userId: server.userId,
    customUserAgent: server.customUserAgent,
    isDefault: server.isDefault,
  };
}

/** Build a draft for a brand-new profile of a given site type. */
export function draftForSiteType(siteType: string, adapters: AdapterCatalogEntry[]): ServerFormDraft {
  const adapter = adapters.find((entry) => entry.siteType === siteType);
  return {
    label: adapter?.displayName ?? siteType,
    siteType,
    baseUrl: adapter?.baseUrl ?? '',
    ratingFilterEnabled: adapter?.supportsRatingFilter ?? true,
    allowedRatings: adapter?.defaultRatings ?? [],
    username: '',
    apiKey: '',
    userId: '',
    customUserAgent: '',
    isDefault: false,
  };
}
