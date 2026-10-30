# The side panel

The side panel (`src/panel/`) is the daily driver of the extension: a docked,
resizable surface that lists results, reviews them, and downloads them without
leaving the booru page you are on.

It is deliberately built the way the sister side-panel downloaders are built —
one dock, one list, one settings screen — while staying a *booru* tool:

| Where the idea comes from | What was taken | How it was adapted here |
| --- | --- | --- |
| **twitter-batch-download** (`X Media Downloader`) | Header with an eyebrow + live status pill, a "what page am I on?" card with a refresh button, a summary strip, toolbars, a row list with per-row remove, a fixed download dock with a segmented concurrency control, output settings in a collapsible `<details>` | The "active tab" card resolves the page against your **saved booru servers** instead of one hard-coded site; rows are booru posts (rating, tags, md5, video/picture) |
| **rule34video** (`Downloader for Rule 34`) | Listing card with `List this page` / `Download page`, `From … To` page range plus an **advanced** box (`2,4,6-10`, `1-99`, `50-`, `all`), a media filter, "skip downloaded", a page-limit cap on one crawl, progress bar, review-then-download promise, dock with concurrency **and quality** selects | Pages are the sites' own listing pages (e621/Danbooru/Gelbooru paginate differently, the adapters handle that); the media filter is picture/video; downloads are original-only; samples are used only for display |
| **nh-dw-2.0** (`NHentai Downloader`) | Settings as **sections with a heading and a plain-language hint per option**, a name-template editor made of checkboxes with a custom-template fallback and a live preview, download history with "skip downloaded", per-server credentials stored in `storage.local` only, `uiMode` (panel vs popup) | Sections cover booru concerns: rating filters, per-server credentials, request spacing, tag blacklist, template tokens that exist here (`{md5}`, `{rating}`, `{artist}` …) |
| **Anime Boxes** (Gelbooru/Danbooru client) | Multi-server profile list, tag search with remembered searches, tag blacklist, picture/video split, "you already have this" awareness | Search history + blacklist live in Settings and feed the panel search box; `skipDownloaded` greys out/omits posts found in the download history |

## Layout

```
┌───────────────────────────────────────────────────────────┐
│ BOORU SERVER MANAGER                        3 downloading │  header + status pill
│ Download panel                                            │
├───────────────────────────────────────────────────────────┤
│  Browse │ Queue ③ │ Links │ Servers │ Settings            │  tab strip (deep links:
├───────────────────────────────────────────────────────────┤  #browse #queue #links
│ ●  e621 post #1500000 — default profile             [Use…]│  #servers #settings)
│ [thumb] #1500000 safe  [video]                            │  "this post" card
│         [Download this file] [Add to list]                │
├───────────────────────────────────────────────────────────┤
│ [ e621 (demo account) ▾ ]                                 │
│ [ tags, e.g. cat solo rating:safe              ] [×]      │  search + suggestions
│ This fetch: +1 always-on tag(s) · −2 blacklisted          │
│ [ List this page ] [ Download page ]                      │
│ From [1]  To [last]                              advanced │  page range
│ [ Pics + videos ▾ ]  ☐ Skip completed                       │
│ ☑ apply this profile's rating filter (safe)               │
│ [ Fetch selected pages ]                          [ Stop ]│
│  ▓▓▓▓▓▓░░░░  Listed page 3 · 120 post(s) so far           │
├───────────────────────────────────────────────────────────┤
│   18 listed        3 selected        2 completed          │  summary
│ ☑ Select all   Invert   Remove selected (3)               │  toolbars
│ Retry failed / unverified   Clear finished   Reset history   Clear list│
│ [☑][thumb] #1500000 [pic][safe][e621][completed] completed  ✕ │  rows (a row *is* a
│ [☑][thumb] #1500001 [video][general][e621]  downloading ✕ │  persisted queue item)
├───────────────────────────────────────────────────────────┤
│ Start workers [1][2][3][5]            Original files only│  dock (fixed)
│ [ Download selected (3) ]                        [ Pause ]│
│ Tick rows (or Select all), then download. …                │
└───────────────────────────────────────────────────────────┘
```

## Tabs

| Tab | What it does | Backing messages |
| --- | --- | --- |
| **Browse** | Active-tab card, "this post" card, fetch card, the list of rows | `routes/detect`, `posts/get`, `browse/search`, `queue/enqueuePosts`, `queue/enqueuePawchivePost`, `history/list` |
| **Queue** | The same rows, focused on progress: retry failed, clear finished, reset history, clear list | `queue/list`, `queue/retryFailed`, `queue/clear`, `history/clear` |
|  | Rows carry the media badge (`pic`/`video`), the canonical **rating chip**, the profile's site type and a `saved` badge | `queue/list` (rating is stored on the row at enqueue time) |
| **Links** | Download **tasks** (one per creator) plus the raw link list: collect a creator's off-site links, download what is missing, rescan for new uploads, pause, export/import a package | `tasks/*`, `links/list`, `links/posts`, `links/scanPost`, `links/queue`, `links/remove`, `links/clear`, `links/export`, `links/import`, `queue/enqueueLinks` |
| **Servers** | Full server manager (list, add/edit/validate, duplicate, delete, set default) plus diagnostics | `servers/*`, `diagnostics/info`, `userAgent/sync` |
| **Settings** | The sectioned settings screen (identical to the options page's) | `settings/get`, `settings/save`, `servers/export|import`, `history/*`, `searches/*` |

Everything the panel shows is fetched through the background worker. The panel
never holds a credential, never issues a network request and never writes a file
itself — the same rule the options page and popup follow.

## The list is the queue

A row **is** a persisted `QueueItem` (`src/core/queue.ts`). That gives the panel,
for free:

- state that survives closing the panel, reloading the page and restarting the
  service worker: browser IDs are persisted and reconciled instead of restarting
  active transfers; selected pending work can resume;
- de-duplication (`serverId:postId`) that spans every surface, so the popup and
  the content-script button cannot queue the same post twice;
- one place where the rating filter is enforced.

"Fetching only adds rows" is a promise the code keeps: `queue/enqueuePosts` is the
only thing a fetch calls, and a run happens only when you press **Download
selected**. Tick marks select *which pending rows* a run may touch:

```
queue/run                     → every pending row
queue/run { itemIds: [...] }  → only the ticked rows (the dock button)
```

Newly listed rows arrive ticked; a row you untick stays unticked across refreshes
(the selection is reconciled, not reset).

A mirror link is a queue row too, with two deliberate differences: it is keyed by
its **URL** (`link:<url>`) instead of `serverId:postId`, and it skips the adapter,
the post lookup and the rating filter - the file is off-site, so there is no booru post to look up. Direct URLs can run
on a fresh profile; known share/landing pages are refused and should be opened
or exported to a provider download manager. Unknown interstitials can still return HTML.

## Pawchive attachments

On a Pawchive post, **Add all available files** fetches the post and queues each
available original attachment. Choose the queue rows and press **Download
selected** to start them. The ordinary post download, popup and on-page button
select one attachment (usually the first). Creator listings expand attachment
slots, and the Links tab independently collects off-site URLs. Deferred or
preview-only slots cannot be downloaded; post text/HTML and embedded-only images
are not archived. New rows use attachment hash metadata when present to detect
changed order, not to verify downloaded bytes. Remove and re-add any Pawchive
queue rows from older versions because their indices may be ambiguous.

**Transfer status:** Chrome's start response is not completion. The worker tracks
Chrome download IDs and reports `done` only after Chrome says `complete`, or
`failed` on interruption. Progress is polled from Chrome while the panel is open.
If the ID was never persisted, or Chrome's record is missing, the result is
`unverified` rather than automatically retried; inspect Chrome Downloads before
retrying. A `done` file is not hash-checked and might be an HTML error page or
later deleted. Queue workers and Pawchive pacing limit starts, not active browser
transfers. The offline preview simulates completion and cannot test Chrome APIs.

## Settings reference

All of these live in `chrome.storage.local` and are shared by the panel, the
options page and the popup. Defaults in brackets.

### 1. Global behaviour

| Setting | What it does |
| --- | --- |
| **Toolbar click opens** [`sidepanel`] | `sidepanel` = docked panel (`openPanelOnActionClick`), `popup` = the classic popup page. The worker re-applies the stored choice every time it starts, so a `popup` profile keeps its popup. |
| **Panel opens on** [`browse`] | Which tab the panel shows when it opens (`browse`, `queue`, `links`, `servers`, `settings`). |
| **Theme** [`system`] | Dark-first design; `light` exists for daytime reading. |

### 2. Multiple download

| Setting | What it does |
| --- | --- |
| **Queue start workers** [2] | Parallel workers preparing download starts, not a limit on active Chrome transfers. The dock control writes the same value. |
| **Wait between requests to one server** [1 s] | Per-server spacing for API calls; adapters raise it when the site documents a hard limit (e621: 2 req/s), and the stricter value wins. |
| **Retries per download** [3] | Retries for transient failures (network, 5xx, "slow down"). Auth and configuration errors are never retried. |
| **If the file already exists** [`uniquify`] | Keep both (add a number) or overwrite. Passed straight to `chrome.downloads`. |

### 3. Multiple download → file rendition

Downloads are **original-only**. An old `filePreference: sample` setting is
migrated to `original`; if the original is unavailable the operation fails rather
than downloading a preview, sample or resized rendition. Thumbnails are display
only. The extension does not verify downloaded bytes or the site's claims.

### 2b. Mirror links

| Setting | What it does |
| --- | --- |
| **Only download-looking links** [`downloads`] | What the collector keeps. `downloads` = known file hosts plus URLs that end in a file extension, look like a download (`/download/…`, `?file=…`) or carry a long hash; `any` = every external link, for posts that link somewhere unusual. Links on the site itself are never collected - those are ordinary post downloads. |
| **Extra provider hosts** [`''`] | Which hosts count as providers, space or comma separated. A subdomain counts too (`mega.nz` matches `www.mega.nz`). |
| **Mirror folder template** [`mirrors/{host}`] | Where link rows are saved. Its tokens describe a URL, not a post: `{host}`, `{provider}`, `{siteType}`, `{filename}`, `{ext}`, `{date}`. |

### 4. List results

| Setting | What it does |
| --- | --- |
| **Default media filter** [`all`] | `all` / `video` / `image` — what a fetch may add to the list. Still switchable per fetch in the listing card. |
| **Pages per fetch** [150] | Hard cap on one crawl (`all` or `50-` selections stop there). |
| **Queue rows shown** [60] | How many rows are drawn; the rest is summarised as "n more row(s) not drawn". Changes the view, never the run. |
| **Skip posts previously completed** [off] | Hides only originals Chrome reported complete. Old start-only or unknown-quality entries remain stored but are ignored. Files may have been moved/deleted; reset history to list them again. Existing settings are preserved. |

### 5. Search behaviour

| Setting | What it does |
| --- | --- |
| **Always append these tags** [`''`] | Global tag suffix, appended to booru searches and de-duplicated case-insensitively; it is not applied to Pawchive queries. |
| **Never show these tags** [`''`] | Tag blacklist. On supported boorus each token becomes `-tag` and is removed from the positive side of your own queries. This does not filter Pawchive results. |
| **Remember my searches** [on] | Recent queries appear under the search box and re-run with one click. |
| **Searches remembered per server** [12] | Trim limit per server; `None` also stops new ones being stored. |

### 6. Name template

| Setting | What it does |
| --- | --- |
| **Folder** [`booru/{siteType}`] | Directory template. Slashes nest; every segment is sanitised and traversal-proof. |
| **File name is built from** [`{id}_{md5}`] | One checkbox per token (`{id}`, `{md5}`, `{siteType}`, `{serverLabel}`, `{rating}`, `{score}`, `{artist}`, `{artists}`, `{character}`, `{copyright}`, `{tags}`, `{tagCount}`, `{date}`, `{year}`, `{month}`, `{width}`, `{height}`, `{ext}`, `{filename}`, `{isVideo}`, `{source}`). A template the checkboxes cannot express keeps its raw value in an editable box (custom templates are never silently rewritten). |
| **Example** | Live preview of `Downloads/<folder>/<name>` for a sample post, including the warnings the naming layer would raise. |
| **Tags in the filename** [5] | How many tags `{tags}`/`{artists}`/`{tagN}` expand to. |
| **Tag separator** [space] | Used when several tags are joined. |

### 7. Interface

| Setting | What it does |
| --- | --- |
| **Post thumbnails in the queue** [on] | Show a preview image per row (one preview request per row). |
| **Start downloading immediately** [on] | On: *Download selected* runs the queue. Off: it only adds rows — press Start on the dock. |
| **Download button on post pages** [on] | The floating content-script button. |

### 8. Advanced behaviour

| Setting | What it does |
| --- | --- |
| **Identify as this extension** [on] | Descriptive User-Agent via `declarativeNetRequest` (required by e621/Danbooru policy). |
| **Also send the `_client` parameter** [on] | Fallback for proxies that strip headers. |
| **Enforce the rating filter on download** [on] | Single-post downloads obey the same allow-list as listings. |
| **Host access** | Whether the browser granted the profile's origin, with a Grant button. |

### 9–10. Server credentials & download history

Export (with or without keys), import, "delete all keys", the download-history
counter with **Reset download history**, **Clear search history** and **Reset
every setting** (servers and keys are never touched by a reset).

## Links tab: download tasks

Pawchive posts may refer to files that are *not* on the site: the post body
says "the pack is on Mega" and links there. Those URLs are not booru posts, so the ordinary listing cannot see them.
The Links tab turns them into a **task**: one creator on one site, the files that
belong to them, and what happened to each one.

```
Links
[ Profile: Pawchive (demo creator) ▾ ]   archive API
[ fanbox/1245946                                    ]
[ Collect links ]  [ Stop ]
  96 collected   61 to download   35 downloaded   3 failed
┌ 1245946 · fanbox        [pawchive] [fanbox]   partial - some files failed
│ 35/41 file(s) completed · 3 failed · 3 still missing · scanned 2 hours ago
│ last run 2 hours ago · 18 post(s) scanned · 6 new file(s) · 6 queued · 35 completed · 3 failed
│ [ Download missing (6) ] [ Pause ] [ Rescan ] [ Export package ]        ✕
│   ▸ (expand) one row per file, grouped by post, each with its own status
└
Import package…        Export .txt (whole list)
Unfiled links   (a bare .txt import, a userscript export, a single URL)
```

### Collecting

Pick a Pawchive profile, type a creator (`service/creatorId`, a creator
URL, `tag:name` or plain text), press *Collect links*. The panel asks the worker
for one listing page (`links/posts`) and then walks the posts one at a time
(`links/scanPost`), showing progress as it goes; *Stop* finishes the post in
flight and keeps everything found so far.

The run **belongs to a task** (`tasks/begin` opens it before the first request),
which is what makes the rest work:

- every URL found in a post body is stored in `bsm.links` with its post, provider
  and creator, and joined to the task;
- posts already scanned are remembered, so a *Rescan* only visits new ones;
- each run is appended to the task's history, so "what did the last pass do?" has
  an answer even after the panel was closed.

Collecting the same creator again updates that task - new posts are added, nothing
is duplicated, and a browser-confirmed completion is retained (it does not verify contents).

### The task card

| Control | What it does |
| --- | --- |
| **Download missing (n)** | Queues new, failed and unverified links; browser-confirmed completions are skipped. Check unverified starts in Chrome Downloads before retrying to avoid duplicates. |
| **Pause** | Drops the task's files that are still waiting in the queue and returns them to "not downloaded". A download already in flight is not interrupted. |
| **Rescan** | Re-lists the creator, scans only posts it has not seen, and adds the files they link. |
| **Export package** | Writes both halves (below). |
| **✕** | Removes the task. Its files stay in the list, and anything downloaded stays on disk. |

The card's status line summarizes Chrome outcomes: **all completed**, **partial**,
**failed**, **downloading**, **idle** or **empty**. Completion does not establish
that the file's contents are correct or that it still exists on disk.

### The package ("send it to a friend")

*Export package* writes two files:

```
1245946_fanbox_task.json          ← the manifest: creator, service, site, a file
                                    entry per URL (post, provider, status, saved
                                    name), the summary and the run history
1245946_fanbox_download_links.txt ← the grouped list, still edible by a userscript
                                    or a download manager
```

*Import package…* (or the plain *Export .txt* / *Import* pair) reads **either
file**: the `.json` manifest, this extension's grouped `.txt`, a userscript
export, or a hand-written URL list (`#` lines are comments, bullets are stripped,
duplicates collapse). Detection is by content, never by extension.

What the other side gets is deliberately unglamorous and predictable:

- **one task**, named after the creator, with every file listed under its post;
- the task is **idle** - nothing downloads until someone presses *Download
  missing* (which then honours their own "Start downloading immediately" setting);
- locally browser-confirmed completions are **skipped**; old start-only records
  are unverified. A package from another machine does not prove a local file exists;
- re-importing the same package merges into the existing task and reports what is
  new, what is known and what was unreadable;
- nothing but the file crosses between the two people - no server, no account, no
  hash exchange. Each side downloads under its own rate limits.

A `.txt` with no creator in it (a hand-written list, a userscript export) still
works: the site is inferred from the post URLs in it, the creator from its
`# Creator:` header, and the name from its filename when neither exists. Those
links land in the task's file list; anything that belongs to no task is shown
under *Unfiled links*.

### Storing

| Store | Contents |
| --- | --- |
| `bsm.links` | The files: URL, provider, post context, status (`new`/`queued`/`done`/`failed`/`unverified`), saved filename, bytes, error. Capped at 20,000. |
| `bsm.tasks` | The tasks: identity, member ids, posts already scanned, run history. Capped at 500 tasks / 5,000 files each. |

Both are ordinary `chrome.storage.local` lists with the same promise as the queue:
closing the panel, reloading the page or restarting the worker keeps them. Every
mutation is serialised, so two queue workers finishing two files at the same
moment cannot lose one another's status change. A task whose last file is gone
(cleared, or removed by hand) is dropped, so no empty cards accumulate.

Known provider share pages (e.g. Mega and Drive) are rejected before download;
open or export those URLs for a provider downloader. Fragment keys are retained,
so exported lists can be sensitive. Unknown provider pages and redirects can still
produce HTML; the extension cannot verify their contents. Keyless old Mega links
must be recollected or re-imported with the key; incremental *Rescan* does not
revisit already-scanned posts, so use *Collect links* again for recovery.

### Why it is not a `.torrent`

Worth stating plainly, because the comparison is the reason the feature exists: a
torrent verifies file pieces against a hash in the file, and survives a dead
source through the swarm. Neither is possible here - the bytes live behind
Drive/Mega login walls that no browser download can walk through, and the sites
never publish a hash of the *mirrored* copy. What a package can honestly carry is
what the exporting machine saw: the URLs, the post each came from, and what
happened when it tried. `docs/TASKS.md` records this decision, and everything that
was considered and parked.

## History notebooks

Two small stores (`src/core/history.ts`), both in `chrome.storage.local`:

- `bsm.history` — Chrome-confirmed original downloads keyed `serverId:postId`
  (label, filename, timestamp, quality and confirmation). Old start-only or
  unknown-quality entries remain stored but cannot hide originals. No file hashes
  are checked. Capped at 5000 entries.
- `bsm.searches` — recent queries per server (capped by the setting, 500 overall).

Neither contains credentials. The only thing "Reset download history" changes is
what the *listing* shows; nothing is deleted from disk.

## Using the panel

1. Load the unpacked `dist/` folder, then click the toolbar icon (or *Open side
   panel* in the options rail). The panel opens next to the page.
2. On a booru page the context card names the matching profile; on a post page the
   "this post" card offers **Download this file** / **Add to list**.
3. Type tags, pick a page range, press **List this page** (or **Fetch selected
   pages** for a range). Rows appear ticked.
4. Untick what you do not want, then press **Download selected** on the dock. The
   queue keeps running while you browse — the status pill and the Queue badge stay
   live.
5. Deep links work: `panel.html#queue`, `#servers`, `#settings`.

### Preview harness

`npm run preview` serves the harness on <http://localhost:4173/>, which embeds
the real panel next to the options page and popup, backed by the offline mock
boorus. The buttons at the top switch the panel's simulated active tab
(`https://e621.net/posts/1500000` vs. a listing URL), which is exactly what the
panel reads in preview mode (`?tab=`).
