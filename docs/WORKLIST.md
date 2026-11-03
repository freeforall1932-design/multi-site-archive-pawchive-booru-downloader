# Worklist / status

Status of the product scope, what is verified, and what remains. Updated for
version `0.2.0` and the 2026-11-03 audit. Most automated results are offline;
installed-extension and live Hydrus/Pawchive checks remain outstanding.

## Delivered

| Deliverable | Status | Where |
| --- | --- | --- |
| Working extension skeleton (MV3, TypeScript, no bundler) | ✅ | `src/manifest.json`, `scripts/build.mjs` → `dist/` |
| **Side panel as the primary surface** (Browse · Queue · Links · Servers · Settings, deep links, dock) | ✅ | `src/panel/`, `src/ui/panel-*.ts`, [docs/SIDEPANEL.md](SIDEPANEL.md) |
| Toolbar mode switch (side panel vs popup) applied from settings by the worker | ✅ | `src/background/service-worker.ts` (`applyUiMode`), `settings.uiMode` |
| Active-tab detection + "this post" card in the panel | ✅ | `src/ui/panel-context.ts`, `routes/detect`, `posts/get` |
| Listing card: tag search with suggestions, page ranges (`2,4,6-10`, `50-`, `all`), crawl cap, progress, media filter | ✅ | `src/ui/panel-listing.ts`, `src/core/pages.ts` |
| Review-then-download rows: a row *is* a persisted queue item, ticked selection, selective runs | ✅ | `src/ui/panel-queue.ts`, `queue/run { itemIds }`, `queue/remove` |
| Settings in the NHentai-Downloader section style (heading + hint per option, template checkbox editor, live preview) | ✅ | `src/ui/settings-sections.ts`, `src/core/template.ts` |
| Browser-completion tracking for direct posts, queue and mirror/task downloads; confirmed-only history + remembered searches | ✅ | `src/core/history.ts`, `bsm.history`, `bsm.searches` |
| Shared tag blacklist and "always append these tags" applied to booru searches (not Pawchive creator/title queries) | ✅ | `src/core/search.ts`, router `browse/search`, adapter `composeTags` |
| Original-only downloads and duplicate behaviour on the dock/settings | ✅ | `src/core/downloads.ts`, normalized legacy settings, queue + router paths |
| Multi-server / multi-account manager with mobile-style server list | ✅ | `src/ui/server-list.ts`, `src/options/options.ts` (`#servers`) |
| Add/edit screen with per-site fields, validate-client, save | ✅ | `src/ui/server-form.ts`, `src/core/validation.ts` |
| **e621 adapter** (first target) | ✅ | `src/adapters/e621.ts` |
| Danbooru adapter | ✅ | `src/adapters/danbooru.ts` |
| Gelbooru adapter (+ factory for DAPI forks; accepts 0.2 envelope and 0.1.11 bare arrays) | ✅ | `src/adapters/gelbooru.ts` |
| Gelbooru 0.1.11 forks: rule34.xxx (auth required), safebooru.org, xbooru, tbib, hypnohub, realbooru | ✅ | `src/adapters/gelbooru-forks.ts` |
| Moebooru family: yande.re, konachan (`/post.json`, optional `login`+`password_hash`) | ✅ | `src/adapters/moebooru.ts` |
| Philomena family: derpibooru, furbooru, ponybooru (comma query syntax, ratings as tags, filter pinning) | ✅ | `src/adapters/philomena.ts` |
| Hydrus Client API (local HTTP, access key, listing → metadata) | ⚠️ key-free URLs and header auth tested offline; Chrome Downloads header redirects/storage unverified | `src/adapters/hydrus.ts`, [SECURITY.md](SECURITY.md) |
| Pawchive creator archive (indexed attachment slots, signed/classic originals, preview/deferred handling, all-files queue action) | ✅ offline | `src/adapters/pawchive.ts`, `src/core/router.ts` |
| **Mirror-link collector (Links tab)**: walks a creator's posts, harvests the off-site download links in their bodies, keeps them in a durable list, groups/ticks/queues them, exports and re-imports the list as `.txt` | ✅ | `src/core/links.ts`, `src/core/link-store.ts`, `src/ui/panel-links.ts`, `src/panel/panel.ts`, [docs/SIDEPANEL.md#links-tab-download-tasks](SIDEPANEL.md#links-tab-download-tasks) |
| **Download tasks**: one task per creator (site + service + creator), per-file outcomes, run history, *Download missing* (new, failed, unverified; skips confirmed completions), *Pause*, *Rescan* | ✅ | `src/core/tasks.ts`, `src/core/task-store.ts`, `bsm.tasks`, `tasks/*` in `src/core/router.ts` |
| **Task packages**: export writes the `.json` manifest *and* the grouped `.txt`; import reads either half (manifest, our `.txt`, a userscript export, a hand-written list) and merges into the existing task; nothing downloads on import | ✅ | `src/core/tasks.ts` (`formatTaskManifest`, `parseTaskPackage`), `src/core/router.ts` (`tasks/export`, `tasks/import`) |
| Design record for the "torrent-like" behaviour: every option considered, what shipped, what is parked (hashes, pre-known sizes, task scheduling, a 6th tab) | ✅ | [docs/TASKS.md](TASKS.md) |
| `link` queue rows: off-site URLs download without an adapter, post lookup or rating; duplicate active/pending URLs are suppressed | ✅ | `src/core/queue.ts` (`enqueueLinks`, `processLinkItem`, `syncLinkRow`) |
| Standalone **Pawchive Link Collector** userscript shipped next to the extension (separate HTML-based collector, no extension needed) | ✅ | `userscripts/pawchive-link-collector.user.js`, `userscripts/README.md` |
| Fixture tests for added families | ✅ offline | `tests/adapters/families.test.ts`; Hydrus fixtures are based on API documentation, not a live local client |
| Documented adapter contract | ✅ | `docs/ADAPTER_CONTRACT.md`, `src/core/adapter.ts`, conformance tests |
| Shared services (servers, settings, validation, client, queue, naming, downloads, User-Agent rules, router) | ✅ | `src/core/*` |
| Browsing, single-post download, batch queue | ✅ | `src/ui/browse.ts`, `src/ui/queue-view.ts`, `src/core/queue.ts` |
| Popup + content-script download button | ✅ | `src/popup/popup.ts`, `src/content/post-button.ts` |
| Diagnostics + redacted request traces | ✅ with caveats | `src/ui/diagnostics-view.ts`, `src/core/router.ts`; unknown secret names and arbitrary site data still require care ([SECURITY.md](SECURITY.md)) |
| Offline preview harness + mock booru | ✅ | `dev/preview/`, `src/preview/`, `scripts/preview-server.mjs` |
| Tests for adapters and shared logic | ✅ | `tests/` — automated tests (incl. the mirror-link rules, the task/package round-trip and panel logic) |
| Docs | ✅ | `README.md`, `docs/{SIDEPANEL,ARCHITECTURE,ADAPTER_CONTRACT,SECURITY,MANUAL_TESTS,WORKLIST}.md`, `userscripts/README.md` |

### Verification snapshot

Audit verification on 2026-11-03: `npm run verify` passed strict typechecking,
build, **595/595 tests** and **96/96 built-bundle smoke checks**. `npm audit`
reported **0 vulnerabilities** and `git diff --check` was clean.

The offline suites cover adapters, original-only selection, Pawchive attachment
identity, Mega links, queue completion/recovery and bookkeeping, message transport,
request policy, security redaction, tasks, UI logic and preview-server access. One
suite starts a local preview HTTP server; no live external service is contacted.
A separate HeadlessChrome **mock-preview** check exercised multi-character typing,
caret insertion, synthetic composition events, filtering, delayed settings saves,
and profile validation/save controls. It was not an installed extension test.
[MANUAL_TESTS.md](MANUAL_TESTS.md) remains a plan, not evidence of a live Chrome
extension, Hydrus or Pawchive run.

## Behaviour notes worth knowing

- **The panel's row list *is* `bsm.queue`.** A row is a persisted `QueueItem`, so
  closing the panel (or restarting the worker) never loses work; ticking rows only
  decides *which pending items a run may touch* (`queue/run { itemIds }`).
- **Fetching never downloads.** A fetch calls `queue/enqueuePosts` only; the queue
  starts when the dock button (or the content-script button on a post page) asks
  for a run. `settings.autoStartQueue` only controls whether "Download selected"
  also starts the run.
- **Newly listed rows arrive ticked**, and a row you untick stays unticked across
  refreshes (selection is reconciled against a snapshot of pending ids).
- **The tag blacklist is applied in the router**, once, for booru queries on every surface; the
  *global suffix* is applied by the adapters (which also de-duplicate it against
  your own tags), so neither is ever added twice. Pawchive queries are not filtered by these booru rules.
- **Original-only policy:** old `filePreference: 'sample'` is normalized to
  `original`; missing originals and known reduced renditions fail rather than fall
  back. Metadata-based selection is not checksum/content verification.
- **A mirror link is a second kind of queue row.** It is keyed by its URL
  (`link:<url>`), skips the adapter, the post lookup and the rating filter, and is
  saved through the URL-shaped naming tokens (`mirrors/{host}` by default) - which
  is what makes an imported `.txt` work on a profile that has no server at all.
  Known provider share pages are rejected, with open/export as the fallback.
  Unknown HTML interstitials cannot always be distinguished from direct files.
- **Re-collecting a creator never duplicates work.** The link store merges by URL
  id and keeps an existing `done`/`failed` outcome, so a second scan of the same
  creator only refreshes the post context and reports duplicates.
- **"Download missing" is the only bulk action a task needs.** It queues files
  that are `new` *and* files that `failed` - a retry is the same button - and
  never a file that is `done`. That is the whole re-run strategy: new posts appear
  via *Rescan*; interrupted and unverified attempts are retryable. `done` means
  Chrome reported completion, not that the file contents or continued existence
  were verified. Check unverified starts before retrying to avoid duplicates.
- **A task is traced, not guessed.** Every file keeps its post id, post URL,
  post title, provider and site; the task keeps the posts it scanned and a run
  history (when, how many posts, how many added/queued/saved/failed). "Complete /
  partial / failed" is computed from those records, never inferred from the
  filesystem.
- **Store writes are serialised within the worker.** Server, settings, link, task,
  download-history and search-history mutations chain their read-modify-writes,
  preventing concurrent operations on the same store instance from losing each
  other's updates. This is not a cross-process transaction or a guarantee against
  storage-quota failures. Multiple open UI drafts can still overwrite one another.

- **One usable default** is selected when a usable profile exists (first save
  wins, deleting the default promotes another). Unsupported or invalid legacy
  profiles are retained for recovery but cannot be used as defaults.
- **Rating filter is three-layered**: profile allow-list (stored), shared decision
  layer (`BooruClient.isRatingAllowed` / `ratingFilterFor`), site spelling in the
  adapter. Queueing filters, and single downloads filter when
  *Settings → Enforce rating filter on download* is on.
- **Validating a draft reuses stored secrets only for the same connection** when
  the key field is blank. Changing the site or endpoint requires re-entering the
  key or clearing credentials; stale validation results do not authorize a save.
- **The queue is stateful across restarts**: running browser IDs are reconciled
  against Chrome, and the persisted selection can resume dispatch. A running row
  without an ID is unverified rather than silently restarted. Old start-only done
  rows and history are also unverified. Active rows cannot be removed or cleared.
- **e621 User-Agent**: custom UA → `declarativeNetRequest` header rewrite →
  `_client` query parameter fallback (`sendClientParam` setting).
- **API rate limiting** is per saved server, defaulting to 1 request/second plus
  the adapter's minimum; Pawchive shares a budget across its profiles. Validation,
  search and post lookup use the same budget. Configured API attempts include the
  initial request; transient errors use backoff and `Retry-After`. Limiter state
  is in memory and resets on worker restart.

## Known gaps / deliberate non-goals

| Gap | Notes / plan |
| --- | --- |
| **Hydrus download-header and redirect risk** | New URLs are key-free; metadata/thumbnails reject redirects and original downloads pass a transient header after exact-target validation. Chrome Downloads redirect handling and header storage, and a live Hydrus client, remain untested. Use a trusted direct endpoint and restricted key; rotate previously exposed keys and clean old browser records. See [SECURITY.md](SECURITY.md). |
| **User-Agent rule scope is broad** | DNR `requestDomains` includes subdomains and has no initiator restriction. Test a safe extension-only restriction in Chrome before changing it. |
| **No live Chrome/Pawchive validation yet** | Exercise MV3 start/completion, interruption, cancellation, worker restart, permissions, originals, all-file selection and Mega export against permitted test data. See [MANUAL_TESTS.md](MANUAL_TESTS.md). |
| **Pacing resets on worker restart** | Pawchive metadata and file-start limiters are in memory; persist or otherwise coordinate budgets across restarts if strict continuity is required. Other applications and multiple booru profiles are not globally coordinated. |
| **MV3 blob fallback is unavailable** | Service workers lack `URL.createObjectURL`; a failed direct browser start is surfaced instead. Evaluate an offscreen-document fallback only if needed and test authentication, permissions and cleanup. |
| **Multiple UI editors** | Mutations are serialized within a store/UI instance, but separate open options/panel drafts are not a cross-context transaction; one can overwrite another. Investigate revision-based conflict detection. |
| **Hydrus thumbnail cache after credential changes** | Already fetched thumbnails can remain in the page's bounded in-memory cache until eviction or reload, including after a key is changed/revoked in another view. Investigate cross-view cache invalidation; close/reopen the UI if immediate removal matters. |
| **Settings write volume** | Panel text edits currently save serially per input and each save can resync User-Agent rules. Investigate safe coalescing/debouncing without dropping the final edit on panel close. |
| **Large-state scalability** | Queue/progress and related stores rewrite serialized lists; Chrome local-storage quota and UI/worker load can limit large collections despite row caps. Benchmark, handle quota exhaustion and consider a transactional/paged store. |
| **Uncertain message outcomes** | Mutation responses can be lost after execution; no replay is attempted. Users must inspect state and Chrome Downloads before retrying. A stronger idempotency protocol is future work. |
| Read-only product | No uploads, favourites, pool edits or tag edits are exposed in the UI. |
| No tag autocomplete | Would need a per-site tag endpoint; `supportsTagSearch` capability is already declared. |
| Pools/forks browsing | `matchRoute` recognises pool URLs, but no pool listing UI yet. |
| No downloaded-content integrity check | Chrome reports transfer state and byte progress, but the extension does not hash saved files or detect every HTML/error response, and files can later be moved or deleted. |
| No unlimited whole-search archive | The panel can fetch a page range and queue loaded rows, but one crawl is capped by the page-limit setting and does not guarantee a complete archive. |
| Live network tests are not automated | `npm run smoke` uses an offline mock; Pawchive has not been live-tested for the current changes. |
| Chrome/Edge/Brave only | Built on `chrome.*` MV3 APIs. Firefox would need a `browser.*` shim and manifest tweaks. |
| No i18n | All strings are English literals in the view layer. |
| Mirror links are not resolved | Known Mega/Drive and other share pages are retained for open/export and refused by the queue. Unknown interstitials can still return HTML; provider resolution and decryption are not implemented. |
| No content verification in a task package | The manifest records URLs and browser-reported outcomes, not verified bytes or hashes — see [docs/TASKS.md](TASKS.md). |
| No task-level scheduler | Tasks start when pressed. Per-task concurrency, start times and a queue of tasks are parked until the model earns them. |
| Preview modules ship inside `dist/` | `dist/preview/*.js` is inert in the extension (the UI only imports it when `chrome.runtime.id` is missing); excluding it from the build would shave a few KB. |
| No release packaging | `dist/` is loadable unpacked; a zipped CRX/XPI and a CI workflow are not set up yet. |

## Next steps (suggested order)

1. **Hydrus real-browser security validation:** with disposable keys and controlled
   endpoints, test Chrome Downloads custom-header forwarding on redirects and header
   retention, plus live Hydrus search, thumbnails and originals. Finish rotation and
   manual cleanup of old browser records. Until then, use a trusted direct endpoint.
2. **Real-browser and live-site checks:** run the unperformed cases in
   [MANUAL_TESTS.md](MANUAL_TESTS.md), including typing/IME in the extension,
   permission prompts, Chrome completion/restart races, originals and
   available/deferred Pawchive attachments.
3. **User-Agent scope and pacing:** investigate extension-only DNR initiators and
   rate-budget continuity across worker restarts; validate Chrome behavior.
4. **Integrity and reliability:** research byte/hash verification, large-queue
   storage limits, explicit mutation idempotency and any MV3-safe blob fallback.
5. **Optional product work:** archive picture packing (ZIP/CBZ/PDF), tag
   autocomplete, pool/favourites browsing, and provider-specific link resolution.
6. **Release/portability:** automated packaged artifacts and CI, excluding preview
   modules from release builds, and Firefox support if requested. Any additional
   adapters must remain within the product's Pawchive-only creator-archive scope.
