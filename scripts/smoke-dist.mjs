/**
 * Smoke-tests the *built* extension bundle (dist/) outside a browser.
 *
 * It boots the real preview platform - which uses the exact service graph the
 * MV3 service worker uses - against the in-page mock booru APIs, then drives the
 * public message protocol. It finally boots the built **side panel bundle** on a
 * minimal DOM mock, so a runtime mistake in the panel (a typo, a missing element
 * id, a wrong import) fails here instead of in the browser.
 *
 * This catches packaging mistakes a unit test cannot: missing files, broken
 * imports, module-order/chrome-API assumptions.
 *
 * Usage: node scripts/build.mjs && node scripts/smoke-dist.mjs
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
/** The preview platform's `send`, shared with the panel checks in `main()`. */
let previewSend = null;
const checks = [];
let failures = 0;
const timers = [];

function check(name, condition, detail = '') {
  const ok = Boolean(condition);
  checks.push({ name, ok, detail });
  if (!ok) failures += 1;
  console.log(`${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  → ${detail}`}`);
}

// --------------------------------------------------------------- DOM stand-in

/**
 * Minimal element mock: enough for the shared DOM helpers (`h`, `button`,
 * `field`, `clear`), the panel controller and its views. Every element records
 * its children so the smoke test can inspect what was rendered.
 */
function createElement(tag = 'div') {
  const element = {
    tagName: String(tag).toUpperCase(),
    children: [],
    dataset: {},
    style: {},
    attributes: {},
    classList: {
      _set: new Set(),
      add(name) {
        this._set.add(name);
      },
      remove(name) {
        this._set.delete(name);
      },
      toggle(name, force) {
        const next = force ?? !this._set.has(name);
        if (next) this._set.add(name);
        else this._set.delete(name);
        return next;
      },
      contains(name) {
        return this._set.has(name);
      },
    },
    clicked: 0,
    listeners: {},
    click() {
      this.clicked += 1;
      this.fire('click');
    },
    fire(type, event = { type, preventDefault() {}, stopPropagation() {}, target: this }) {
      for (const handler of this.listeners[type] ?? []) handler(event);
    },
    remove() {},
    setAttribute(key, value) {
      this.attributes[key] = String(value);
      if (key === 'id') this.id = String(value);
      if (key === 'class') this.className = String(value);
      this[`attr_${key}`] = String(value);
    },
    getAttribute(key) {
      return this.attributes[key] ?? null;
    },
    removeAttribute(key) {
      delete this.attributes[key];
    },
    appendChild(child) {
      if (child !== null && child !== undefined) this.children.push(child);
      return child;
    },
    append(...nodes) {
      for (const node of nodes) this.appendChild(node);
    },
    insertBefore(child) {
      return this.appendChild(child);
    },
    replaceChildren(...nodes) {
      this.children = [];
      for (const node of nodes) this.appendChild(node);
    },
    removeChild(child) {
      const index = this.children.indexOf(child);
      if (index >= 0) this.children.splice(index, 1);
      return child;
    },
    addEventListener(type, handler) {
      (this.listeners[type] ??= []).push(handler);
    },
    removeEventListener(type, handler) {
      const list = this.listeners[type];
      if (list) this.listeners[type] = list.filter((entry) => entry !== handler);
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    scrollIntoView() {},
    focus() {},
    get firstChild() {
      return this.children[0] ?? null;
    },
    get firstElementChild() {
      return this.children[0] ?? null;
    },
    set textContent(value) {
      this._text = String(value);
      this.children = [];
    },
    get textContent() {
      if (this._text !== undefined) return this._text;
      return this.children.map((child) => (typeof child === 'string' ? child : child?.textContent ?? '')).join('');
    },
    /** Depth-first search for a descendant with a matching class name. */
    find(predicate) {
      for (const child of this.children) {
        if (typeof child === 'string' || !child?.find) continue;
        if (predicate(child)) return child;
        const nested = child.find(predicate);
        if (nested) return nested;
      }
      return null;
    },
  };
  return element;
}

/** Minimal browser globals the preview platform and the panel touch. */
function installBrowserStubs() {
  const store = new Map();
  const elements = [];
  const registry = new Map();

  globalThis.localStorage = {
    get length() {
      return store.size;
    },
    key: (index) => Array.from(store.keys())[index] ?? null,
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear(),
  };
  globalThis.location = { hash: '', search: '', origin: 'http://localhost:4173', href: 'http://localhost:4173/dist/panel/panel.html' };
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.confirm = () => false;
  globalThis.addEventListener = () => {};
  globalThis.removeEventListener = () => {};
  globalThis.open = () => null;
  globalThis.close = () => undefined;
  globalThis.URL.createObjectURL = () => 'blob:mock';
  globalThis.URL.revokeObjectURL = () => undefined;
  globalThis.Blob = class Blob {
    constructor(parts = []) {
      this.parts = parts;
    }
  };

  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = (handler, ms) => {
    const id = realSetInterval(handler, ms);
    timers.push(id);
    // Don't keep the node process alive for the panel's polling loop.
    id.unref?.();
    return id;
  };

  /** Every requested id gets one stable element, so `getElementById` caches. */
  const byId = (id) => {
    if (!registry.has(id)) {
      const element = createElement('div');
      element.id = id;
      registry.set(id, element);
    }
    return registry.get(id);
  };

  const documentElement = createElement('html');
  globalThis.document = {
    documentElement,
    body: createElement('body'),
    head: createElement('head'),
    createElement: (tag) => {
      const element = createElement(tag);
      elements.push(element);
      return element;
    },
    // `append()` turns plain child values into text nodes.
    createTextNode: (text) => ({ nodeType: 3, textContent: String(text), children: [] }),
    createElementNS: (_ns, tag) => createElement(tag),
    createDocumentFragment: () => createElement('fragment'),
    getElementById: (id) => byId(id),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener(type, handler) {
      (this.listeners[type] ??= []).push(handler);
    },
    removeEventListener(type, handler) {
      const list = this.listeners[type];
      if (list) this.listeners[type] = list.filter((entry) => entry !== handler);
    },
  };
  return { store, elements, registry };
}

async function main() {
  const manifest = JSON.parse(await readFile(path.join(root, 'dist/manifest.json'), 'utf8'));
  check('manifest is MV3', manifest.manifest_version === 3);
  check('manifest points at the built worker', manifest.background?.service_worker === 'background/service-worker.js');
  check('manifest declares the side panel', manifest.side_panel?.default_path === 'panel/panel.html', JSON.stringify(manifest.side_panel));
  check('manifest asks for the sidePanel permission', (manifest.permissions ?? []).includes('sidePanel'));
  check(
    'toolbar click is owned by the worker (no fixed popup)',
    manifest.action?.default_popup === undefined && manifest.action?.default_title.length > 0,
  );
  check('service worker file exists', await exists('dist/background/service-worker.js'));
  check('side panel files exist', (await exists('dist/panel/panel.html')) && (await exists('dist/panel/panel.js')) && (await exists('dist/panel/panel.css')));
  check('popup + options files exist', (await exists('dist/popup/popup.html')) && (await exists('dist/options/options.html')));
  check('icons exist', (await exists('dist/icons/icon16.png')) && (await exists('dist/icons/icon128.png')));

  const panelHtml = await readFile(path.join(root, 'dist/panel/panel.html'), 'utf8');
  check('panel page loads its own stylesheet and script', panelHtml.includes('panel.css') && panelHtml.includes('panel.js'));
  check('panel page carries the shared component styles', panelHtml.includes('../static/base.css'));
  for (const id of ['panel-tabs', 'engine-status', 'context-host', 'listing-host', 'browse-list-host', 'queue-host', 'links-host', 'servers-host', 'settings-host', 'dock-host']) {
    if (!panelHtml.includes(`id="${id}"`)) check(`panel page has #${id}`, false, 'missing element id');
  }
  check(
    'panel page declares every element the controller looks up',
    ['panel-tabs', 'engine-status', 'context-host', 'listing-host', 'browse-list-host', 'queue-host', 'links-host', 'servers-host', 'settings-host', 'dock-host'].every((id) =>
      panelHtml.includes(`id="${id}"`),
    ),
  );

  // ------------------------------------------------------------- message protocol
  const { store, elements, registry } = installBrowserStubs();

  const preview = await import(path.join(root, 'dist/preview/preview.js'));
  await preview.startPreview();

  const platform = await import(path.join(root, 'dist/platform/index.js'));
  const send = (request) => platform.getPlatform().send(request);
  previewSend = send;
  const expectOk = async (request) => {
    const response = await send(request);
    if (!response.ok) throw new Error(`expected ok for ${request.type}, got ${JSON.stringify(response.error)}`);
    return response.data;
  };
  check('preview platform installed', platform.getPlatform().environment === 'preview');

  const servers = await expectOk({ type: 'servers/list' });
  check('seeds demo servers', Array.isArray(servers) && servers.length >= 4, JSON.stringify(servers).slice(0, 120));
  check('exactly one default', servers.filter((server) => server.isDefault).length === 1);
  check(
    'server views are masked',
    servers.every((server) => !('apiKey' in server) && server.hasApiKey === server.apiKeyMask.length > 0) &&
      servers.some((server) => server.hasApiKey),
  );

  const validation = await expectOk({ type: 'servers/validate', payload: { id: servers[0].id } });
  check('validation succeeds with demo credentials', validation.ok === true, validation.message);
  check('validation reports the signed-in account', /demo_e621/.test(validation.message ?? ''), validation.message);
  check('validation trace is credential-free', !JSON.stringify(validation).includes('e621-demo-key'));

  const badAuth = await expectOk({ type: 'servers/validateDraft', payload: { server: { ...servers[0], apiKey: 'nope', id: undefined } } });
  check('wrong key is classified as auth-failure (not endpoint mismatch)', badAuth.kind === 'auth-failure', badAuth.kind);

  const search = await expectOk({ type: 'browse/search', payload: { serverId: servers[0].id, spec: { tags: 'cityscape', limit: 6 } } });
  check('search returns normalized posts', search.posts.length > 0 && search.posts.length <= 6, `got ${search.posts.length}`);
  check('every post carries a file url and a canonical rating', search.posts.every((post) => post.fileUrl.startsWith('http') && post.rating));
  check('rating filter is applied', search.posts.every((post) => post.rating === 'safe' || post.rating === 'unknown'), search.posts.map((post) => post.rating).join(','));

  const rateLimited = await send({ type: 'browse/search', payload: { serverId: servers[0].id, spec: { tags: 'force:429', limit: 5 } } });
  check('throttling is classified as rate-limited', rateLimited.ok === false && rateLimited.error.kind === 'rate-limited', JSON.stringify(rateLimited));

  const postId = search.posts[0].id;
  const post = await expectOk({ type: 'posts/get', payload: { serverId: servers[0].id, postId } });
  check('single post lookup matches the listing id', String(post.id) === String(postId));

  const download = await expectOk({ type: 'posts/download', payload: { serverId: servers[0].id, postId } });
  check('download path uses the naming templates', /^booru\/e621\//.test(download.filename), download.filename);
  check('preview downloader received the file', platform.getPlatform().downloader.log.length === 1);
  check('download anchor was rendered for the browser', elements.some((element) => element.clicked === 1));

  // --------------------------------------------------------------------- queue
  await expectOk({
    type: 'queue/enqueuePosts',
    payload: { serverId: servers[0].id, posts: search.posts.slice(0, 3).map((entry) => ({ id: entry.id })) },
  });
  const queued = await expectOk({ type: 'queue/list' });
  check('queue accepted the listing posts', queued.summary.pending === 3, JSON.stringify(queued.summary));
  await expectOk({ type: 'queue/run' });
  let listed = queued;
  // Each queued post costs one request, and the per-server limit is the
  // adapter's minimum, so poll with a generous budget.
  for (let attempt = 0; attempt < 400 && (listed.summary.pending > 0 || listed.summary.running > 0); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 15));
    listed = await expectOk({ type: 'queue/list' });
  }
  check('queue drained through the router', listed.summary.done === queued.summary.done + 3, JSON.stringify(listed.summary));
  check('direct and queued rows report simulated completion in preview', listed.items.every((item) => item.status === 'done' && item.completion === 'browser-complete'), JSON.stringify(listed.items.map((item) => item.status)));

  // ------------------------------------------------ panel-specific protocol bits
  const history = await expectOk({ type: 'history/list' });
  check('download history records the queue run', history.total >= 3, `total=${history.total}`);
  check('history entries carry the requested path', history.entries.every((entry) => entry.filename.includes('/')), JSON.stringify(history.entries[0] ?? {}));

  await expectOk({ type: 'searches/add', payload: { serverId: servers[0].id, query: 'cityscape solo' } });
  const searches = await expectOk({ type: 'searches/list', payload: { serverId: servers[0].id } });
  check('search history remembers the query', searches.entries[0]?.query === 'cityscape solo', JSON.stringify(searches.entries));

  const removedHistory = await expectOk({ type: 'history/clear' });
  check('download history can be reset', removedHistory.removed >= 3, JSON.stringify(removedHistory));
  check('search history can be cleared', (await expectOk({ type: 'searches/clear' })).removed === 1);

  await expectOk({
    type: 'queue/enqueuePosts',
    payload: { serverId: servers[0].id, posts: search.posts.slice(0, 2).map((entry) => ({ id: entry.id })) },
  });
  const beforeRemove = await expectOk({ type: 'queue/list' });
  const removedRows = await expectOk({ type: 'queue/remove', payload: { itemIds: [beforeRemove.items[0].id] } });
  check('individual rows can be removed', removedRows.removed === 1 && removedRows.summary.total === beforeRemove.items.length - 1, JSON.stringify(removedRows.summary));
  await expectOk({ type: 'queue/clear', payload: { scope: 'all' } });

  // ------------------------------------------------------------------ settings
  const settings = await expectOk({ type: 'settings/save', payload: { folderTemplate: 'smoke/{siteType}' } });
  check('settings persist', settings.folderTemplate === 'smoke/{siteType}');
  check('panel defaults are part of the stored settings', settings.uiMode === 'sidepanel' && settings.pageRangeLimit === 150 && settings.skipDownloaded === false);
  const panelPrefs = await expectOk({ type: 'settings/save', payload: { uiMode: 'popup', mediaFilter: 'video', tagBlacklist: '-guro vore' } });
  check('panel preferences round-trip', panelPrefs.uiMode === 'popup' && panelPrefs.mediaFilter === 'video' && panelPrefs.tagBlacklist === 'guro vore', JSON.stringify(panelPrefs));
  const afterReload = await expectOk({ type: 'settings/get' });
  check('settings survive a service-graph restart', afterReload.folderTemplate === 'smoke/{siteType}');
  check('settings are written to the shared preview namespace', store.has('bsm-preview:bsm.settings'));

  // ---------------------------------------------------------------- diagnostics
  const info = await expectOk({ type: 'diagnostics/info' });
  const siteTypes = new Set(info.adapters.map((entry) => entry.siteType));
  check(
    'diagnostics list every built-in adapter family',
    ['e621', 'danbooru', 'gelbooru', 'rule34', 'safebooru-org', 'yandere', 'konachan', 'derpibooru', 'hydrus', 'pawchive'].every((type) => siteTypes.has(type)),
  );
  check('diagnostics contain no secrets', !JSON.stringify(info).includes('e621-demo-key') && !JSON.stringify(info).includes('Authorization'));

  // --------------------------------------------------------------- route detect
  const route = await expectOk({ type: 'routes/detect', payload: { url: `https://gelbooru.com/index.php?page=post&s=view&id=${postId}` } });
  check('route detection works on a post URL', route?.siteType === 'gelbooru' && route.postId === String(postId));
  check('route detection resolves the saved server', route.server?.siteType === 'gelbooru');

  // ------------------------------------------------------------- panel bundle
  // Put the shared settings back to a listing-friendly state first: the panel
  // reads them on boot (and the checks above deliberately set odd values).
  await expectOk({ type: 'settings/save', payload: { mediaFilter: 'all', tagBlacklist: '', uiMode: 'sidepanel', skipDownloaded: true } });
  await bootPanel(registry, servers, postId);
  await bootOptions(registry);

  console.log(`\n${checks.length - failures}/${checks.length} checks passed`);
  if (failures > 0) process.exitCode = 1;
}

/**
 * Boot the built panel bundle on the DOM mock and assert that it rendered its
 * own shell. This is the check that would have caught a broken element id or a
 * typo in a render function without opening a browser.
 */
async function bootPanel(registry, servers, postId) {
  // The panel reads the "active tab" from the preview platform's query string.
  globalThis.location.search = `?tab=${encodeURIComponent(`https://e621.net/posts/${postId}`)}`;
  try {
    await import(path.join(root, 'dist/panel/panel.js'));
  } catch (error) {
    check('panel bundle loads', false, error instanceof Error ? error.message : String(error));
    return;
  }
  check('panel bundle loads', true);

  const rendered = await waitFor(() => registry.get('panel-tabs')?.children.length > 0, 3000);
  check('panel renders its tab strip', rendered, 'no tabs were drawn');
  const tabs = registry.get('panel-tabs');
  check('panel tab strip has all five sections', tabs?.children.length === 5, `got ${tabs?.children.length}`);
  check(
    'panel showing the first tab label',
    tabs?.children[0]?.textContent?.includes('Browse') || tabs?.children[0]?.children?.some((child) => String(child.textContent).includes('Browse')),
    JSON.stringify(tabs?.children[0]?.children?.map((child) => child.textContent)),
  );

  const status = await waitFor(() => {
    const text = registry.get('engine-status')?.textContent ?? '';
    return text.length > 0 && text !== 'Loading…';
  }, 3000);
  check('panel status pill leaves the loading state', status, registry.get('engine-status')?.textContent);

  const listing = await waitFor(() => (registry.get('listing-host')?.children.length ?? 0) > 0, 3000);
  check('panel renders the listing card', listing);
  check(
    'panel picked up the shared media filter',
    /Pics \+ videos/.test(collectText(registry.get('listing-host') ?? createElement())),
    collectText(registry.get('listing-host') ?? createElement()).slice(0, 200),
  );
  const cards = registry.get('listing-host')?.children ?? [];
  const serverRows = collectText(cards[0] ?? createElement());
  check('listing card lists the saved servers', serverRows.includes(servers[0].label), serverRows.slice(0, 160));

  const browseList = await waitFor(() => (registry.get('browse-list-host')?.children.length ?? 0) > 0, 3000);
  check('panel renders the row list under the fetch card', browseList);
  check('dock is rendered', (registry.get('dock-host')?.children.length ?? 0) > 0);

  const contextText = () => collectText(registry.get('context-host') ?? createElement());
  check('context card describes the active tab', contextText().length > 0, contextText().slice(0, 120));
  check(
    'context card resolves the active tab to a post route',
    new RegExp(`post[\\s\\S]{0,12}#?${postId}`).test(contextText()),
    contextText().slice(0, 160),
  );
  check('context card names the matching profile', /e621/.test(contextText()), contextText().slice(0, 160));

  const postCardReady = await waitFor(() => /Download this file/i.test(contextText()), 4000);
  check('post card resolves the post through the protocol', postCardReady, contextText().slice(0, 220));
  check(
    'post card offers the single-post actions',
    /Download this file/i.test(contextText()) && /Add to list/i.test(contextText()),
    contextText().slice(0, 200),
  );

  await walkTabs(registry);
}

/** Boot the built options bundle too: it shares the settings sections. */
async function bootOptions(registry) {
  globalThis.location.hash = '#settings';
  try {
    await import(path.join(root, 'dist/options/options.js'));
  } catch (error) {
    check('options bundle loads', false, error instanceof Error ? error.message : String(error));
    return;
  }
  check('options bundle loads', true);
  const rendered = await waitFor(() => (registry.get('view')?.children.length ?? 0) > 0, 4000);
  check('options page renders a view', rendered, 'the #view host stayed empty');
  const text = collectText(registry.get('view') ?? createElement());
  check('options page renders the shared settings sections', /Global behaviour/i.test(text) && /Name template/i.test(text), text.slice(0, 200));
  const rail = registry.get('nav');
  const railText = collectText(rail ?? createElement());
  check('options rail renders its sections', /servers/i.test(railText) && /queue/i.test(railText), railText.slice(0, 160));
  check('options rail offers the side panel', /side panel/i.test(railText), railText.slice(0, 160));
}

/** Click every panel tab and assert the matching pane rendered. */
async function walkTabs(registry) {
  const tabStrip = registry.get('panel-tabs');
  const tabs = tabStrip?.children ?? [];
  const panes = {
    Browse: 'pane-browse',
    Queue: 'pane-queue',
    Links: 'pane-links',
    Servers: 'pane-servers',
    Settings: 'pane-settings',
  };
  for (const button of tabs) {
    const label = collectText(button).trim().split(' ')[0];
    const paneId = panes[label];
    if (!paneId) continue;
    button.fire('click');
    const host = {
      'pane-browse': 'browse-list-host',
      'pane-queue': 'queue-host',
      'pane-links': 'links-host',
      'pane-servers': 'servers-host',
      'pane-settings': 'settings-host',
    }[paneId];
    const rendered = await waitFor(() => (registry.get(host)?.children.length ?? 0) > 0, 4000);
    check(`panel ${label} tab renders its pane`, rendered, `${host} stayed empty`);
    if (paneId === 'pane-settings') {
      const settings = collectText(registry.get('settings-host') ?? createElement());
      check('settings pane shows the section headings', /Global behaviour/i.test(settings) && /Name template/i.test(settings), settings.slice(0, 200));
      check('settings pane shows a hint per option', (registry.get('settings-host')?.find((node) => node.tagName === 'SMALL') ?? null) !== null);
    }
    if (paneId === 'pane-servers') {
      const servers = collectText(registry.get('servers-host') ?? createElement());
      check('servers pane lists the saved profiles', servers.includes('e621'), servers.slice(0, 160));
    }
    if (paneId === 'pane-links') {
      const links = collectText(registry.get('links-host') ?? createElement());
      check('links pane renders the mirror-link card', /mirror links/i.test(links), links.slice(0, 200));
      check(
        'links pane offers the package import and the text export',
        /import package/i.test(links) && /export \.txt/i.test(links),
        links.slice(0, 240),
      );
      check('links pane counts the collected links', /collected/i.test(links), links.slice(0, 200));
    }
  }
  // Leave the panel on Browse for the dock assertions, then drive a search.
  tabs[0]?.fire('click');
  await driveListing(registry);
  await driveLinks(registry);
  await drivePawchivePost(registry);
}

/** Exercise the actual post-card button, not only its router message. */
async function drivePawchivePost(registry) {
  globalThis.location.search = `?tab=${encodeURIComponent('https://pawchive.pw/fanbox/user/1245946/post/12674481')}`;
  const context = () => registry.get('context-host') ?? createElement();
  const refresh = context().find((node) => node.tagName === 'BUTTON' && node.getAttribute('title') === 'Re-read the active tab');
  if (!refresh) {
    check('Pawchive post card can be opened', false, 'active-tab refresh button not found');
    return;
  }
  refresh.fire('click');
  const ready = await waitFor(() => /Add all available files/i.test(collectText(context())), 10000);
  check('Pawchive post card can be opened', ready, collectText(context()).slice(0, 240));
  const addAll = context().find((node) => node.tagName === 'BUTTON' && /Add all available files/i.test(node.textContent ?? ''));
  if (!addAll) return;
  addAll.fire('click');
  const queued = await waitFor(() => /2 original file\(s\) added/i.test(collectText(registry.get('dock-host') ?? createElement())), 10000);
  check('Pawchive post card queues every available original', queued, collectText(registry.get('dock-host') ?? createElement()).slice(0, 240));
  const list = await previewSend?.({ type: 'queue/list' });
  const rows = list?.ok ? list.data.items.filter((item) => item.postId.startsWith('fanbox/1245946/12674481/')) : [];
  check('Pawchive all-files action does not start downloads', rows.length === 2 && rows.every((item) => item.status === 'pending'));
}

/**
 * Drive the Links tab through the built panel bundle: collect a few of the demo
 * creator's mirror links, stop the crawl, then read the list back out through
 * the protocol - the one flow a unit test cannot prove is wired in the bundle.
 */
async function driveLinks(registry) {
  const linksTab = (registry.get('panel-tabs')?.children ?? []).find((button) => /links/i.test(collectText(button)));
  if (!linksTab) {
    check('panel has a Links tab to drive', false, 'no tab labelled Links');
    return;
  }
  linksTab.fire('click');
  await waitFor(() => (registry.get('links-host')?.children.length ?? 0) > 0, 4000);

  const card = () => registry.get('links-host') ?? createElement();
  const text = () => collectText(card());
  const input = card().find((node) => node.tagName === 'INPUT' && node.id === 'psLinksQuery');
  if (!input) {
    check('links card offers a creator query box', false, 'no #psLinksQuery input');
    return;
  }
  input.value = 'fanbox/1245946';
  input.fire('input', { type: 'input', target: input });

  const collect = card().find((node) => node.tagName === 'BUTTON' && /Collect links/i.test(node.textContent ?? ''));
  if (!collect) {
    check('links card offers a Collect button', false, 'no button labelled Collect links');
    return;
  }
  collect.fire('click');

  // The crawl is rate limited (1.5 s per request for a creator archive), so one
  // listing + one scanned post is what this waits for: the task card appears with
  // the files it found, then Stop is pressed and what was found has to survive.
  const downloaded = () => {
    const match = /Download missing \((\d+)\)/i.exec(text());
    return match ? Number(match[1]) : 0;
  };
  const found = await waitFor(() => downloaded() > 0, 20000);
  check('links tab collects the demo creator into one task', found, text().slice(0, 260));
  check(
    'the task card names the creator and counts its files',
    /1245946 · fanbox/.test(text()) && /\d+\/\d+ file\(s\) completed/i.test(text()),
    text().slice(0, 260),
  );
  check('the task says how many files are still missing', downloaded() > 0, text().slice(0, 260));
  check(
    "links tab leaves the site's own storage alone",
    !/https:\/\/n\d\.pawchive\.pw/i.test(text()),
    text().slice(0, 260),
  );
  check(
    'the task card offers the package actions',
    /Rescan/i.test(text()) && /Export package/i.test(text()),
    text().slice(0, 260),
  );

  const stop = card().find((node) => node.tagName === 'BUTTON' && (node.textContent ?? '').trim() === 'Stop');
  stop?.fire('click');
  const stopped = await waitFor(
    () => (card().find((node) => node.tagName === 'BUTTON' && /Collect links/i.test(node.textContent ?? '')) ?? null) !== null,
    8000,
  );
  check('links tab stops a crawl on demand', stopped, text().slice(0, 240));

  const tasks = await previewSend?.({ type: 'tasks/list' });
  const first = tasks?.ok ? tasks.data.tasks[0] : null;
  check(
    'the collected task is in durable storage',
    !!first && first.task.memberIds.length > 0 && first.stats.total > 0,
    JSON.stringify(tasks?.ok ? tasks.data.tasks.map((entry) => entry.task.name) : tasks?.error),
  );

  // The package: both halves, exported and read back by a second "machine".
  const exported = await previewSend?.({ type: 'tasks/export', payload: { taskId: first?.task.id } });
  check(
    'the task exports a package (manifest + link list)',
    exported?.ok === true &&
      exported.data.files.length === 2 &&
      exported.data.files.some((file) => file.filename.endsWith('_task.json')) &&
      exported.data.files.some((file) => file.filename.endsWith('_download_links.txt')),
    JSON.stringify(exported?.ok ? exported.data.files.map((file) => file.filename) : exported?.error),
  );

  const manifest = exported?.ok ? exported.data.files.find((file) => file.filename.endsWith('_task.json')) : null;
  const imported = manifest ? await previewSend?.({ type: 'tasks/import', payload: { text: manifest.text, filename: manifest.filename } }) : null;
  check(
    'the package reads back as a task, idle and with its files',
    imported?.ok === true && imported.data.task.task.id === first?.task.id && imported.data.added === 0 && imported.data.updated > 0,
    JSON.stringify(imported?.ok ? { id: imported.data.task.task.id, added: imported.data.added, updated: imported.data.updated } : imported?.error),
  );

  const run = await previewSend?.({ type: 'tasks/run', payload: { taskId: first?.task.id, start: false } });
  check(
    'Download missing queues exactly the files not yet marked completed',
    run?.ok === true && run.data.queued === run.data.plan.total && run.data.plan.alreadyDone === 0,
    JSON.stringify(run?.ok ? run.data.plan : run?.error),
  );
  const paused = await previewSend?.({ type: 'tasks/pause', payload: { taskId: first?.task.id } });
  check('a task can be paused back to idle', paused?.ok === true && paused.data.task.stats.queued === 0, JSON.stringify(paused?.ok ? paused.data.task.stats : paused?.error));

  // Put the panel back on Browse, so the dock checks that follow still apply.
  tabs0(registry)?.fire('click');
}

/** The first tab button (Browse), used to leave the panel where the dock expects it. */
function tabs0(registry) {
  return registry.get('panel-tabs')?.children?.[0] ?? null;
}

/** Type a query into the fetch card and press *List this page*. */
async function driveListing(registry) {
  const listing = registry.get('listing-host');
  const input = listing?.find((node) => node.tagName === 'INPUT' && node.id === 'psTagInput');
  if (!input) {
    check('listing card has a tag input', false, 'no input found');
    return;
  }
  input.value = 'cityscape';
  input.fire('input', { type: 'input', target: input });
  const listButton = registry.get('listing-host')?.find((node) => /List this page/i.test(node.textContent ?? '') && node.tagName === 'BUTTON');
  if (!listButton) {
    check('listing card has a List this page button', false, 'no button found');
    return;
  }
  listButton.fire('click');
  const summary = () => collectText(registry.get('browse-list-host') ?? createElement());
  const listed = await waitFor(() => /[1-9]\d*\s*listed/i.test(summary()), 6000);
  check('panel lists the typed query through the protocol', listed, summary().slice(0, 200));
  check('listed rows carry a rating chip', /safe|questionable|explicit|general|sensitive/i.test(summary()), summary().slice(0, 200));
  check('listed rows offer the download action', /Download selected/i.test(collectText(registry.get('dock-host') ?? createElement())));
  // Listing must not download: the rows are queued, no downloads have started yet.
  const summaryNow = () => collectText(registry.get('browse-list-host') ?? createElement());
  check(
    'listing queues the rows without downloading them',
    /[1-9]\d*listed/.test(summaryNow()) && /0completed/.test(summaryNow().replace(/\s+/g, '')),
    summaryNow().slice(0, 160),
  );
}

/** Wait until `predicate()` is true (the panel boots asynchronously). */
async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (predicate()) return true;
    } catch {
      /* keep polling */
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

/** Flatten the text of an element tree (mock elements have no innerText). */
function collectText(element) {
  if (!element) return '';
  const own = typeof element.textContent === 'string' ? element.textContent : '';
  const nested = (element.children ?? []).map((child) => (typeof child === 'string' ? child : collectText(child)));
  return [own, ...nested].join(' ');
}

async function exists(relative) {
  try {
    await readFile(path.join(root, relative));
    return true;
  } catch {
    return false;
  }
}

try {
  await main();
} finally {
  timers.forEach((id) => clearInterval(id));
  // The panel's polling loop would otherwise keep the process alive.
  setTimeout(() => process.exit(failures > 0 ? 1 : 0), 5).unref?.();
}
