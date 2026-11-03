# Architecture

A Manifest V3 extension with strictly layered code. The rule that shapes
everything else: site-specific API mappings live inside adapters, while shared
services enforce cross-site safety policy and expose explicit Pawchive attachment
actions. Every surface talks to those services through one message protocol.

```
┌──────────────────────────── UI surfaces ────────────────────────────┐
│ side panel: Browse · Queue · Servers · Settings  (toolbar target)    │
│ options page (#servers #editor #browse #queue #settings #diagnostics)│
│ toolbar popup          ·  content script button (post pages)         │
└───────────────────────────────┬─────────────────────────────────────┘
                                │ UiRequest / RouterResponse  (message protocol)
┌───────────────────────────────▼─────────────────────────────────────┐
│                        core/router.ts                               │
│  one closure: translate UI intent → services; shape replies          │
└──┬──────────┬───────────┬───────────┬───────────┬───────────┬───────┘
   │          │           │           │           │           │
┌──▼───┐ ┌────▼────┐ ┌────▼────┐ ┌────▼────┐ ┌────▼─────┐ ┌───▼──────┐
│server│ │settings │ │ client  │ │  queue  │ │validation│ │ naming / │
│store │ │ store   │ │(resolve │ │(download│ │ service  │ │downloads │
│      │ │         │ │ posts)  │ │ + rate) │ │          │ │          │
└──┬───┘ └────┬────┘ └────┬────┘ └────┬────┘ └────┬─────┘ └───┬──────┘
   │          │           │           │           │           │
┌──▼──────────▼───────────▼───────────▼───────────▼───────────▼───────┐
│ history: download notebook (skip downloaded) · search notebook       │
│ pages: page-range parser  ·  template: naming-token editor           │
└──────────────────────────────────────────────────────────────────────┘
   │          │           │           │           │           │
┌──▼──────────▼───────────▼───────────▼───────────▼───────────▼───────┐
│  shared: http client (rate limiter, retries, redaction), errors,     │
│          domain types, storage abstraction, registry                 │
└───────────────────────────────┬─────────────────────────────────────┘
                                │ BooruAdapter contract
┌───────────────────────────────▼─────────────────────────────────────┐
│ adapters: booru families · Hydrus · Pawchive                         │
└─────────────────────────────────────────────────────────────────────┘
```

## Layers

### 1. `src/shared/` — no knowledge of any concrete site

| File | Responsibility |
| --- | --- |
| `types.ts` | Domain model: `ServerConfig`, `ServerConfigView`, `BooruPost`, `SearchSpec/Result`, `Rating`, `QueueItem`, `ExtensionSettings`, `FailureKind`, `ValidationResult`, `ProbeTraceEntry` |
| `errors.ts` | `BooruError` (kind + status + hint + retryable) and `FAILURE_LABELS` |
| `http.ts` | `HttpClient` (timeouts, retry with backoff, per-key `RateLimiter`), `HttpRequestSpec`, `HttpResponseSnapshot`, `parseJsonBody`, `describeRequest` |
| `util.ts` | ids, deep clone/deep merge, `sleep`, `redactUrl`, `redactHeaders`, host/path helpers, amount formatting |

`HttpClient` handles API network I/O; Chrome downloads and UI thumbnails also
contact remote hosts. Each HTTP snapshot carries a `redactedUrl`, and its event
stream is redacted before it is emitted. The internal snapshot's raw `url`,
headers and response body can contain secrets and must not be logged or displayed
without sanitization.

### 2. `src/core/` — shared services

| File | Responsibility |
| --- | --- |
| `adapter.ts` | The `BooruAdapter` contract and shared adapter helpers (`suggestUserAgent`) |
| `registry.ts` | Site-type → adapter registry, `detectRoute`, `detectAdapterForUrl`, `effectiveUserAgent`, `buildDefaultRatings`, `createAdapterContext` |
| `registry` + `adapters/index.ts` | `registerBuiltinAdapters()` is the single registration point |
| `storage.ts` | `StorageArea` interface + Chrome/Memory/Web implementations + `STORAGE_KEYS`, schema version, `migrateStorage` |
| `servers.ts` | `ServerStore`: CRUD, default handling, duplicate (secrets copied, validation reset), credential clearing, masking (`toServerView`), JSON export/import, validation bookkeeping |
| `settings.ts` | `SettingsStore`: defaults, partial saves, reset, migration-safe merge (including the side-panel keys: `uiMode`, `panelDefaultTab`, `mediaFilter`, `skipDownloaded`, `pageRangeLimit`, `queueRowLimit`, `showThumbnails`, `autoStartQueue`, `duplicateBehaviour`, `filePreference`, `tagBlacklist`, `searchHistory*`, `mirrorLinksFilter`, `mirrorExtraHosts`, `mirrorFolderTemplate`) |
| `history.ts` | `DownloadHistoryStore` + `SearchHistoryStore`: the panel's two notebooks (`bsm.history`, `bsm.searches`) |
| `search.ts` | `composeSearchTags`: tag blacklist + global suffix for booru queries (not Pawchive creator/title queries) |
| `pages.ts` | `parsePageRange` / `fromToRange` / `batchRange`: the listing card's page grammar (`2,4,6-10`, `50-`, `all`) with the configured cap |
| `template.ts` | Filename-template token catalog, canonical-template detection, preview rendering |
| `validation.ts` | `ValidationService`: runs an adapter's ordered probes, classifies results, produces a `ValidationResult` with a redacted trace |
| `client.ts` | `BooruClient`: server/adapter resolution, search, post lookup, URL → post resolution, rating-filter decisions |
| `queue.ts` | `DownloadQueue`: persistence, de-duplication, concurrency, pause/resume/retry/cancel/clear, per-item failure recording. Rows are `post` rows (`serverId:postId`) or `link` rows (`link:<url>`, downloaded straight off-site) |
| `links.ts` | Mirror-link rules (provider table, extension/download-path/hash heuristics, own-host skip), payload-wide URL extraction and the `.txt` export/import format (pure functions, no DOM - the worker has no `DOMParser`) |
| `link-store.ts` | `MirrorLinkStore`: the durable collected-link list (`bsm.links`), merge-by-id on re-scan, status/outcome bookkeeping, `MAX_MIRROR_LINKS` cap. Every mutation is serialised, so two queue workers settling two files cannot lose each other's write |
| `tasks.ts` | Download tasks (pure): ids from site+service+creator, statistics and completion (`complete`/`partial`/`failed`/`in-progress`), run planning (`missing` = new + retries, `all`), and the package manifest reader/writer |
| `task-store.ts` | `TaskStore` (`bsm.tasks`): create-or-merge tasks, attach files after a scan, run history, and closing a run when the last of a task's files settles |
| `naming.ts` | Template tokens, `renderTemplate`, `sanitizePathSegment`, `sanitizeFolderPath`, `buildDownloadPath` (traversal + length safety, warnings) and `buildMirrorPath` (the URL-shaped tokens link rows use) |
| `downloads.ts` | `Downloader`, `ChromeDownloader`, `RecordingDownloader`, original-only guard and Pawchive file-start pacing |
| `userAgent.ts` | Builds and syncs `declarativeNetRequest` dynamic User-Agent rules from the saved profiles |
| `router.ts`, `messages.ts` | The message protocol and the single request handler |

### 3. `src/adapters/` — one file per site

`base.ts` holds helpers shared by adapters (status classification, HTML detection,
auth-body word detection, UTF-8-safe base64, tag splitting, probe interpreters).
Each adapter implements the contract from
[docs/ADAPTER_CONTRACT.md](ADAPTER_CONTRACT.md): capabilities, host patterns,
route matching, request building, response parsing, rating mapping, validation
probes, credential fields and User-Agent suggestion.

`gelbooru.ts` additionally exports `createGelbooruLikeAdapter()` so Gelbooru-family
forks (rule34-style DAPI instances) can be registered with a few lines and no
changes to any other layer.

### 4. `src/platform/` — environment abstraction

`Platform` gathers everything that differs between the real extension and the
browser preview: storage area, downloader, message transport, User-Agent rule sync,
active tab URL, options opening, host-permission checks and an environment
description for the diagnostics tab.

- `ExtensionPlatform` — `chrome.storage.local`, `chrome.downloads`,
  `chrome.runtime.sendMessage`, `declarativeNetRequest`, `chrome.tabs`,
  `chrome.permissions`.
- `PreviewPlatform` — shared `localStorage` namespace, mock-media downloads,
  in-process router, no-op User-Agent sync.
- `index.ts` — lazy façade plus `isExtensionEnvironment()` and a headless fallback.

The UI captures `getPlatform()` at module scope; the façade delegates per call, so
the preview can install its platform *after* the UI modules were evaluated.

### 5. UI, side panel, popup, content script

`src/ui/` contains pure view builders. The options page owns application state and
hash routing; the popup reuses the same views for its compact layout; the content
script is a shadow-DOM button that sends one `posts/download` request.

| Module | Used by | Responsibility |
| --- | --- | --- |
| `dom.ts` | everything | element helper (`h`, `button`, `field`, `icon`, `clear`), never `innerHTML` for dynamic content |
| `format.ts`, `toast.ts` | everything | chips/dots/relative times, and toasts |
| `server-list.ts`, `server-form.ts` | options, panel | server manager + add/edit form (driven by the adapter's credential fields) |
| `browse.ts`, `queue-view.ts` | options, popup | wide-layout grid and table views |
| `settings-sections.ts` | options, panel | **the** settings screen: sectioned, one hint per option, shared markup |
| `settings-view.ts` | options | thin adapter over `settings-sections.ts` |
| `diagnostics-view.ts` | options, panel | adapter catalog, environment and redacted validation traces; review reports before sharing |
| `panel-context.ts` | panel | "which page am I on?" card + the single-post card |
| `panel-listing.ts` | panel | fetch card: search box, page range, media filter, crawl progress |
| `panel-queue.ts` | panel | the row list (summary, toolbars, rows) and the fixed dock |
| `panel/panel.ts` | panel | the controller: state, message calls, polling, tab routing |

The panel is documented in [SIDEPANEL.md](SIDEPANEL.md). It uses the same
`UiRequest`s as the options page for API actions; server profiles are masked.
New Hydrus URLs omit the key and use header authentication, but mirror links and
other site data may contain secrets. Chrome Downloads header redirect/storage
behavior remains unverified. See [SECURITY.md](SECURITY.md).

## Message protocol

Everything the UI can ask for is a `UiRequest` (`src/core/messages.ts`); the answer
is always `{ ok: true, data }` or `{ ok: false, error: { message, kind, hint } }`.

```
servers/  list · save · remove · duplicate · setDefault · validate · validateDraft
          clearCredentials · export · import
browse/   search                      (adds the booru tag blacklist; Pawchive queries stay unchanged)
links/    list · posts · scanPost · queue · remove · clear · export · import
          (the Links tab: one listing page → one scan per post → durable list)
tasks/    list · begin · import · export · run · pause · rescan · remove
          (one task per creator: start it, pause it, rescan it, package it)
posts/    get · thumbnail · resolveUrl · download
routes/   detect
queue/    list · enqueue · enqueuePosts · enqueuePawchivePost · enqueueLinks · run · pause · resume
          retryFailed · clear · cancel · remove
          (run accepts { itemIds } - "Download selected")
history/  list · remove · clear        (the download notebook)
searches/ list · add · remove · clear  (recent queries per server)
settings/ get · save · reset
diagnostics/info · userAgent/sync
```

Rules enforced by the router:

- Server profile responses use `ServerConfigView` (`apiKeyMask` + `hasApiKey`).
  Hydrus URLs are key-free and the authenticated thumbnail route accepts only
  profile/file IDs; collected share URLs still retain private fragments, and
  arbitrary site data may contain secrets.
- Only read-like messages are automatically replayed after a lost response.
  A mutation with an uncertain response tells the caller to inspect state rather
  than risking a duplicate download or other repeated action.
- `queue/run` and `queue/resume` are fire-and-forget; the UI polls
  `queue/list` (1.5 s in the options page, 1.2 s in the side panel) so a long
  download never blocks a message channel. `queue/run` takes an optional
  `itemIds` list, which is how the panel downloads only the ticked rows.
- Search history writes are **dropped, not rejected**, when
  `searchHistoryEnabled` is off, so a panel action can never fail because of a
  preference.
- Failures are converted into the shared taxonomy (`FailureKind`) plus a
  next-step `hint`, so the UI can separate *authentication failure* from
  *endpoint mismatch* from *rate limiting* from *network failure*.
- `downloads/post` re-checks the rating filter before saving a file.
- `links/import` classifies imported URLs with `filter: 'any'` and no own-host
  rule: a file the user hands over *is* the instruction. `links/scanPost` is the
  opposite - it applies the configured rules and skips the site's own host, whose
  files the adapter already downloads.

## Request flows

**Validation** (`servers/validate`, `servers/validateDraft`)

```
UI → router → ValidationService
        ├─ preflight: adapter registered? base URL valid? credential pair complete?
        ├─ probe 1: anonymous endpoint (does this host speak the API?)
        │            HTML body → endpoint-mismatch, 404 → endpoint-mismatch, …
        ├─ probe 2..n: authenticated request(s) (only if credentials are present)
        │            401 → auth-failure, 403 → blocked, 429/503 → rate-limited
        └─ result: kind, message, warnings, account, httpStatus, durationMs, trace
               ↓
        ServerStore records validationStatus / validationMessage / lastValidatedAt
        / lastValidationTrace (redacted; visible in the diagnostics tab)
```

**Search**

```
UI → router.browse/search → BooruClient.search
     ├─ resolve server + adapter (serverId, or the default profile)
     ├─ decide the rating filter (settings + server config + per-search toggle)
     ├─ adapter.buildSearchRequest(ctx, spec)   ← site-specific URL/params
     ├─ HttpClient.request (rate limited per server, retried, redacted)
     └─ adapter.parseSearchResponse(...)        → SearchResult of BooruPost
```

**Single-post download**

```
posts/download { url | postId, serverId? }
  ├─ url  → adapter.matchRoute → resolve saved server → adapter.buildPostRequest
  ├─ enforce rating filter (if enabled in settings)
  ├─ requireOriginalFile (never substitute sample or preview)
  ├─ buildDownloadPath (templates → sanitised folder + filename)
  └─ queue persists start intent → chrome.downloads (configured conflict action)
     → save browser ID → reconcile complete/interrupted/unverified
```

**Batch download**

```
posts/download many → queue/enqueuePosts → DownloadQueue.enqueue
   ├─ filter by rating, drop duplicates (`serverId:postId`)
   └─ persist

queue/run → worker loop (maxConcurrency)
   per item: resolve server → adapter.buildPostRequest → parse → require original
             → verify supplied Pawchive attachment identity → naming
             → Downloader.download → persist Chrome ID → onChanged/search → complete/interrupted/unverified
```

**Mirror-link collection** (the Links tab)

```
links/posts { serverId, query, page }
  └─ adapter listing (one page) → deduplicate by postUrl → post refs

links/scanPost { serverId, postId, postUrl?, postTitle?, creator? }
  ├─ client.getPostPayload  ← the *raw* post JSON (attachment rows drop `content`)
  ├─ extractUrlsFromPayload → classifyMirrorLink (providers/extensions/download
  │                            paths/hash; own host always skipped)
  └─ MirrorLinkStore.add    → merge by URL id; report added/duplicate

links/queue → queue.enqueueLinks      → one `link` row per URL (`link:<url>`)
links/export / links/import           → formatLinkExport / parseLinkExport (round-trip)

queue/run, link row → reject known provider share pages → buildMirrorPath
                    → Downloader.download (direct URLs only)
  └─ no server, no adapter, no rating filter; the outcome is synced back to
     bsm.links, and the owning task's run is closed once nothing of it waits
```

**Download tasks** (the Links tab's "send it to a friend" flow)

```
tasks/begin   { serverId, query } → one task per site:service:creator (merged)
tasks/run     { taskId, mode }    → planTaskRun: 'missing' queues new + failed +
                                    unverified, never 'done'; record a run
tasks/pause   { taskId }          → drop that task's pending rows (bsm.links
                                    'queued' → 'new'), close the run if settled
tasks/rescan  { taskId }          → list the creator, skip scannedPosts, collect,
                                    attach members, append a run
tasks/export  { taskId }          → .json manifest + grouped .txt list
tasks/import  { text, filename }  → parseTaskPackage: either half, by content
                                    (filter: 'any', no own-host rule - a file the
                                    user hands over *is* the instruction)
```

## Storage schema

`chrome.storage.local` (never `sync`, because it holds API keys):

| Key | Contents |
| --- | --- |
| `bsm.servers` | `ServerConfig[]` — credentials + validation state + rating allow-list |
| `bsm.settings` | `ExtensionSettings` — templates, concurrency, intervals, toggles |
| `bsm.queue` | `{ items: QueueItem[], paused: boolean, scheduledIds: string[] }` — queue rows, browser IDs/progress and the persisted run selection |
| `bsm.history` | `DownloadHistoryEntry[]` (newest first, capped at 5000) — only original-quality browser-confirmed completions power optional skip; old entries remain but are ignored |
| `bsm.searches` | `SearchHistoryEntry[]` — recent queries per server (capped by the setting) |
| `bsm.links` | `MirrorLink[]` — files collected by the Links tab, with their post context and download outcome (capped at 20,000) |
| `bsm.tasks` | `DownloadTask[]` — one per creator: identity, member file ids, posts already scanned, run history (capped at 500) |
| `bsm.meta` | `{ schemaVersion, firstRunAt }` |

`migrateStorage()` runs on install/update. Queue loading conservatively migrates
legacy start-only `done` rows to `unverified`; legacy original-quality history is
retained but cannot hide originals without the completion marker. In-flight rows
with a Chrome ID are reconciled by `downloads.search({id})`, not reset to pending.
If a worker dies after initiating a start but before saving its ID, the result is
unverified rather than automatically duplicated. Missing browser records are also
unverified. The scheduled selection is persisted before workers start.

Queue, link, task and history `done` require Chrome's `complete` state; interruptions
are retryable failures. A completion is not a byte/hash or content check, and the
file may later disappear. Side effects are written idempotently and failed notebook
writes are retried without another download. Pawchive metadata and file-start
pacing are shared across aliases while the worker's in-memory limiters are alive;
worker restart resets pacing and active transfers are not capped. Old Pawchive
queue indices are blocked until removed/re-added; expected file hashes on new rows
detect metadata changes, not byte integrity. Mega fragments are kept in
stored/exported links and redacted in diagnostic URLs.

## Service worker lifetime

MV3 workers are killed aggressively, so the worker owns no durable state:

- on `onInstalled` / `onStartup`: `migrateStorage()`, `applyUiMode()`
  (toolbar → side panel or popup, from `settings.uiMode`) + User-Agent rule sync;
- on `storage.onChanged` for servers/settings/history/searches: caches
  invalidated, User-Agent rules re-synced, toolbar behaviour re-applied;
- on `runtime.onMessage`: one router call per request;
- `downloads.onChanged` and `onErased` are registered synchronously on worker
  load; a post-start search closes the event-before-ID-persistence race;
- queue recovery searches tracked browser IDs and resumes the stored run plan.
  The panel polls search for byte progress because `onChanged` does not stream it;
- cancellation requests call Chrome, and active rows cannot be removed or cleared.

API actions go through the message router; non-Hydrus UI images can request
remote thumbnails directly. Hydrus thumbnails use bounded, redirect-rejecting
worker fetches; originals pass a transient header to Chrome Downloads after an
exact-target check. Redirect/header storage behavior in Chrome Downloads is not
yet verified. In the preview harness the same router runs in the page; downloads
and their completion are simulated, not observed from Chrome. If a service-worker
Blob fallback is needed but `URL.createObjectURL` is unavailable, the original
start error is surfaced rather than a fake fallback.

## User-Agent strategy

`fetch` cannot set `User-Agent` in a browser, but e621 policy (and Danbooru's
guidance) require a descriptive, non-browser UA:

1. `effectiveUserAgent(adapter, server)` prefers the profile's custom UA, then the
   adapter's generated hint (`BooruServerManager/<version> (by <user> on <site>)`).
2. `syncUserAgentRules()` mirrors those strings into `declarativeNetRequest`
   dynamic rules — one `modifyHeaders` rule per saved server domain, applied to
   `xmlhttprequest` requests. These rules also match subdomains and currently have
   no initiator restriction, so they may affect non-extension requests.
3. e621 additionally documents a `_client=<user agent>` query fallback, which the
   adapter appends when the probe/tests or the user's settings call for it
   (`sendClientParam`).

Both paths are optional and visible in *Settings → User-Agent handling*.

## Testing strategy

| Suite | Covers |
| --- | --- |
| `tests/adapters/{e621,danbooru,gelbooru}.test.ts` | Request building, response parsing, rating mapping, failure classification, routes, credential fields, UA suggestions |
| `tests/adapters/contract.test.ts` | Cross-adapter conformance: every registered adapter must satisfy the contract invariants |
| `tests/core/servers.test.ts` | CRUD, default rules, duplicate, credential clearing, masking, export/import |
| `tests/core/naming.test.ts` | Sanitisation, traversal, reserved names, token rendering, length caps |
| `tests/core/validation.test.ts` | Preflight, endpoint mismatch, auth vs blocked, rate limiting, network failure, trace redaction |
| `tests/core/queue.test.ts` | De-duplication, rating enforcement, failure recording, pause/retry/clear, persistence, concurrency |
| `tests/core/http.test.ts` | Rate limiter spacing, retries, abort, redaction, JSON/HTML/empty-body handling, taxonomy |
| `tests/core/router.test.ts` | Message protocol against mock APIs and server-view masking (not a blanket guarantee for every URL) |
| `tests/core/download-completion.test.ts` | Browser completion/restart and storage-failure handling using mocked Chrome APIs |
| `tests/core/request-policy.test.ts` | API attempts and validation/search rate-policy wiring |
| `tests/core/platform.test.ts`, `content-button.test.ts` | Lost-message response and no-replay behavior |
| `tests/core/preview-server.test.ts` | Harness allowlist, traversal and symlink checks |
| `tests/core/links.test.ts` | Link rules, payload extraction, export/import round-trip, the link store's merge rules, `link` queue rows and the whole `links/*` flow against the mock creator archive |
| `tests/core/tasks.test.ts` | Task identity, statistics/completion, run planning (new + retries, never re-download), the package round-trip between two machines, pause/rescan, and run history |

All suites run without live external services: `tests/helpers.ts` wires the real
service graph against `MemoryStorageArea`, a recording downloader and a mock
fetch. The preview-server test starts a temporary local HTTP process.
