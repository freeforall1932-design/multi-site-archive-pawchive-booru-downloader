# Booru Server Manager

One Manifest V3 browser extension that manages **many saved booru server/account
profiles** (e621, Danbooru, Gelbooru forks, Moebooru, Philomena, Hydrus and Pawchive) and downloads from all
of them through a single docked **side panel**.

The panel is built the way the good side-panel downloaders are built: one dock next
to the page, one list that *is* the queue, one settings screen with a heading and a
plain-language hint per option. It stays a booru tool - multi-server profiles,
rating allow-lists, tag search, per-site credentials - and it is an extension, not
an app.

Everything runs inside the browser extension: there is **no remote backend** or
analytics. It contacts configured booru, Hydrus and Pawchive servers and, when
you request a mirror download, the external file host.

```
┌───────────────────────────────────────────────────────────────────┐
│  BOORU SERVER MANAGER                          3 downloading      │
│  Download panel                                                   │
│  Browse │ Queue ③ │ Links │ Servers │ Settings                     │
│  ● e621 post #1500000 — default profile                    ⟳      │
│  [thumb] #1500000 safe [video]                                    │
│          [Download this file] [Add to list]                       │
│  [ e621 (demo account) ▾ ]                                        │
│  [ tags, e.g. cat solo rating:safe ]                              │
│  [ List this page ] [ Download page ]                             │
│  From [1] To [last]   advanced    ☐ Skip completed                  │
│  ▓▓▓▓▓▓░░░░  Listed page 3 · 120 post(s) so far                   │
│  ☑ #1500000 [pic] completed  completed   ✕                          │
│  ☑ #1500001 [video]      downloading ✕                            │
│  Start workers [1][2][3][5]          Original files only         │
│  [ Download selected (2) ]                             [ Pause ]  │
└───────────────────────────────────────────────────────────────────┘
```

The design and every setting are documented in
[docs/SIDEPANEL.md](docs/SIDEPANEL.md).

## Features

**Side panel (the toolbar surface)**

- **Browse** — reads the active tab, names the saved profile it belongs to, and
  offers *Download this file* / *Add to list* on post pages. Tag search with
  remembered suggestions, a `From … To` page range plus an advanced box
  (`2,4,6-10`, `1-99`, `50-`, `all`), a picture/video filter, "skip downloaded",
  a review-then-download flow and a page-limit cap on one crawl.
- **Queue** — the row list with live status, per-row cancel/remove, retry failed,
  clear finished, reset history, clear list, and a fixed dock with a concurrency
  segmented control, an original-only indicator and *Download selected*.
- **Links** — the mirror-link collector, organised as **download tasks**: walks a
  creator's posts through the Pawchive API and
  keeps matching off-site download links it finds (Drive, Mega, MediaFire, …) in
  one task per creator, subject to page limits, failures and filter settings. A task shows how many transfers Chrome completed, which failed,
  when it last ran, and offers *Download missing* (new files **and** retries),
  *Rescan* (new uploads), *Pause* and *Export package*. The package — a `.json`
  manifest plus the grouped `.txt` list — can be sent to someone else, who opens
  it with the same extension and gets the same task, idle, ready to run.
- **Servers** — the full multi-account manager plus diagnostics in one scroll.
- **Settings** — sectioned settings (global behaviour, download behaviour, list
  results, search behaviour, name template, interface, advanced behaviour,
  credentials, history) with a live file-name preview.
- Deep links (`#browse`, `#queue`, `#links`, `#servers`, `#settings`) and a `uiMode` switch
  that puts the classic popup back on the toolbar if you prefer it.

**Server manager (first-class screen)**

- Add / edit / delete / duplicate server profiles, set exactly one default.
- Per-server credentials with per-site field sets (e621: username + API key +
  descriptive User-Agent; Danbooru: username + API key; Gelbooru: API key +
  numeric user id, optional username for display).
- Validate a draft *before* saving or a stored profile at any time. Validation
  distinguishes, with separate messages:
  `auth-failure` · `endpoint-mismatch` · `rate-limited` · `network-failure` ·
  `blocked` · `server-error` · `unsupported-site` · `incomplete-config` ·
  `parse-failure`.
- The **last validation result and timestamp are persisted** per profile, and the
  server list shows site type, base URL, rating-filter state, login state and the
  default marker at a glance.
- Export / import the whole server list as JSON (secrets excluded unless you
  explicitly opt in).

**Downloading**

- Post-page download button (content script, shadow DOM, can be switched off).
- Popup: acts on the current tab — detects the site/post route, shows the matching
  server, and downloads or queues the post.
- Tag/search browsing per server with rating-filter awareness, a shared tag
  blacklist and a global "always append these tags" suffix.
- Batch queue with per-server rate limiting, pause/resume, retry, cancel, clear,
  live progress and persisted state (survives a service-worker restart).
- Configurable download folder and filename templates with a documented token
  set, a checkbox token editor with live preview, path sanitisation, traversal
  protection and length caps.
- **Download history** — records original-file transfers after Chrome reports
  completion, including direct post downloads. Skip-by-history defaults off;
  old start-only and unknown-quality records remain but never hide originals.
  Chrome completion is not a hash check and does not establish that the file
  still exists or contains the expected media.
- **Mirror links** — a second kind of queue row for off-site URLs. Direct file
  URLs can be sent to the browser without a server profile; known Mega, Drive
  and similar share pages are kept for opening/export and explicitly rejected
  as downloads. Unknown landing pages can still return HTML. Provider resolution,
  decryption and login are not implemented.
- **Download tasks** keep each link's post and provider, record queue outcomes,
  and merge repeat collections or imports. They distinguish browser-completed,
  interrupted, queued and unverified transfers; they do not verify file content.

**Engineering**

- The original file is the only downloadable rendition. Preview/sample URLs are
  for display; when an original is unavailable the download is refused.
- A shared adapter contract supplies the site-specific API mappings.
- Automated tests (adapters, shared services, message router, HTTP layer, the
  mirror-link rules, the task/package round-trip and export/import, the panel's
  page/query/template/history logic) and a strict TypeScript build.
- An offline **browser preview harness** (`npm run preview`) that runs the real
  UI - side panel included - against mock booru APIs, including a demo creator
  whose posts carry mirror links, so the whole Links flow can be tried without
  installing the extension or making automatic requests to live sites.
- The original **userscript** this feature grew out of is kept in
  [`userscripts/`](userscripts/) for people who want the standalone version.

## Supported sites

Every site uses a shared adapter contract; Pawchive also has specific post and
link-collection actions. The families below ship built in. Any other instance of a family
(a self-hosted Danbooru, a Gelbooru fork not listed, another Philomena site) is
added by picking the family in the server form and typing its base URL — the
extension asks for host access to it once.

### Original three

| `siteType` | Site | Auth style | Rating filter | API notes |
| --- | --- | --- | --- | --- |
| `e621` | e621.net, e926.net | HTTP Basic (`username:api_key`) or `login`/`api_key` query params | `-rating:s/q/e` | Descriptive User-Agent required by policy; `_client` query fallback for extensions; 320 posts/request; hard 2 req/s |
| `danbooru` | danbooru.donmai.us, `*.donmai.us` | HTTP Basic or `login`/`api_key` query params | `-rating:general/sensitive/questionable/explicit` | `/profile.json` returns the account; prefer `id:` batching; 200 posts/request; 10 req/s global |
| `gelbooru` | gelbooru.com, `www.gelbooru.com`, `*.gelbooru.com` | `api_key` + `user_id` query params | `rating:`/`-rating:` tokens | DAPI (`page=dapi&s=post&q=index&json=1`); `{"@attributes":…,"post":[…]}` envelope; 100 posts/request |

### Gelbooru 0.1.11 forks (same DAPI, bare-array JSON, `hash` instead of `md5`)

| `siteType` | Site | Auth | Notes |
| --- | --- | --- | --- |
| `rule34` | rule34.xxx (API on api.rule34.xxx) | `api_key` + `user_id` **required** | Anonymous reads answer `"Missing authentication"` since 2024 |
| `safebooru-org` | safebooru.org | optional | Not the same site as safebooru.donmai.us |
| `xbooru` | xbooru.com | optional | |
| `tbib` | tbib.org | optional | Aggregates several boorus |
| `hypnohub` | hypnohub.net | optional | |
| `realbooru` | realbooru.com | optional | |

### Moebooru (Danbooru 1.x lineage)

| `siteType` | Site | Auth | Notes |
| --- | --- | --- | --- |
| `yandere` | yande.re | optional `login` + `password_hash` | `/post.json` bare array; ratings `s/q/e`; `sample_url` and `jpeg_url` variants |
| `konachan` | konachan.com, konachan.net (SFW mirror) | optional `login` + `password_hash` | Same API |

The "API key" field holds Moebooru's `password_hash` =
`SHA1("choujin-steiner--" + password + "--")`; never paste the plain password.

### Philomena (Derpibooru engine)

| `siteType` | Site | Auth | Notes |
| --- | --- | --- | --- |
| `derpibooru` | derpibooru.org, trixiebooru.org | optional `key` | Everything filter `56027` pinned; override via the *Filter ID* field |
| `furbooru` | furbooru.org | optional `key` | |
| `ponybooru` | ponybooru.org | optional `key` | |

Philomena search syntax is the site's own: **comma-separated** terms, tags may
contain spaces, `-term` excludes. Ratings are tags (`safe`, `suggestive`,
`questionable`, `explicit`, `semi-grimdark`, `grimdark`, `grotesque`) and the
rating filter is spelled `-explicit` etc.

### Local client

| `siteType` | Site | Auth | Notes |
| --- | --- | --- | --- |
| `hydrus` | your Hydrus client, `http://127.0.0.1:45869` | Client API access key (**required**, needs *search for and fetch files*) | Comma-separated Hydrus tags; no ratings. New URLs omit the key; authenticated originals use a Chrome Downloads header whose redirect/storage behavior is unverified. Use a trusted direct endpoint and restricted key. See [security notes](docs/SECURITY.md). |

### Pawchive (creator archive, not a tag booru)

| `siteType` | Site | Auth | Notes |
| --- | --- | --- | --- |
| `pawchive` | `https://pawchive.pw` or `https://pawchive.st` | none | Type `service/creatorId`, paste a Pawchive creator URL, use `tag:name`, or search titles. Attachments become rows with stable `service/creator/post/index` ids; ratings are not supported. |

Pawchive is the **only supported creator archive**. The booru and Hydrus adapters
above remain available. Legacy Kemono and Coomer profiles are kept for export or
deletion but cannot be selected, used, or made the default; existing tasks, queue
rows, history and imported links are not silently erased or converted. Old task
packages keep their original site identity and cannot rescan a different creator
on Pawchive. Direct off-site links can still be exported or downloaded explicitly.

Following the Pawchive handling in the author's
[KemonoDownloader fork](https://github.com/freeforall1932-design/KemonoDownloader),
the adapter recognizes classic `file.<domain>/data/...` originals and trusted,
unexpired signed original URLs. Signed URLs are refreshed from the post before
starting a download. Preview-only and deferred files remain visible but cannot be
downloaded as originals. A node number is not proof of a working file host.
No login or paywall bypass is provided.

#### What happens when you download a Pawchive post?

1. Add a Pawchive profile, open a Pawchive post, and open the side panel. On its
   post card, **Add all available files** reads the post and adds each available
   original attachment to the queue, reporting unavailable and duplicate/filtered
   entries. It does not start a download; select the rows and press **Download
   selected**. This can include pictures, videos, archives or other attachments.
2. **Download this file** / **Add to list**, the popup, and the floating on-page
   button operate on **one** attachment (normally the first); on-page the button
   says **Download first file**. Creator listings expand available attachment
   slots into separate rows. Preview-only/deferred slots cannot be downloaded.
3. This saves the API's attached files, **not a complete archive of the post**:
   it does not save the post HTML/text/metadata or automatically collect images
   embedded only in the body. The **Links** tab separately collects off-site URLs,
   including from text-only posts; it does not recursively download their contents.

Booru and Hydrus downloads also request the site's original-file field, never a
sample/resized URL on purpose. When no original is exposed, the extension fails
rather than substituting a preview. Display thumbnails are unaffected. This is
based on API metadata: downloaded bytes are not checksum-verified, and a site or
server can still return an error page, the wrong file or a misleading original.

**Existing data:** old Pawchive queue rows use ambiguous attachment indices and
are blocked; remove them and add the post/files again. New rows retain a supplied
file hash to catch changed attachment order, but this is not byte verification.
The old `sample` setting is migrated to `original`; old history without both
original quality and browser-confirmed completion is not used to hide originals.
Existing skip-by-history preferences are preserved.

**Transfer limits and status:** metadata requests share at least a 1.5-second
interval across Pawchive profiles; file-download *starts* are at least one second
apart while the worker and its in-memory limiter remain active. Pacing state is
not persisted across worker restarts. This does not cap active Chrome transfers. The queue persists Chrome's
download ID and follows `complete`/`interrupted` events, including after a worker
restart; byte progress is read from Chrome while the panel is open. Direct post,
queued post, and direct mirror downloads all use this tracking. Cancel requests
are sent to Chrome, and active rows cannot be cleared while they are tracked.
Old start-only records, missing Chrome records, and the narrow crash window before
the ID is persisted are **unverified**, not assumed complete or auto-restarted;
check Chrome Downloads before retrying to avoid duplicates. Chrome completion is
not byte/hash verification and an HTML error page can still be saved as a file.
Booru tag blacklist/suffix settings do not filter Pawchive creator/title queries.

**Off-site links:** the Links tab preserves Mega keys in URL fragments and supports
text/task import and export. Known Mega, Google Drive and other share pages need
the provider's site or download manager and are not passed off as direct files.
If an older Mega URL was saved without its key, recollect the original post or
re-import the complete URL; legacy `/#...` links stripped to a bare host cannot
be recovered without the original link. Exported links may contain private keys;
share packages only with people you trust. Unknown provider interstitials may
still be downloaded as HTML. These features are an adaptation, **not full parity**
with the Python fork, and the current changes have not been live-tested against
Pawchive.

**Deliberately not included** (checked against the Droidbooru reference client in
`reference/`): IBSearch (site is gone), Shimmie 2 and ZeroChan (HTML scraping
only — breaks on every theme change), RSS (not a booru).

**Furry34 is not supported:** its separate API and rendition formats have been
investigated, but original-file semantics and live extension downloads remain
unverified. See [docs/FURRY34_INVESTIGATION.md](docs/FURRY34_INVESTIGATION.md).

Additional booru-like sites can be added through the adapter contract — see
[docs/ADAPTER_CONTRACT.md](docs/ADAPTER_CONTRACT.md).

## Install (unpacked, for development)

```bash
node --version          # Node 20.x, 22.x or 24+ (not Node 21/23)
npm ci                   # install locked development dependencies
npm run build           # type-checks, compiles src/ → dist/, generates icons
```

Then in Chrome/Edge/Brave (116+ for the side panel):

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select the generated `dist/` folder.
3. Click the toolbar icon → the **side panel** opens (Settings → *Toolbar click
   opens* switches back to the classic popup). The full manager is also in the
   options page: right-click the icon → *Options*, or the panel's Servers tab.

`npm run verify` runs type checks, a full build, the test suite and the built-bundle
smoke test in one go.

## Quick start

1. **Add a server** — panel → *Servers → Add server* (or *Options → Servers*).
2. Pick a **site type**, check the pre-filled base URL, paste your credentials.
3. Press **Validate now**. A green *“Endpoint and credentials OK — signed in as …”*
   means you are done; a red chip tells you exactly which layer failed and what to
   fix (see [Manual tests](docs/MANUAL_TESTS.md) for the full failure matrix).
4. **Save**. The first saved profile becomes the default automatically; later use
   *Set default* on any other row.
5. **Browse** in the panel: type tags, press *List this page* or *Fetch selected
   pages*, untick what you do not want, then *Download selected* on the dock. The
   popup can start or queue one file; the on-page button starts one directly.

### Getting credentials

| Site | Where |
| --- | --- |
| e621 | Account → *Manage API Access* (key). Put your e621 username in the username field: e621 policy requires a descriptive User-Agent that identifies you, e.g. `BooruServerManager/0.2.0 (by your_name on e621)`. |
| Danbooru | Profile → *API Key*. Danbooru asks for a unique descriptive User-Agent too; the extension generates one containing your account id when credentials are present. |
| Gelbooru | Account → *Options → API Access Credentials*: copy **API key** and **user id** (both are required together). |
| rule34.xxx and other Gelbooru forks | *My Account → Options → API Access Credentials*; rule34.xxx **requires** both fields even for reading. |
| yande.re / Konachan | No API key exists; optional auth is your login plus `SHA1("choujin-steiner--" + password + "--")` in the API-key field. |
| Derpibooru / Philomena | *Account → API Key* (optional). *Filter ID* is the numeric id from the site's Filters page. |
| Hydrus | In the client: *services → manage services → client api → add* a key with *search for and fetch files*; base URL is shown under *services → review services*. |
| Pawchive | Nothing — no login. |

Server credentials are stored unencrypted by the extension in `chrome.storage.local`
and masked in profile views. New **Hydrus** URLs omit its key, but Chrome Downloads'
handling of the required authentication header on redirects and in browser storage
is unverified. Use a restricted key and trusted non-redirecting endpoint. Rotate
keys exposed by older versions and manually remove old browser records; migration
cannot clean external history or exports. Share links can also contain private keys.
See [docs/SECURITY.md](docs/SECURITY.md) before using credentials or sharing links.

## What the UI looks like

| Surface | Route / entry | Purpose |
| --- | --- | --- |
| **Side panel** | toolbar icon (or options → *Open side panel*) | Browse · Queue · Links · Servers · Settings — the primary surface, with a fixed download dock |
| Server list | `options.html#servers` | Add/edit/duplicate/delete, set default, validate, clear credentials, export/import |
| Server editor | `options.html#editor` | One form for every site type; fields come from the adapter's `credentialFields()` |
| Browse | `options.html#browse` | Tag search, rating-filter toggle, post grid, single or bulk download |
| Queue | `options.html#queue` | Running/pending/failed items, retry, cancel, clear, pause/resume |
| Settings | `options.html#settings` | Templates, concurrency, request interval, rating enforcement, User-Agent behaviour, theme |
| Diagnostics | `options.html#diagnostics` | Adapter catalog, environment, redacted validation traces and copy-to-clipboard report; inspect before sharing |
| Popup | toolbar icon | Current tab detection, quick search, one-click download, queue footer |
| Content script | any supported post page | Floating download button linked to the matching server |

## Download naming

Default folder template `booru/{siteType}`, default filename template `{id}_{md5}`
(the file extension is always appended from the post metadata).

Available tokens:
`{id}` `{siteType}` `{server}` `{serverLabel}` `{rating}` `{score}` `{md5}` `{ext}`
`{filename}` `{date}` `{year}` `{month}` `{artist}` `{artists}` `{character}`
`{copyright}` `{tags}` `{tagCount}` `{width}` `{height}` `{source}` `{isVideo}`
`{tag1}` … `{tag9}`

Templates are sanitised token-by-token: illegal characters are replaced, path
traversal and reserved Windows names are neutralised, each path segment is capped
at 120 characters and the filename at 180 characters total. When a value had to be
changed, the download result carries a warning explaining it.

## Rating filters

Each profile has a rating filter toggle plus an allow-list of canonical ratings
(`safe`, `general`, `sensitive`, `questionable`, `explicit`). The shared layer
decides *whether* filtering happens; the adapter decides *how* it is spelled for
its site (most sites take the portable exclusion form `-rating:explicit`; Philomena
uses `-explicit`; Hydrus and Pawchive have no ratings and report the filter as unsupported). Filters apply to browsing, to queueing and — when
*Settings → Enforce rating filter on download* is on — to single-post downloads.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run build` | Removes `dist/`, compiles `src/` with `tsc`, copies HTML/CSS/manifest, renders the 4 PNG icons, writes `dist/build-info.json` |
| `npm run typecheck` | Strict type check of `src/` and of `src/` + `tests/` |
| `npm test` | Vitest suite (offline fixtures) |
| `npm run smoke` | Drives the **built** `dist/` bundle end-to-end against the mock booru (checks: manifest, service worker wiring, side-panel page, masking, validation kinds, browse, download naming, queue draining, history notebooks, selective runs, settings, diagnostics) and then boots the built **panel bundle** and the **options bundle** on a DOM mock, drives a real query and a real mirror-link collection through the panel, and walks all five panel tabs |
| `npm run test:watch` | Vitest in watch mode |
| `npm run verify` | `typecheck` → `build` → `test` → `smoke` |
| `npm run preview` | Builds, then serves the **offline preview harness** on <http://localhost:4173> |
| `npm run icons` | Re-renders the PNG icons into `dist/icons` |

### Browser preview harness

`npm run preview` serves `dist/` plus `dev/preview/index.html` on port 4173. The
harness embeds the real **side panel** (at a realistic 380 px), the options page
and the popup, backed by an in-page mock of all three booru APIs (`force:401`,
`force:429`, `force:503`, `force:html` directives let you reproduce failures), a
mock media server, and the same service graph used by the extension. Buttons at the
top switch the panel's simulated active tab, including a multi-file Pawchive post
for the **Add all available files** action. Demo credentials and the reset button are documented on the
page itself. API responses, thumbnails and downloads use local mocks; clicking an
external post or mirror link deliberately opens that external site.

## Project layout

```
src/
  shared/      domain types, error taxonomy, HTTP client + rate limiter, helpers
  core/        adapter contract + registry, storage, settings, servers, validation,
               client, queue, naming, downloads, history notebooks, page ranges,
               search composition, template editor, User-Agent rules, router,
               mirror-link rules + export/import, mirror-link store, download
               tasks (planning, stats, manifests) + task store
  adapters/    e621, danbooru, gelbooru forks, moebooru, philomena, hydrus, pawchive
  platform/    Chrome MV3 platform, preview platform, lazy façade
  ui/          DOM helpers and view builders (server list, form, browse, queue,
               links collector, settings sections, diagnostics, panel
               cards/lists/dock, toasts)
  panel/       side panel shell: layout, tab routing, controller, dock  ← primary
  options/     options page shell and routing (#servers/#editor/#browse/…)
  popup/       toolbar popup (current tab + quick search + queue footer)
  content/     post-page download button (shadow DOM)
  background/  MV3 service worker: message router host, toolbar mode, UA rules
  preview/     offline mock booru + preview bootstrap (development only)
tests/
  adapters/    per-site adapter tests + cross-adapter conformance tests
  core/        servers, naming, validation, queue, HTTP/rate-limit, router tests
scripts/       build, icon generator, preview server
dev/preview/   preview harness page
userscripts/   the standalone Pawchive Link Collector userscript + its README
```

## Documentation

| Document | Contents |
| --- | --- |
| [docs/SIDEPANEL.md](docs/SIDEPANEL.md) | The side panel: layout, tabs, row/queue model, complete settings reference, history notebooks, preview harness |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Layers, data flow, storage schema, message protocol, queue lifecycle |
| [docs/ADAPTER_CONTRACT.md](docs/ADAPTER_CONTRACT.md) | The full adapter contract + how to add a new booru in ~200 lines |
| [docs/SECURITY.md](docs/SECURITY.md) | Credential storage, network exposure, redaction limits and outstanding browser checks |
| [docs/MANUAL_TESTS.md](docs/MANUAL_TESTS.md) | Step-by-step manual test plan with expected results |
| [docs/TASKS.md](docs/TASKS.md) | Download tasks explained: the "send it to a friend" model, every design option that was considered, and what is parked |
| [docs/WORKLIST.md](docs/WORKLIST.md) | Implemented scope, known gaps and next steps |
| [userscripts/README.md](userscripts/README.md) | The standalone Pawchive Link Collector userscript (install, usage, Greasy Fork link) |

## Status

Version 0.2.0 — e621, Danbooru and Gelbooru plus the Gelbooru-fork, Moebooru,
Philomena, Hydrus and Pawchive are implemented against their APIs, the side
panel is the primary surface, the Links tab collects off-site mirror links for
Pawchive as portable link tasks (with direct-download and content-verification limitations
described above), and an adapter conformance suite
guards any new site. See [docs/WORKLIST.md](docs/WORKLIST.md) for what is done and
what is deliberately left for later (e.g. per-site uploads, tag autocomplete,
archive/PDF picture packing).

## Licence / site terms

Personal, non-commercial use. Respect each site's Terms of Service and API rules:
the extension applies per-profile API spacing (1 request/second by default) and
Pawchive-specific pacing while its worker is running, and can identify itself
with a descriptive User-Agent. These are not global limits across browser restarts,
other profiles or other applications. It does not bypass authentication or paywalls.
