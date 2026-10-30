# Worklist / status

Status of the product scope, what is verified, and what is deliberately left for
later. Last updated for `0.2.0` (side panel release) plus the mirror-link
collector (`0.2.x`).

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
| Hydrus Client API (local http, access key, two-step listing → metadata) | ✅ | `src/adapters/hydrus.ts` |
| Pawchive creator archive (indexed attachment slots, signed/classic originals, preview/deferred handling, all-files queue action) | ✅ offline | `src/adapters/pawchive.ts`, `src/core/router.ts` |
| **Mirror-link collector (Links tab)**: walks a creator's posts, harvests the off-site download links in their bodies, keeps them in a durable list, groups/ticks/queues them, exports and re-imports the list as `.txt` | ✅ | `src/core/links.ts`, `src/core/link-store.ts`, `src/ui/panel-links.ts`, `src/panel/panel.ts`, [docs/SIDEPANEL.md#links-tab-download-tasks](SIDEPANEL.md#links-tab-download-tasks) |
| **Download tasks**: one task per creator (site + service + creator), files joined to it, per-file outcome, completion states (complete/partial/failed/in-progress), run history, *Download missing* (new + retries, never re-download), *Pause*, *Rescan* (incremental) | ✅ | `src/core/tasks.ts`, `src/core/task-store.ts`, `bsm.tasks`, `tasks/*` in `src/core/router.ts` |
| **Task packages**: export writes the `.json` manifest *and* the grouped `.txt`; import reads either half (manifest, our `.txt`, a userscript export, a hand-written list) and merges into the existing task; nothing downloads on import | ✅ | `src/core/tasks.ts` (`formatTaskManifest`, `parseTaskPackage`), `src/core/router.ts` (`tasks/export`, `tasks/import`) |
| Design record for the "torrent-like" behaviour: every option considered, what shipped, what is parked (hashes, pre-known sizes, task scheduling, a 6th tab) | ✅ | [docs/TASKS.md](TASKS.md) |
| `link` queue rows: off-site URLs download without an adapter, a post lookup or a rating, keyed by URL so the same file is never queued twice | ✅ | `src/core/queue.ts` (`enqueueLinks`, `processLinkItem`, `syncLinkRow`) |
| Standalone **Pawchive Link Collector** userscript shipped next to the extension (same rules, no extension needed) | ✅ | `userscripts/pawchive-link-collector.user.js`, `userscripts/README.md` |
| Fixture tests for every added family from live-captured response shapes | ✅ | `tests/adapters/families.test.ts` |
| Documented adapter contract | ✅ | `docs/ADAPTER_CONTRACT.md`, `src/core/adapter.ts`, conformance tests |
| Shared services (servers, settings, validation, client, queue, naming, downloads, User-Agent rules, router) | ✅ | `src/core/*` |
| Browsing, single-post download, batch queue | ✅ | `src/ui/browse.ts`, `src/ui/queue-view.ts`, `src/core/queue.ts` |
| Popup + content-script download button | ✅ | `src/popup/popup.ts`, `src/content/post-button.ts` |
| Diagnostics + credential-free traces | ✅ | `src/ui/diagnostics-view.ts`, `src/core/router.ts` |
| Offline preview harness + mock booru | ✅ | `dev/preview/`, `src/preview/`, `scripts/preview-server.mjs` |
| Tests for adapters and shared logic | ✅ | `tests/` — automated tests (incl. the mirror-link rules, the task/package round-trip and panel logic) |
| Docs | ✅ | `README.md`, `docs/{SIDEPANEL,ARCHITECTURE,ADAPTER_CONTRACT,SECURITY,MANUAL_TESTS,WORKLIST}.md`, `userscripts/README.md` |

### Verification snapshot

```
npm run typecheck   → clean (src + tests, strict TS, noUncheckedIndexedAccess)
npm test            → offline adapter, core and panel suites pass
npm run build       → dist/ with manifest, 4 icons, build-info.json
npm run smoke       → 94/94 checks against the built dist/ bundle (incl. booting
                      the built panel bundle, driving a query and a full
                      mirror-link collection through it, walking all five panel
                      tabs incl. Links, exporting a task package and reading it
                      back, and booting the options bundle)
npm run preview     → harness + side panel/options/popup served on :4173, with a
                      demo creator whose posts carry mirror links
```

| Suite | Tests | Focus |
| --- | --- | --- |
| `tests/adapters/contract.test.ts` | 131 | cross-adapter invariants, automatically covers new adapters (incl. Pawchive) |
| `tests/adapters/families.test.ts` | 25 | Moebooru, Philomena, Hydrus and Gelbooru fork fixtures |
| `tests/adapters/pawchive.test.ts` | 12 | Pawchive hosts, URLs, attachment shapes, signatures and availability |
| `tests/core/pawchive-scope.test.ts` | 16 | legacy profiles, retained boorus, task scope, text-only posts, pacing and preview history |
| `tests/core/preview-media.test.ts` | 2 | local-only mock thumbnails and downloads |
| `tests/adapters/e621.test.ts` | 26 | auth, requests, parsing, failure classification, routes, UA |
| `tests/adapters/danbooru.test.ts` | 17 | same, plus `/profile.json` account parsing |
| `tests/adapters/gelbooru.test.ts` | 24 | DAPI envelope, query-with-userid auth, fork factory |
| `tests/core/router.test.ts` | 35 | entire message protocol end-to-end against the mock APIs |
| `tests/core/links.test.ts` | 30 | link rules, payload extraction, export/import round-trip, store merge rules, `link` rows, the `links/*` flow |
| `tests/core/tasks.test.ts` | 23 | task identity, statistics/completion, run planning, the package round-trip between two machines, pause/rescan, run history |
| `tests/core/panel-core.test.ts` | 35 | page ranges, query composition, template editor, history notebooks, panel settings keys |
| `tests/core/panel-router.test.ts` | 12 | selective runs, history/search messages, blacklist + suffix, legacy quality migration |
| `tests/core/original-only.test.ts` | 25 | original vs sample selection across booru families, direct/queue paths, legacy settings/history |
| `tests/core/pawchive-all-files.test.ts` | 6 | post all-file queueing, unavailable slots, changed hashes and old indices |
| `tests/core/mega-links.test.ts` | 8 | keys, task/queue identity, exports, known share pages and redaction |
| `tests/core/http.test.ts` | 27 | rate limiter, retries, abort, redaction, JSON/HTML/empty bodies |
| `tests/core/queue.test.ts` | 13 | dedupe, rating enforcement, failures, pause/retry/clear, persistence |
| `tests/core/download-completion.test.ts` | 22 | delayed completion, interruption, ID races, worker recovery, progress, cancellation, tasks, legacy records and MV3 listener wiring |
| `tests/core/servers.test.ts` | 19 | CRUD, default rules, duplicate, masking, export/import |
| `tests/core/validation.test.ts` | 19 | preflight, endpoint/auth/rate-limit/network classification, trace redaction |
| `tests/core/naming.test.ts` | 17 | sanitisation, traversal, reserved names, tokens, length caps |

All tests run offline against `src/preview/mock-booru.ts`; no live site is contacted
by the suite. `docs/MANUAL_TESTS.md` is a plan, not proof that live Pawchive
has been tested for these changes.

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
- **Storage writes are serialised.** `MirrorLinkStore` and `TaskStore` chain their
  mutations: two concurrent queue workers settling two files used to race on a
  read-modify-write of the whole list and lose one status change (found by the
  task tests, fixed in `src/core/link-store.ts`).

- **Exactly one default** profile always exists once at least one server is saved
  (first save wins, deleting the default promotes the next row).
- **Rating filter is three-layered**: profile allow-list (stored), shared decision
  layer (`BooruClient.isRatingAllowed` / `ratingFilterFor`), site spelling in the
  adapter. Queueing filters, and single downloads filter when
  *Settings → Enforce rating filter on download* is on.
- **Validating a draft reuses stored secrets** when the key field is left blank, so
  “edit → validate” does not require re-typing a key.
- **The queue is stateful across restarts**: running browser IDs are reconciled
  against Chrome, and the persisted selection can resume dispatch. A running row
  without an ID is unverified rather than silently restarted. Old start-only done
  rows and history are also unverified. Active rows cannot be removed or cleared.
- **e621 User-Agent**: custom UA → `declarativeNetRequest` header rewrite →
  `_client` query parameter fallback (`sendClientParam` setting).
- **Rate limiting** is per saved server, defaulting to 1 request/second plus the
  adapter's documented minimum; the HTTP layer also retries 429/5xx with backoff
  and honours `Retry-After`.

## Known gaps / deliberate non-goals (0.1.0)

| Gap | Notes / plan |
| --- | --- |
| Read-only product | No uploads, favourites, pool edits or tag edits. The adapters expose only read endpoints plus the vote/favourite helpers that are not yet surfaced in the UI. |
| No tag autocomplete | Would need a per-site tag endpoint; `supportsTagSearch` capability is already declared. |
| Pools/forks browsing | `matchRoute` recognises pool URLs, but no pool listing UI yet. |
| No downloaded-content integrity check | Chrome reports transfer state and byte progress, but the extension does not hash saved files or detect every HTML/error response, and files can later be moved or deleted. |
| No bulk “download whole search” | Queueing is per page; “queue all loaded” covers the current listing. |
| Live network tests are not automated | `npm run smoke` uses an offline mock; Pawchive has not been live-tested for the current changes. |
| Chrome/Edge/Brave only | Built on `chrome.*` MV3 APIs. Firefox would need a `browser.*` shim and manifest tweaks. |
| No i18n | All strings are English literals in the view layer. |
| Mirror links are not resolved | Known Mega/Drive and other share pages are retained for open/export and refused by the queue. Unknown interstitials can still return HTML; provider resolution and decryption are not implemented. |
| No content verification in a task package | The manifest records URLs and browser-reported outcomes, not verified bytes or hashes — see [docs/TASKS.md](TASKS.md). |
| No task-level scheduler | Tasks start when pressed. Per-task concurrency, start times and a queue of tasks are parked until the model earns them. |
| Preview modules ship inside `dist/` | `dist/preview/*.js` is inert in the extension (the UI only imports it when `chrome.runtime.id` is missing); excluding it from the build would shave a few KB. |
| No release packaging | `dist/` is loadable unpacked; a zipped CRX/XPI and a CI workflow are not set up yet. |

## Next steps (suggested order)

1. **Download-integrity pass**: design byte/hash verification of completed files
   where Chrome permissions and the site's metadata permit it. Completion tracking
   is implemented, but `onChanged` does not stream bytes: the panel polls
   `chrome.downloads.search()` for browser-reported progress.
2. **Archive picture packing** (ZIP/CBZ/PDF per post, offscreen document) as an
   optional output mode in the panel's settings, mirroring the Rule 34 picture
   modes.
3. **Tag autocomplete + favourites/history browsing** using the sites' tag and
   favourites endpoints, behind the existing capability flags (Anime Boxes parity).
4. **Zip packaging + CI**: build artifact upload, `npm run verify` as a workflow,
   a version-bump script.
5. **Exclude the preview modules from release builds** (build flag) and ship a
   `dist-preview` variant for the harness.
6. **Pool/favourites browsing** for e621/Danbooru (adapters already recognise the
   routes; the UI needs a second listing mode).
7. **More adapters**: register common DAPI forks via `createGelbooruLikeAdapter`
   and add a first-class adapter for a Danbooru-style instance to validate that the
   contract scales beyond the three targets.
8. **Firefox/Manifest parity pass** if a second browser target is required
   (the side panel has no Firefox equivalent, so the popup fallback earns its keep).
