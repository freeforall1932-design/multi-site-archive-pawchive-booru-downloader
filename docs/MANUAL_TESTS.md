# Manual test plan

The automated suite covers the adapters, the shared services, the
panel's shared logic, the mirror-link rules, download tasks and the message
protocol. This document covers what only a
human can check: the real extension in a real browser, the UI states, and the
failure messages a user sees. This is a test plan, not a report of completed
live testing; the current Pawchive changes have not been tested against the live site.

Legend: **[V]** = can also be exercised in the offline preview harness
(`npm run preview`) without touching a live site. **[P]** = panel-specific; the
harness embeds the panel at a realistic 380 px with mock data, so it is the
quickest way to see it before installing.

---

## 0. Setup

1. `npm run verify` — type checks, build and tests must all pass.
2. `chrome://extensions` → *Developer mode* → **Load unpacked** → pick `dist/`.
3. Click the toolbar icon → the **side panel** opens (`uiMode: sidepanel`).
   The full manager is still one click away: right-click the icon → *Options*, or
   the panel's *Servers* tab, or *Open side panel* in the options rail.
4. Optional: `npm run preview` → open <http://localhost:4173> for the harness
   (real UI in iframes, mock booru APIs, demo credentials on the page, buttons to
   switch the panel's simulated active tab).

Test profiles you may want, in the order that makes later tests easy:

| Profile | site type | credentials |
| --- | --- | --- |
| `e621 main` | e621 | your username + API key, descriptive UA |
| `Danbooru main` | danbooru | your username + API key |
| `Gelbooru main` | gelbooru | API key + numeric user id |
| `e926 read-only` | e621 (base URL `https://e926.net`) | none |
| `Pawchive demo` | pawchive (base URL `https://pawchive.pw`) | none — creator archives are anonymous. In the preview this already exists as *Pawchive (demo creator)* |

---

## 0a. Pawchive and original-only checks (not yet performed live)

- With a permitted Pawchive profile, open a post exposing several original
  attachments. Press **Add all available files**, confirm the number of queued
  slots, then press **Download selected**. Check Chrome Downloads and the resulting
  image/video dimensions and files manually. No post HTML/text is expected.
- Check a preview-only/deferred attachment: it should be counted unavailable,
  not downloaded as a thumbnail. Check a creator listing expands file slots.
- Compare API fields for booru image/video samples with the URLs Chrome starts;
  confirm the original field is used. Test a post without an original: it must
  fail rather than fall back. This still does not prove every host's bytes.
- Recollect a Mega share with a fragment key; export/re-import both text and JSON,
  confirm the key survives, and use the provider site/downloader. Never publish
  private share keys when reporting results.
- Existing Pawchive queue rows from before the index update must be removed and
  re-added. Exercise history and retry with a deliberately interrupted browser
  transfer: it should become failed, never browser-confirmed history.

## 0b. Real Chrome completion and restart checks (not yet performed live)

These checks require the unpacked extension in Chrome and a permitted test host;
the offline preview simulates completion and cannot validate browser events.
Use files large/slow enough to observe the active state:

1. Start a direct post, a queued post, and a direct mirror file. Confirm each is
   running, not in completion history, until Chrome reports complete. Compare the
   displayed bytes with Chrome Downloads; an unknown total must not show a made-up
   percentage. After completion check history, mirror and task counters.
2. Interrupt a transfer in Chrome (or disconnect the network), check `failed`,
   no success history and retry; a resumed download in Chrome should update its
   existing row. Cancel one from the extension and verify Chrome actually cancels.
3. Stop the extension service worker from `chrome://extensions` during a transfer.
   Reopen the queue and confirm the same Chrome download ID is reconciled without a
   duplicate; also test a transfer that completes while the worker is stopped.
4. Clear the Chrome Downloads record of an active transfer (where possible). The
   extension must show unverified, not success. Old start-only rows/history must
   remain visible/retained and must not make skip-history hide originals. Check the
   actual file before retrying any unverified row.
5. Confirm clear/remove leaves in-flight rows tracked. Pause stops new starts, not
   existing Chrome transfers. Confirm that browser completion alone does not claim
   a hash or validate response contents.

## 1. Side panel [P]

`[P]` = do this in the real browser (load `dist/` unpacked); the preview harness
covers the same flow with mock data.

1. Click the toolbar icon → the **side panel** opens next to the page. Status pill
   reads *Ready*; the tab strip shows Browse · Queue · Servers · Settings.
2. **Context card.** Open `https://e621.net/posts/<id>` (or a mock URL in the
   harness) → the card names the matching profile and its route (`post #12345`).
   Press ⟳ with a non-booru tab active → the card says the page is not a supported
   booru, and the search box still works.
3. **Post card.** On a post page the card shows a thumbnail, rating chip and size,
   with *Download this file* / *Add to list*. After a download the row shows a
   `completed …` badge only after Chrome reports completion; after *Add to list*
   the button becomes *In the queue*.
4. **Listing.** Type `cityscape` and press *List this page* → rows appear in the
   list below, all ticked, and the dock button reads *Download selected (n)*. The
   hint says how many rows were added and how many were skipped.
5. **Page ranges.** Switch to *advanced*, enter `2,4` and press *Fetch selected
   pages* → the progress bar walks both pages. Enter `abc` → the hint turns red and
   *Fetch selected pages* is disabled. Enter `1-9999` with *Pages per fetch* = 150 →
   the message explains the cap.
6. **Filters.** Set *Media* to *Videos only* → pictures disappear from the list.
   Leave *Skip posts previously completed* off (the default), re-run a search you
   already completed → rows return with a `completed` badge.
7. **Selective run.** Untick one row, press *Download selected (n)* → only the
   ticked rows run; the unticked row stays `queued`. Press *Start queued (1)* on
   the dock → it downloads too.
8. **Dock controls.** Change *Start workers* → the setting persists. The dock
   says original-only; there is no sample-quality switch. For a post with distinct
   original and sample video/image URLs, verify the request uses the original.
9. **Row actions.** ✕ on a queued row removes it from the list (the file on disk is
   untouched); ✕ on a running row cancels just that download. *Retry failed*,
   *Clear finished*, *Reset history* and *Clear list* each report what they did.
10. **Settings tab.** Every section has a heading and a hint. Change *Theme* → the
    panel switches immediately. Tick `{artist}` in the template editor → the
    *Example* line updates. Clear the file-name box and type `post-{id}` → the
    *custom template* warning appears and the value is kept.
11. **Toolbar mode.** Settings → *Toolbar click opens* → *Popup*. Click the toolbar
    icon → the popup opens. Reload the extension → the popup is still the target
    (the worker re-applies the stored choice). Switch back to the panel.
12. **Deep links.** Open `panel.html#queue` (or use the harness button) → the panel
    opens on the Queue tab; `#settings` likewise.

## 1a. Preview harness [V]

| # | Steps | Expected |
| --- | --- | --- |
| 1.1 | `npm run preview`, open the harness page | Options + popup iframes render; the harness documents demo credentials and `force:*` directives |
| 1.2 | In the options frame, go to **Browse**, search `cat` | 24-post mock dataset, tiles show previews and rating chips |
| 1.3 | Add a server in the options frame, then reload the page | The new server is still there (shared `localStorage` namespace) |
| 1.4 | Add a server in the options frame, open the popup frame | The same server list appears in the popup (shared state) |
| 1.5 | Press **Reset preview data** on the harness page | Page reloads; the five demo servers are back (e621, Danbooru, Gelbooru, e926, Pawchive) and no user changes remain |
| 1.5a | Open the panel iframe on the **Links** tab and collect `fanbox/1245946` | The demo creator's posts are scanned offline and their mirror links (Mega, Drive, Pixeldrain, MediaFire, Catbox, Dropbox) are collected - see section 5a |
| 1.6 | Search with tag `force:429` | Red error chip: *Rate limited* + a hint about lowering the request interval |
| 1.7 | Search with tag `force:401` | *Authentication failed* (not an endpoint message) |
| 1.8 | Search with tag `force:html` | *Endpoint mismatch* — explains the base URL points at a web page |
| 1.9 | Validate the seeded e621 profile | Success message naming `demo_e621`; the timestamp updates |

---

## 2. Server list [V]

| # | Steps | Expected |
| --- | --- | --- |
| 2.1 | First run, no profiles | Empty state: *Add server* plus per-site “Add e621 / Add Danbooru / Add Gelbooru” shortcuts |
| 2.2 | Add profile 1 | It becomes the default automatically (`DEFAULT` chip) |
| 2.3 | Add profile 2 | Profile 1 stays the only default; the list shows site type, base URL, rating filter state, login state |
| 2.4 | Press **Set default** on profile 2 | Exactly one default chip; order stays stable |
| 2.5 | Press **Test** on a valid profile | Button shows a busy state, then the row’s status chip becomes green (*Endpoint and credentials OK — signed in as …*) with the current time |
| 2.6 | Press **Test** on a profile with a deliberately wrong key | Red chip *Authentication failed* and the reason is inside the row tooltip/message; no key text anywhere |
| 2.7 | Press **Duplicate** on a profile | A copy appears: label suffixed *copy*, not default, validation reset to unknown, credentials present (`hasApiKey`), no full key visible |
| 2.8 | Press **Delete** on the current default | Row disappears, the next profile is promoted to default automatically |
| 2.9 | Press **Delete** on the last profile | Empty state returns, no errors in the console |

---

## 3. Add / edit form and validation matrix [V]

Open *Servers → Add server* and confirm:

- **Fields**: site type selector, label, base URL, rating-filter toggle + allow-list,
  username, API key, user id, custom User-Agent, plus the site’s helper texts.
  The field set is generated from the adapter (`credentialFields()`), so e621 shows
  a User-Agent hint, Gelbooru shows *user id (numeric)*, Danbooru shows neither.
- **Base URL** is pre-filled with the site default and can be edited (fork/instance).
- **Use suggested** fills a descriptive User-Agent (never a browser-looking string).

Then run the validation matrix. Expected *reason* text, not just red/green:

| # | Scenario | Expected result |
| --- | --- | --- |
| 3.1 | Correct credentials, correct base URL | Success; account name is displayed (e621/Danbooru) or the profile is marked read/write (Gelbooru) |
| 3.2 | Wildly wrong API key | **Authentication failed** — “rejected the credentials (HTTP 401)”, hint mentions re-copying the key |
| 3.3 | Correct key, wrong **username** (e621/Danbooru) | **Authentication failed** (401) |
| 3.4 | Base URL pointing at the site *web page* (e.g. `https://e621.net/posts`) | **Endpoint mismatch** — HTML/404 message, hint about the base URL |
| 3.5 | Base URL of an unrelated host that answers with HTML | **Endpoint mismatch**, never “authentication failed” |
| 3.6 | Base URL of a host that does not resolve / offline | **Network failure** — DNS/offline wording |
| 3.7 | Gelbooru profile with user id but no API key | **Incomplete configuration** — the pair is required together |
| 3.8 | Site that returns 429/503 (e.g. validate e621 repeatedly, or `force:429` in the harness) | **Rate limited** — distinct message and hint, not auth/endpoint |
| 3.9 | Credentials left blank entirely | Validation succeeds as a **read-only** profile with a warning |
| 3.10 | e621 profile with a `Mozilla/5.0 … Chrome/…` User-Agent | Success plus a warning that a browser-like UA violates the site policy |
| 3.11 | Plain `http://` base URL | Success plus a plain-HTTP warning |
| 3.12 | Cancel while validation is running | UI returns to idle; no unhandled rejection in the console |

Form behaviour:

| # | Steps | Expected |
| --- | --- | --- |
| 3.13 | Edit an existing profile | Fields are pre-filled; the API key shows the masked placeholder, leaving it untouched keeps the stored key |
| 3.14 | Save with a failed validation | Warns and offers **Save anyway**; the failure reason is stored on the profile |
| 3.15 | Change the base URL or credentials and save | Validation state resets to unknown (old success must not be trusted) |
| 3.16 | Reload the options page | The last validation result, message and timestamp are still shown |

---

## 4. Browse [V]

| # | Steps | Expected |
| --- | --- | --- |
| 4.1 | *Browse* → choose a server, search a common tag | Grid of posts with previews, ratings, dimensions, post links |
| 4.2 | Search `-rating:explicit` on a site whose filter allows explicit | Results contain no explicit posts |
| 4.3 | Toggle the rating filter off in the browse toolbar | The filter is preserved per server config and the applied tags are shown |
| 4.4 | Press **Load more** | Next page appends (e621 uses page tokens; Danbooru/Gelbooru use `page`/`pid`) |
| 4.5 | Search nonsense tags | Empty state, no error |
| 4.6 | Search `force:html` (preview) | Red *Endpoint mismatch* error, retry possible |
| 4.7 | Select two posts → **Queue selected (2)** | Toast/confirmation and the queue tab shows the two items |
| 4.8 | Press **Download** on one post | Original-file request starts and appears in the queue; the completed badge/history appears only when Chrome reports completion. Verify actual content separately. |

## 5. Queue [V]

| # | Steps | Expected |
| --- | --- | --- |
| 5.1 | Queue 5 posts → **Start** | Items progress pending → running → done; summary counters update; the button shows *Running…* |
| 5.2 | Press **Pause** mid-run | No new items start; running items finish |
| 5.3 | **Resume** | Work continues |
| 5.4 | Cancel a pending item | Status becomes *canceled*, counters update |
| 5.5 | Queue the same post twice (via browse + popup) | Second attempt is ignored as a duplicate (pending/running de-duplication) |
| 5.6 | Queue an explicit post on a safe-only profile | It is reported as skipped by the rating filter, not downloaded |
| 5.7 | Break a profile’s key, then run its queue | Items fail with the *Authentication failed* kind; error text contains no credentials |
| 5.8 | **Retry failed / unverified** | Failed or unverified items return to pending after confirmation; check ambiguous old starts first to avoid duplicates. |
| 5.9 | **Clear completed** / **Clear all** | Matching inactive rows disappear; active transfers remain tracked. |
| 5.10 | Close the options page and restart the extension worker during a slow transfer | The saved Chrome ID is reconciled; no duplicate is started. The row becomes completed or failed only when Chrome reports it. |
| 5.11 | Queue a post on a server whose profile was deleted meanwhile | Skip with *Unsupported site type* reason instead of an infinite retry loop |

## 5a. Mirror links (Links tab) [V]

The preview harness ships a demo creator whose posts carry mirror links, so the
whole flow - collect, queue, export, import - can be walked without a live site.
On a real profile, only `pawchive` can collect (the tab says *archive API*);
booru and discontinued archive profiles do not enable collection. Old profiles
remain exportable/deletable but cannot be selected or made the default.

| # | Steps | Expected |
| --- | --- | --- |
| 5a.1 | Panel → **Links**, pick the Pawchive profile | Card renders with an empty state; *Collect links* stays disabled until a query is typed |
| 5a.2 | Type `fanbox/1245946`, press **Collect links** | Progress strip ("Scanned n/N"), then rows grouped under post titles; summary reads `6 collected`, and every provider row has a badge (Mega, Google Drive, Pixeldrain, MediaFire, Catbox, Dropbox) |
| 5a.3 | Inspect the collected rows | No `pawchive.pw` or `n1.pawchive.pw` rows (the site's own files are ordinary post downloads) and no `example.com/gallery/1234` row (the default filter keeps downloads only) |
| 5a.4 | Press **Stop** mid-collection | It stops after the post in flight; everything found so far is kept and the button returns to *Collect links* |
| 5a.5 | Settings → *Mirror links* → set **Only download-looking links** to *Every external link*, re-collect | The gallery link now appears; the toolbar button in the Links tab reads `filter: every external link` |
| 5a.6 | Tick a few rows → **Add to download queue (n)** | Toast; the Queue tab shows the rows with a `link` badge; the Links rows read *in the queue*; nothing hits the site's own API |
| 5a.7 | Run the queue | Direct file URLs start under `mirrors/<host>/…`, and remain queued until Chrome reports their outcome; known share pages fail with an open/export message. Preview completion is simulated. |
| 5a.8 | **Export .txt** (grouped by post) | A `<creator>_download_links.txt` file downloads; it starts with `# Booru Server Manager — collected mirror links`, lists `# Post: <title> — <url>` sections and one `- <url>` line per link |
| 5a.9 | **Clear list** → confirm | The list empties; pending link rows leave the queue; a running download is not killed; the file on disk stays |
| 5a.10 | **Import .txt…** → pick the file just exported | Rows come back grouped by their post titles, summary matches the export, the dock notice reports how many were added/known/unreadable; new rows arrive ticked |
| 5a.11 | Press **Add to download queue (n)** right after importing | The imported URLs queue (and download) exactly like collected ones - no profile is needed for the rows themselves |
| 5a.12 | Import a hand-written list (`Mega link`, a plain URL, a `•` bullet, a nonsense line) | Valid URLs are added regardless of provider, the nonsense line is counted as unreadable, nothing throws |
| 5a.13 | Reload the panel (and the browser) | The collected list and each row's status (queued/done/failed, saved filename) are still there - `bsm.links` is persistent storage |
| 5a.14 | Feed a userscript export (the `Creator:`/`Collected:` preamble, bare URLs) into **Import .txt…** | It imports: `#` lines are comments, bullets are stripped, duplicates collapse |
| 5a.15 | Set **Mirror folder template** to `mirrors/{provider}/{date}` and queue one link | The saved path follows the URL tokens (`mirrors/Mega/2026-09-29/<name>`), not the post's naming template |

## 5b. Download tasks and the package [V]

The preview's demo creator is enough to walk the whole "send it to a friend" flow:
collect, download the missing files, pause, rescan, export the package, then import
that same file into a **fresh** preview (Reset preview data clears it) and watch it
come back as one idle task.

| # | Steps | Expected |
| --- | --- | --- |
| 5b.1 | Links tab → *Collect links* for `fanbox/1245946` | One **task card** appears, named `1245946 · fanbox`, with a `pawchive` / `fanbox` badge, `n/n file(s) completed`, and a *Download missing (n)* button |
| 5b.2 | Click the ▸ on the card | The card expands into one row per file, each with its provider badge, its post, its status and its URL |
| 5b.3 | Press **Download missing (n)** | Direct links remain queued until Chrome completes or interrupts them; known share pages fail with an open/export message. |
| 5b.4 | Press it again | Browser-confirmed completions are skipped; failures and unverified starts can be retried. Content/hash verification is not inferred. |
| 5b.5 | **Pause** while files are queued | The task's waiting files leave the queue, the card goes back to "n not downloaded" and the button says *Download missing* again; a download already running is not killed |
| 5b.6 | Break one link's host (edit the row's URL in devtools, or import a list with a dead URL), then Download missing | Only that file fails; the card reads **partial - some files failed**, the file keeps its error text, and the next *Download missing* queues the failed file again (and never the saved ones) |
| 5b.7 | **Rescan** a task that was collected already | "0 new post(s) scanned" — the second pass is incremental, it does not walk the creator again from scratch |
| 5b.8 | Reload the panel and the browser | Task, files, statuses, run history and card expansion state survive (`bsm.tasks`, `bsm.links`) |
| 5b.9 | **Export package** | Two files download: `<name>_task.json` (manifest with `files` and `runs`) and `<name>_download_links.txt` (grouped list). Both open as plain text |
| 5b.10 | Open the manifest in a text editor | Readable: `format`, `task` (id/name/site/service/creator), `summary` (total/done/failed/pending/completion), `files` (url, provider, post, status, filename) and `runs` |
| 5b.11 | Harness page → **Reset preview data**, then Links tab → *Import package…* → pick the `.json` | One task comes back, **idle**, with the same name and file count; the notice reports how many were new vs already known; nothing downloads |
| 5b.12 | Press **Download missing** on the fresh copy | It queues every file (no server/profile is needed on this side at all) and the queue downloads them slowly |
| 5b.13 | Import the same package a second time | Merges into the same task: `0 new`, everything reported as already known, statuses unchanged |
| 5b.14 | Import only the `.txt` half | The same task id is used (the site comes from the post URLs), the files keep their post titles, and they group by post in the expanded card |
| 5b.15 | Import a userscript export (`Creator:`/`Collected:` preamble, bare URLs) | It imports as a task named after its creator header; `#` lines are ignored, bullets stripped |
| 5b.16 | Import a hand-written list with no creator (`artist_a_links.txt`) | The task is named `artist a`, its links are "unfiled" until re-imported as a package, and nothing throws on a nonsense line (counted as unreadable) |
| 5b.17 | Remove a task with ✕ | The card disappears, the files stay in the list (and on disk); *Clear list* then removes the files and drops any task with nothing left |

## 6. Downloads and naming [V]

| # | Steps | Expected |
| --- | --- | --- |
| 6.1 | Default templates | Files land in `Downloads/booru/<siteType>/<id>_<md5>.<ext>` |
| 6.2 | Set folder `booru/{siteLabel}/{rating}`, filename `{artist}-{id}` | Paths match, illegal characters replaced, unknown tokens collapse quietly |
| 6.3 | Template producing a very long filename (`{tag1}_{tag2}_…`) | Filename is capped (~180 chars) and a warning explains the shortening |
| 6.4 | Template with `../` or `..\` | Traversal is neutralised; the file still lands inside the download folder |
| 6.5 | Download the same post twice | The second file is uniquified (`… (1).jpg`), nothing is overwritten |
| 6.6 | Post with a video extension | `{isVideo}` renders `video`; the file downloads normally |

## 7. Settings [V]

The options page and the panel's Settings tab render the same sections; check one
of each area rather than all of them twice: *Global behaviour* (toolbar mode),
*Multiple download* (concurrency, spacing, retries, duplicates), *Mirror links*
(filter, extra hosts, folder template), *List results*
(media filter, page cap, queue rows, skip downloaded), *Search behaviour* (suffix,
blacklist, search history), *Name template* (checkboxes + custom + preview),
*Interface*, *Advanced behaviour*, *Server credentials*, *Download history*.

| # | Steps | Expected |
| --- | --- | --- |
| 7.1 | Change templates/concurrency | **Save settings** persists; reopening the page keeps them |
| 7.2 | **Reset to defaults** | Defaults restored |
| 7.3 | Turn off *Enforce rating filter on download* | A single post download of an excluded rating now succeeds |
| 7.4 | Turn off *User-Agent rewriting* then press **Re-sync User-Agent rules** | Report shows 0 rules applied; e621 requests fall back to `_client` |
| 7.5 | **Export servers (no keys)** | JSON download contains no credential values (open the file and search for the key) |
| 7.6 | **Export with keys** | Explicit confirmation first; the file then contains the keys — handle with care |
| 7.7 | **Import servers** with an exported file | Profiles appear, exactly one default, duplicates handled gracefully |
| 7.8 | Import the same file twice | No duplicated profiles (or a clear skipped count) |
| 7.9 | **Delete all stored keys** | Every profile reports `hasApiKey = false`; validation switches to read-only |
| 7.10 | Theme switch | Light/dark/system applies immediately |

## 8. Diagnostics [V]

| # | Steps | Expected |
| --- | --- | --- |
| 8.1 | Open *Diagnostics* | Version, environment, storage keys, adapter catalog (site, auth style, limits, docs link) and saved servers |
| 8.2 | Validate a profile, then open Diagnostics | This profile’s probe trace is listed: probe label, redacted URL, status, duration, interpretation |
| 8.3 | **Copy diagnostics** | Clipboard contains a report; paste it and search for the API key **and** its last 4 characters → no matches |
| 8.4 | Check the browser console for every flow above | No credential values, no unhandled errors |
| 8.5 | Custom/fork host without host permission | Diagnostics shows the granted/permission-needed state, with a **Grant access** action |

## 9. Popup and page flow (real browser)

The popup's *Panel* button opens the docked panel (`chrome.sidePanel.open`, which
needs the click as its user gesture); on a browser without the sidePanel API the
button falls back to the options page.

| # | Steps | Expected |
| --- | --- | --- |
| 9.1 | Open a supported **post** page (e621/Danbooru/Gelbooru) in the active tab | Popup shows *This page* with the detected site, matching server (or an “add this site” prompt), and the post card |
| 9.2 | Press **Download** | Popup reports the start and filename; the queue tracks the Chrome completion or failure. Verify the file content separately. |
| 9.3 | Press **Queue** | Item appears in the queue footer; *Start* runs it |
| 9.4 | Open a **tag/search** page instead | Popup offers *Search these tags* against the matching server |
| 9.5 | Open an unrelated page | Popup reports that the page is not a supported booru page, and offers the manager |
| 9.6 | No servers configured at all | Popup shows the empty state with **Open server manager** |

## 10. Content-script button

| # | Steps | Expected |
| --- | --- | --- |
| 10.1 | Enable *Show the on-page download button* (Settings), open a post page | Floating “⬇ Download with Booru Manager” button appears (shadow DOM, page styles unaffected) |
| 10.2 | Press it | Button text → *Downloading…* → success message with the filename |
| 10.3 | Press it twice | Second press re-downloads (uniquified file) and reports accordingly |
| 10.4 | Disable the setting and reload the page | Button no longer appears |
| 10.5 | Open a post page from a host with no saved profile | Button reports that no server matches the page (link to the manager) |

## 11. Regression checklist for a new site adapter

1. Add the adapter file + registration line, then `npm test` — the conformance
   suite must pass without touching shared code.
2. New site type appears in *Add server* automatically (no UI change was made).
3. Add a profile, validate it, browse it, download one post, queue three.
4. Confirm the failure matrix in section 3 holds for the new site (wrong key,
   wrong base URL, offline, throttling).
5. Update the README table and `docs/ARCHITECTURE.md` notes.

## 12. Cleanup

- Delete test profiles (or **Delete all stored keys**), then check
  `chrome://extensions` → *Details → Site access* to revoke any host permissions
  you granted for custom instances.
- Preview harness: press **Reset preview data** (or clear `bsm-preview:*` keys in
  DevTools → Application → Local Storage).
