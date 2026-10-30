/**
 * Settings rendered as **sections**, in the style of the NHentai Downloader
 * options page: a heading per area, the control underneath, and a plain-language
 * `<small>` hint that says what the setting does *and* what happens when it is on
 * or off. The same markup is used by the side panel's Settings tab (where it is
 * the only settings surface a user needs) and by the full options page, so the
 * two can never drift apart.
 *
 * Sections, in order:
 *   1. Global behaviour      - what the toolbar opens, theme, panel defaults
 *   2. Downloads at once     - concurrency, request spacing, retries, duplicates
 *   3. Listing & queue       - media filter, page cap, queue rows, skip downloaded
 *   4. Search behaviour      - global suffix, tag blacklist, search history
 *   5. Name template         - token checkboxes + custom template + live preview
 *   6. Interface             - thumbnails, content-script button, auto-start
 *   7. Advanced behaviour    - User-Agent handling, rating enforcement, host access
 *   8. Server credentials    - what is stored, export/import, wipe
 *   9. Download history      - counters, reset
 */
import type { AdapterCatalogEntry } from '../core/messages.js';
import { TEMPLATE_SEPARATOR, TEMPLATE_TOKENS, buildTemplate, isCanonicalTemplate, previewNaming, templateTokensInUse } from '../core/template.js';
import { DEFAULT_MIRROR_FOLDER, type ExtensionSettings, type MediaFilter, type ServerConfigView } from '../shared/types.js';
import { button, h } from './dom.js';
import { toast } from './toast.js';

export interface SettingsSectionsState {
  settings: ExtensionSettings;
  saving: boolean;
  servers: ServerConfigView[];
  adapters: AdapterCatalogEntry[];
  historyCount: number;
  searchCount: number;
  hostAccess: { origin: string; granted: boolean } | null;
}

export interface SettingsSectionsCallbacks {
  onChange(patch: Partial<ExtensionSettings>): void;
  onSave(): void;
  onReset(): void;
  onExport(includeSecrets: boolean): void;
  onImport(json: string, includeSecrets: boolean): void;
  onClearAllCredentials(): void;
  onSyncUserAgent(): void;
  onRequestHostAccess(): void;
  onClearHistory(): void;
  onClearSearches(): void;
  onOpenServers(): void;
  /** Open the file/URL the preview points at (optional - panel keeps it inline). */
  onPreviewPath?(path: string): void;
}

// ------------------------------------------------------------------ primitives

/** Section heading (`<h3>`) plus its explanatory one-liner. */
export function section(title: string, description?: string): HTMLElement {
  return h(
    'div',
    { class: 'psSectionHead' },
    h('h3', { text: title }),
    description ? h('small', { class: 'psHint', text: description }) : null,
  );
}

function hint(text: string, tone: 'plain' | 'warn' | 'ok' = 'plain'): HTMLElement {
  return h('small', { class: `psHint${tone === 'plain' ? '' : ` ${tone}`}`, text });
}

function select<T extends string>(
  value: T,
  options: Array<{ value: T; label: string }>,
  onChange: (value: T) => void,
  extra: { id?: string; title?: string } = {},
): HTMLElement {
  const element = h('select', {
    class: 'psSelect',
    id: extra.id,
    title: extra.title,
    on: { change: (event) => onChange((event.target as HTMLSelectElement).value as T) },
  });
  for (const option of options) {
    element.appendChild(h('option', { value: option.value, text: option.label, selected: option.value === value }));
  }
  return element;
}

function checkbox(id: string, label: string, checked: boolean, title: string, onChange: (value: boolean) => void): HTMLElement {
  return h(
    'label',
    { class: 'psCheck', title },
    h('input', {
      type: 'checkbox',
      id,
      checked,
      on: { change: (event) => onChange((event.target as HTMLInputElement).checked) },
    }),
    h('span', { text: label }),
  );
}

function textInput(
  id: string,
  value: string,
  placeholder: string,
  onChange: (value: string) => void,
  extra: { password?: boolean; spellcheck?: boolean; title?: string } = {},
): HTMLInputElement {
  const input = h('input', {
    class: 'psInput',
    id,
    type: extra.password ? 'password' : 'text',
    value,
    placeholder,
    title: extra.title,
    spellcheck: extra.spellcheck === false ? 'false' : 'true',
    autocomplete: 'off',
    on: { input: (event) => onChange((event.target as HTMLInputElement).value) },
  });
  return input;
}

/** A settings row: label on the left, control on the right, hint below. */
function row(label: string, control: HTMLElement, description: string, options: { warn?: boolean } = {}): HTMLElement {
  return h(
    'div',
    { class: 'psRow' },
    h('label', { class: 'psRowLabel', text: label, for: control.id || undefined }),
    control,
    hint(description, options.warn ? 'warn' : 'plain'),
  );
}

// ---------------------------------------------------------------------- view

export function renderSettingsSections(
  container: HTMLElement,
  state: SettingsSectionsState,
  callbacks: SettingsSectionsCallbacks,
): void {
  container.replaceChildren();
  const { settings } = state;

  container.classList.add('psSections');

  // ------------------------------------------------------- 1. global behaviour
  container.appendChild(
    section(
      'Global behaviour',
      'Applies to every server unless an adapter requires stricter limits. Changes are stored as you make them; the Save button is a shortcut, not a requirement.',
    ),
  );
  container.appendChild(
    row(
      'Toolbar click opens',
      select(
        settings.uiMode,
        [
          { value: 'sidepanel', label: 'Side panel (dockable)' },
          { value: 'popup', label: 'Popup (closes when it loses focus)' },
        ],
        (value) => callbacks.onChange({ uiMode: value }),
        { id: 'psUiMode' },
      ),
      'The side panel stays open next to the page and can be resized; the popup closes as soon as you click away. Both show exactly the same view.',
    ),
  );
  container.appendChild(
    row(
      'Panel opens on',
      select(
        settings.panelDefaultTab,
        [
          { value: 'browse', label: 'Browse (search + listing)' },
          { value: 'queue', label: 'Queue' },
          { value: 'links', label: 'Links (mirror link collector)' },
          { value: 'servers', label: 'Servers' },
          { value: 'settings', label: 'Settings' },
        ],
        (value) => callbacks.onChange({ panelDefaultTab: value }),
        { id: 'psDefaultTab' },
      ),
      'Which tab the side panel shows when it opens. The Queue tab keeps a live count while downloads run.',
    ),
  );
  container.appendChild(
    row(
      'Theme',
      select(
        settings.theme,
        [
          { value: 'system', label: 'Follow the browser' },
          { value: 'light', label: 'Light' },
          { value: 'dark', label: 'Dark' },
        ],
        (value) => callbacks.onChange({ theme: value }),
        { id: 'psTheme' },
      ),
      'The panel is designed dark-first; light mode is available for daytime reading.',
    ),
  );

  container.appendChild(h('hr', { class: 'psDivider' }));

  // ---------------------------------------------------- 2. download behaviour
  container.appendChild(
    section('Multiple download', 'How many files are fetched at once and what happens when one already exists.'),
  );
  container.appendChild(
    row(
      'Queue start workers',
      select(
        String(settings.maxConcurrency) as '1' | '2' | '3' | '5' | '8',
        [
          { value: '1', label: '1 (slowest, gentlest)' },
          { value: '2', label: '2' },
          { value: '3', label: '3 (recommended)' },
          { value: '5', label: '5 (fast)' },
          { value: '8', label: '8 (may trigger rate limits)' },
        ],
        (value) => callbacks.onChange({ maxConcurrency: Number(value) }),
        { id: 'psConcurrency' },
      ),
      'Number of workers preparing and starting downloads. Chrome manages transfers after they start, so this does not cap active downloads. Pawchive starts remain spaced apart.',
    ),
  );
  container.appendChild(
    row(
      'Wait between requests to one server',
      select(
        String(settings.minRequestIntervalMs) as never,
        [
          { value: '0', label: 'No extra wait' },
          { value: '500', label: '0.5 s' },
          { value: '1000', label: '1 s (default)' },
          { value: '2000', label: '2 s' },
          { value: '5000', label: '5 s' },
        ].map((entry) => ({ value: entry.value as never, label: entry.label })),
        (value) => callbacks.onChange({ minRequestIntervalMs: Number(value) }),
        { id: 'psInterval' },
      ),
      'Per-server spacing for API calls. Adapters raise this when the site documents a hard limit (e621 asks for 2 requests/second at most), so the effective value is the stricter of the two.',
    ),
  );
  container.appendChild(
    row(
      'Retries per download',
      select(
        String(settings.maxRetries) as never,
        [
          { value: '1', label: '1 (no retry)' },
          { value: '3', label: '3 (default)' },
          { value: '5', label: '5' },
          { value: '8', label: '8 (persistent)' },
        ].map((entry) => ({ value: entry.value as never, label: entry.label })),
        (value) => callbacks.onChange({ maxRetries: Number(value) }),
        { id: 'psRetries' },
      ),
      'Transient failures (network glitches, 5xx, "slow down" answers) are retried with backoff. Authentication and missing-configuration errors are never retried - they would fail again.',
    ),
  );
  container.appendChild(
    row(
      'If the file already exists',
      select(
        settings.duplicateBehaviour,
        [
          { value: 'uniquify', label: 'Keep both (add a number)' },
          { value: 'overwrite', label: 'Overwrite' },
        ],
        (value) => callbacks.onChange({ duplicateBehaviour: value }),
        { id: 'psDuplicate' },
      ),
      'Keep both is the safe default: nothing already on disk is replaced. Overwrite is useful when a post was re-uploaded with a better file.',
    ),
  );

  container.appendChild(h('hr', { class: 'psDivider' }));

  // -------------------------------------------------- 2b. mirror link collector
  container.appendChild(
    section(
      'Mirror links',
      'The Links tab collects the off-site download links inside a creator’s posts (Google Drive, Mega, MediaFire, …). These three options decide what it keeps and where those files go.',
    ),
  );
  container.appendChild(
    row(
      'Only download-looking links',
      select(
        settings.mirrorLinksFilter,
        [
          { value: 'downloads', label: 'Known providers + file-looking URLs' },
          { value: 'any', label: 'Every external link' },
        ],
        (value) => callbacks.onChange({ mirrorLinksFilter: value as ExtensionSettings['mirrorLinksFilter'] }),
        { id: 'psMirrorFilter' },
      ),
      'The default keeps links from recognised file hosts and URLs that end in a file, look like a download or carry a long hash. "Every external link" is the noisy-but-complete option for posts that link somewhere unusual. Links on the site itself are never collected - those are normal post downloads.',
    ),
  );
  container.appendChild(
    row(
      'Extra provider hosts',
      textInput('psMirrorHosts', settings.mirrorExtraHosts, 'mega.nz, mydrive.example', (value) =>
        callbacks.onChange({ mirrorExtraHosts: value }),
      ),
      'Which hosts count as providers, space or comma separated. Add your own mirror here; a subdomain counts too, so `mega.nz` also matches `www.mega.nz`.',
    ),
  );
  container.appendChild(
    row(
      'Mirror folder template',
      textInput('psMirrorFolder', settings.mirrorFolderTemplate, DEFAULT_MIRROR_FOLDER, (value) =>
        callbacks.onChange({ mirrorFolderTemplate: value }),
      ),
      `Where collected links are saved. Tokens here describe a URL, not a post: {host} {provider} {siteType} {filename} {ext} {date}. Default: ${DEFAULT_MIRROR_FOLDER}.`,
    ),
  );

  container.appendChild(h('hr', { class: 'psDivider' }));

  // ------------------------------------------------------ 3. listing & queue
  container.appendChild(section('List results', 'What a fetch adds to the queue, and what the queue list shows.'));
  container.appendChild(
    row(
      'Default media filter',
      select(
        settings.mediaFilter,
        [
          { value: 'all', label: 'Pictures and videos' },
          { value: 'video', label: 'Videos only' },
          { value: 'image', label: 'Pictures only' },
        ],
        (value) => callbacks.onChange({ mediaFilter: value as MediaFilter }),
        { id: 'psMedia' },
      ),
      'Applied when posts are listed, so a video-only run does not fill the queue with pictures. You can still change it per fetch in the listing card.',
    ),
  );
  container.appendChild(
    row(
      'Pages per fetch',
      select(
        String(settings.pageRangeLimit) as never,
        [25, 50, 100, 150, 250, 500].map((value) => ({
          value: String(value) as never,
          label: `${value} pages${value === 150 ? ' (default)' : ''}`,
        })),
        (value) => callbacks.onChange({ pageRangeLimit: Number(value) }),
        { id: 'psPageLimit' },
      ),
      'The hard cap on one crawl, so a typo in "Pages" cannot queue ten thousand pages. Fetching is always review-then-download: pages are listed, ticked, and only then downloaded.',
    ),
  );
  container.appendChild(
    row(
      'Queue rows shown',
      select(
        String(settings.queueRowLimit) as never,
        [20, 30, 60, 100, 200, 500].map((value) => ({
          value: String(value) as never,
          label: `${value} rows${value === 60 ? ' (default)' : ''}`,
        })),
        (value) => callbacks.onChange({ queueRowLimit: Number(value) }),
        { id: 'psQueueRows' },
      ),
      'Long queues stay responsive: the rest is summarised under the list as "n more rows". It changes what is drawn, never what is downloaded.',
    ),
  );
  container.appendChild(
    row(
      'Skip posts previously completed',
      select(
        settings.skipDownloaded ? 'on' : 'off',
        [
          { value: 'on', label: 'Yes - hide them' },
          { value: 'off', label: 'No - list everything' },
        ],
        (value) => callbacks.onChange({ skipDownloaded: value === 'on' }),
        { id: 'psSkipDownloaded' },
      ),
      'Only original downloads Chrome reported complete are hidden. Older starts and unknown-quality records are ignored. This does not verify file contents or that the file still exists.',
    ),
  );

  container.appendChild(h('hr', { class: 'psDivider' }));

  // ----------------------------------------------------------- 4. search rules
  container.appendChild(
    section('Search behaviour', 'Tag rules apply to booru searches, not Pawchive creator or title queries.'),
  );
  container.appendChild(
    row(
      'Always append these tags',
      textInput(
        'psGlobalSuffix',
        settings.globalTagSuffix,
        'e.g. -scat -gore',
        (value) => callbacks.onChange({ globalTagSuffix: value }),
      ),
      'Appended to booru searches (and to queueing from a listing). Pawchive searches are not tag-booru queries and do not use this rule.',
    ),
  );
  container.appendChild(
    row(
      'Never show these tags',
      textInput(
        'psBlacklist',
        settings.tagBlacklist,
        'e.g. guro vore scat',
        (value) => callbacks.onChange({ tagBlacklist: value }),
      ),
      'Space or comma separated. Each tag is excluded with the portable "-tag" syntax on supported boorus. This blacklist does not filter Pawchive results.',
    ),
  );
  container.appendChild(
    row(
      'Remember my searches',
      select(
        settings.searchHistoryEnabled ? 'on' : 'off',
        [
          { value: 'on', label: 'Yes' },
          { value: 'off', label: 'No' },
        ],
        (value) => callbacks.onChange({ searchHistoryEnabled: value === 'on' }),
        { id: 'psSearchHistory' },
      ),
      'Recent queries appear as suggestions under the search box and can be re-run with one click. Stored per server, in this browser only.',
    ),
  );
  container.appendChild(
    row(
      'Searches remembered per server',
      select(
        String(settings.searchHistoryLimit) as never,
        [0, 5, 12, 25, 50].map((value) => ({
          value: String(value) as never,
          label: value === 0 ? 'None' : `${value}${value === 12 ? ' (default)' : ''}`,
        })),
        (value) => callbacks.onChange({ searchHistoryLimit: Number(value) }),
        { id: 'psSearchHistoryLimit' },
      ),
      `Currently remembering ${state.searchCount} search(es). Setting this to None also stops new ones being stored.`,
    ),
  );

  container.appendChild(h('hr', { class: 'psDivider' }));

  // ------------------------------------------------------------ 5. name template
  container.appendChild(
    section(
      'Name template',
      'What the saved file is called and which folder it lands in. The file extension is always appended from the post metadata.',
    ),
  );
  container.appendChild(
    row(
      'Folder',
      textInput('psFolderTemplate', settings.folderTemplate, 'booru/{siteType}', (value) => callbacks.onChange({ folderTemplate: value })),
      'Slashes create sub-folders, e.g. booru/{siteType}/{artist} groups one artist together. Segments are sanitised, so illegal characters can never create a path outside the download folder.',
    ),
  );

  const templateSection = renderTemplateEditor(state, callbacks);
  container.appendChild(templateSection.element);

  container.appendChild(
    row(
      'Tags in the filename',
      select(
        String(settings.maxTagsInFilename) as never,
        [1, 3, 5, 10, 20, 30].map((value) => ({
          value: String(value) as never,
          label: `${value}${value === 5 ? ' (default)' : ''}`,
        })),
        (value) => callbacks.onChange({ maxTagsInFilename: Number(value) }),
        { id: 'psMaxTags' },
      ),
      'How many tags {tags}, {artists} and {tagN} expand to. The full filename is capped at 180 characters and shortened with a warning in the queue row when it has to be.',
    ),
  );
  container.appendChild(
    row(
      'Tag separator',
      select(
        settings.tagSeparator,
        [
          { value: ' ', label: 'Space' },
          { value: '_', label: 'Underscore' },
          { value: '-', label: 'Dash' },
          { value: ',', label: 'Comma' },
        ],
        (value) => callbacks.onChange({ tagSeparator: value }),
        { id: 'psTagSeparator' },
      ),
      'Used when several tags are joined in one filename token.',
    ),
  );

  container.appendChild(h('hr', { class: 'psDivider' }));

  // -------------------------------------------------------------- 6. interface
  container.appendChild(section('Interface', 'How the extension behaves on the pages you visit.'));
  container.appendChild(
    row(
      'Post thumbnails in the queue',
      select(
        settings.showThumbnails ? 'on' : 'off',
        [
          { value: 'on', label: 'Show' },
          { value: 'off', label: 'Hide (text only)' },
        ],
        (value) => callbacks.onChange({ showThumbnails: value === 'on' }),
        { id: 'psThumbnails' },
      ),
      'Thumbnails make it obvious what a row is, but they cost one preview request per row. Hide them on slow connections or when working with a long queue.',
    ),
  );
  container.appendChild(
    row(
      'Start downloading immediately',
      select(
        settings.autoStartQueue ? 'on' : 'off',
        [
          { value: 'on', label: 'Yes - "Download selected" runs the queue' },
          { value: 'off', label: 'No - only add to the queue' },
        ],
        (value) => callbacks.onChange({ autoStartQueue: value === 'on' }),
        { id: 'psAutoStart' },
      ),
      'Off means the queue is filled but only starts when you press Start on the dock. Useful when you want to review a big fetch first.',
    ),
  );
  container.appendChild(
    row(
      'Download button on post pages',
      select(
        settings.enableContentScriptButton ? 'on' : 'off',
        [
          { value: 'on', label: 'Show it' },
          { value: 'off', label: 'Hidden' },
        ],
        (value) => callbacks.onChange({ enableContentScriptButton: value === 'on' }),
        { id: 'psContentButton' },
      ),
      'A small floating button on supported post pages that downloads (or queues) the post you are looking at, without opening the panel. Reload the page after changing this.',
    ),
  );

  container.appendChild(h('hr', { class: 'psDivider' }));

  // ------------------------------------------------------- 7. advanced behaviour
  container.appendChild(
    section('Advanced behaviour', 'Only worth touching when a site asks for it or something is being blocked.'),
  );
  container.appendChild(
    row(
      'Identify as this extension',
      select(
        settings.rewriteUserAgent ? 'on' : 'off',
        [
          { value: 'on', label: 'Send a descriptive User-Agent' },
          { value: 'off', label: 'Send the browser User-Agent' },
        ],
        (value) => callbacks.onChange({ rewriteUserAgent: value === 'on' }),
        { id: 'psRewriteUa' },
      ),
      'e621 and Danbooru ask every client to identify itself; this rewrites the request header per server (declarativeNetRequest). Turning it off is only useful for debugging.',
    ),
  );
  container.appendChild(
    row(
      'Also send the _client parameter',
      select(
        settings.sendClientParam ? 'on' : 'off',
        [
          { value: 'on', label: 'Yes (works when headers are stripped)' },
          { value: 'off', label: 'No' },
        ],
        (value) => callbacks.onChange({ sendClientParam: value === 'on' }),
        { id: 'psClientParam' },
      ),
      'Some proxies strip custom headers. Where a site documents `_client`, the same identifier is sent as a query parameter too, so validation still passes.',
    ),
  );
  container.appendChild(
    row(
      'Enforce the rating filter on download',
      select(
        settings.enforceRatingFilterOnDownload ? 'on' : 'off',
        [
          { value: 'on', label: 'Yes - skip posts outside the allow-list' },
          { value: 'off', label: 'No - download exactly what I asked for' },
        ],
        (value) => callbacks.onChange({ enforceRatingFilterOnDownload: value === 'on' }),
        { id: 'psEnforceRating' },
      ),
      'Listing already filters; this makes single-post downloads obey the same rule, so a hand-picked link cannot slip past the server allow-list.',
    ),
  );

  const hostAccess = renderHostAccess(state, callbacks);
  container.appendChild(hostAccess);

  container.appendChild(
    h(
      'div',
      { class: 'psButtonRow' },
      button(settings.rewriteUserAgent ? 'Re-sync User-Agent rules' : 'Sync User-Agent rules', {
        variant: 'subtle',
        onClick: () => callbacks.onSyncUserAgent(),
      }),
    ),
  );

  container.appendChild(h('hr', { class: 'psDivider' }));

  // --------------------------------------------------------- 8. saved servers
  container.appendChild(
    section(
      'Server credentials',
      'Every server profile is stored in this browser only (chrome.storage.local), is never synced, and is never sent anywhere except to the site it belongs to. Keys are shown masked everywhere in the UI.',
    ),
  );
  container.appendChild(
    h(
      'div',
      { class: 'psStatus' },
      `${state.servers.length} saved server(s) · ${state.servers.filter((server) => server.hasApiKey).length} with a key · ${state.servers.filter((server) => server.validationStatus === 'valid').length} validated`,
    ),
  );
  container.appendChild(
    h(
      'div',
      { class: 'psButtonRow' },
      button('Open server list', { onClick: () => callbacks.onOpenServers() }),
      button('Export profiles', { variant: 'subtle', onClick: () => callbacks.onExport(false) }),
      button('Export with keys', { variant: 'subtle', onClick: () => confirmExport(callbacks) }),
      button('Import profiles', { variant: 'subtle', onClick: () => importFlow(callbacks) }),
      button('Delete all keys', { variant: 'danger', onClick: () => confirmWipe(callbacks) }),
    ),
  );
  container.appendChild(
    hint(
      'Export without keys is safe to move between machines; the "with keys" export contains your API keys in clear text - keep it private. Import accepts both shapes.',
    ),
  );

  container.appendChild(h('hr', { class: 'psDivider' }));

  // ---------------------------------------------------------- 9. download history
  container.appendChild(
    section(
      'Download history',
      'Post ids are remembered after Chrome reports an original-file download complete. Older start-only entries remain unverified; no hashes or file contents are checked. These buttons do not delete files.',
    ),
  );
  container.appendChild(h('div', { class: 'psStatus' }, `${state.historyCount} history record(s) retained · ${state.searchCount} remembered search(es)`));
  container.appendChild(
    h(
      'div',
      { class: 'psButtonRow' },
      button('Reset download history', { variant: 'subtle', onClick: () => callbacks.onClearHistory() }),
      button('Clear search history', { variant: 'subtle', onClick: () => callbacks.onClearSearches() }),
      button('Reset every setting', { variant: 'danger', onClick: () => callbacks.onReset() }),
    ),
  );
  container.appendChild(
    hint(
      'Resetting the download history makes every post listable again. "Reset every setting" restores the defaults above - saved servers and their keys are left untouched.',
    ),
  );

  // ------------------------------------------------------------------- footer
  container.appendChild(
    h(
      'div',
      { class: 'psFooter' },
      button(state.saving ? 'Saving…' : 'Save settings', { variant: 'primary', disabled: state.saving, onClick: () => callbacks.onSave() }),
      h('small', { class: 'psHint', text: 'Settings are stored as you change them; use this button to re-apply and sync the User-Agent rules in one go.' }),
    ),
  );
}

// ------------------------------------------------------- template sub-editor

interface TemplateEditor {
  element: HTMLElement;
  refresh(): void;
}

function renderTemplateEditor(state: SettingsSectionsState, callbacks: SettingsSectionsCallbacks): TemplateEditor {
  const element = h('div', { class: 'psTemplate' });
  const canonical = isCanonicalTemplate(state.settings.filenameTemplate, TEMPLATE_SEPARATOR);
  const inUse = templateTokensInUse(state.settings.filenameTemplate);

  element.appendChild(h('label', { class: 'psRowLabel', text: 'File name is built from' }));
  element.appendChild(
    hint(
      'Tick what the file name should contain; the template is rebuilt in this order. Ticking nothing falls back to the post id.',
    ),
  );

  const checks = h('div', { class: 'psChecks' });
  for (const token of TEMPLATE_TOKENS) {
    checks.appendChild(
      h(
        'label',
        { class: 'psCheck', title: token.hint },
        h('input', {
          type: 'checkbox',
          checked: canonical === null ? Boolean(inUse[token.token]) : Boolean(inUse[token.token]),
          on: {
            change: (event) => {
              const checked = (event.target as HTMLInputElement).checked;
              const next = { ...templateTokensInUse(state.settings.filenameTemplate), [token.token]: checked };
              const built = buildTemplate(next, TEMPLATE_SEPARATOR);
              callbacks.onChange({ filenameTemplate: built || '{id}' });
            },
          },
        }),
        h('span', { text: token.label }),
      ),
    );
  }
  element.appendChild(checks);

  if (canonical === null) {
    element.appendChild(
      hint('Custom template detected - it uses content the checkboxes cannot express. Edit it below; clearing the box returns to the checkboxes.', 'warn'),
    );
  }
  const custom = textInput('psFilenameTemplate', state.settings.filenameTemplate, '{id}_{md5}', (value) =>
    callbacks.onChange({ filenameTemplate: value }),
  );
  custom.classList.add('psMono');
  element.appendChild(custom);

  // Live preview against the sample post.
  const preview = previewNaming({ settings: state.settings });
  const previewBox = h('div', { class: 'psPreview' });
  previewBox.appendChild(h('strong', { text: 'Example' }));
  previewBox.appendChild(h('code', { text: `Downloads/${preview.fullPath}` }));
  if (preview.warnings.length) {
    previewBox.appendChild(h('small', { class: 'psHint warn', text: preview.warnings.join(' ') }));
  }
  element.appendChild(previewBox);

  return { element, refresh: () => undefined };
}

// ---------------------------------------------------------- small sub-flows

function renderHostAccess(state: SettingsSectionsState, callbacks: SettingsSectionsCallbacks): HTMLElement {
  const box = h('div', { class: 'psRow' });
  box.appendChild(h('label', { class: 'psRowLabel', text: 'Host access' }));
  if (!state.hostAccess) {
    box.appendChild(h('div', { class: 'psValue', text: 'Not checked yet - open the Servers tab to test a profile.' }));
    return box;
  }
  box.appendChild(
    h('div', { class: 'psValue' }, h('code', { text: state.hostAccess.origin }), state.hostAccess.granted ? ' granted' : ' not granted'),
  );
  if (!state.hostAccess.granted) {
    box.appendChild(button('Grant access', { variant: 'subtle', onClick: () => callbacks.onRequestHostAccess() }));
  }
  box.appendChild(hint('Media downloads go through the browser download manager; the extension only needs access to the booru API hosts.'));
  return box;
}

function confirmExport(callbacks: SettingsSectionsCallbacks): void {
  if (globalThis.confirm('Include API keys in clear text? Only do this on a machine you control.')) {
    callbacks.onExport(true);
  }
}

function confirmWipe(callbacks: SettingsSectionsCallbacks): void {
  if (globalThis.confirm('Delete the stored API keys and passwords from every server profile? The profiles stay, but you must paste the keys again.')) {
    callbacks.onClearAllCredentials();
  }
}

function importFlow(callbacks: SettingsSectionsCallbacks): void {
  const withSecrets = globalThis.confirm('Does the JSON you are importing contain API keys? OK = yes, Cancel = no.');
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (!file) return;
    void file.text().then((json) => callbacks.onImport(json, withSecrets));
  });
  input.addEventListener('error', () => toast('Could not read that file', 'error'));
  input.click();
}

/** Reused by the options page: same sections, same wording. */
export function describeSettingsSummary(settings: ExtensionSettings): string {
  const where = settings.uiMode === 'sidepanel' ? 'side panel' : 'popup';
  return `${settings.maxConcurrency} start worker(s) · ${settings.filenameTemplate} · opens in the ${where}`;
}
