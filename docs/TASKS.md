# Download tasks ("torrent-like" packages) — design archive + decisions

This document keeps **every** design idea for turning a collected link list into a
torrent-style *job* that can be handed to another person, plus the trade-offs, and
records which design is implemented **now** ("stable first") and which are parked.

Status: **v1 implemented** (see `src/core/tasks.ts`, `src/core/task-store.ts`,
`src/core/router.ts` → `tasks/*`, `src/ui/panel-links.ts`).
The parts marked *parked* are decisions, not omissions — they need more than a UI
to be honest.

**Current limitation:** `done` means Chrome reported completion, not that file
contents were hashed, the response was genuine media, or the file still exists.
Interrupted transfers are failures; old start-only records and lost browser IDs
are unverified. Known Mega/Drive and other share pages are open/export-only;
provider resolution and decryption are not implemented. Unknown interstitials can
still be saved as HTML. Exported URLs may contain private fragment keys.

---

## 1. The analogy, restated precisely

> "I export a small file that carries the information — links, artist, etc. I send
> it to a friend. He has the same extension, opens it, picks the file, and it shows
> **one task: artist A**. Clicking the task shows the brief: how many files, what
> it is doing, what already worked."

Read as a specification, that is a **job manifest + job view + job-level
controls**, with the concrete behaviours the user then named:

- *traceable* — the task remembers **artist, service, site, post** for every file;
- *re-runnable* — collect/rescan for new links, then download missing or failed
  entries without re-queueing browser-confirmed completions. The extension cannot
  verify what still exists on disk; unverified starts can duplicate a file;
- *stateful per file* — `done` / `failed` / `queued` / `new`, with the saved
  filename and any error, so "complete", "partial success" and "failed" are
  distinguishable at the task level;
- *idle by default* — the task arrives paused, with a Start and a Pause;
- *self-contained* — nothing but the file crosses between the two machines; the
  friend's extension does the fetching under **its own** rate limits.

## 2. Questions that had to be answered, and every option considered

### 2.1 What is one task?

| Option | Behaviour | Verdict |
| --- | --- | --- |
| **(a) One task per artist/creator** | A file for one artist = one task named after them, exactly like one `.torrent`. Multi-artist file → one task each. | **Chosen.** It is the unit the user names ("artist A"), it is the unit a rescan can refresh (a creator's post list), and it is the unit whose completeness is meaningful. |
| (b) One task per imported file | Whatever the file contains becomes one task. | Rejected as the primary unit: one file can legitimately cover several creators, and "download all again" would then have no creator to re-list for new posts. |
| (c) One task per post | Fine-grained. | Rejected: an artist with 300 posts becomes 300 tasks — the opposite of "one task: artist A". *Kept as the drill-in level* (a task's files are grouped by post). |
| (d) Hybrid (user's own answer) | Task per artist, but each task *traces* site + service + artist + post, per-file outcome, and can be re-run. | **This is what (a) became.** The task id is `site:service:creator`, and every member file keeps `postId`/`postUrl`/`postTitle`. |

### 2.2 What is the exported file?

| Option | Behaviour | Verdict |
| --- | --- | --- |
| (a) Richer `.txt` only | Task blocks in plain text, hand-editable. | Partially kept: the `.txt` still exists inside the package because userscripts and download managers read it. |
| (b) `.json` manifest only | Machine-readable, no editor-friendliness. | Rejected alone: a human should be able to open the file and read it. |
| **(c) Both, in one action** | The export produces a **package**: a `.json` manifest (the job, with metadata) **and** the grouped `.txt` (the plain list). Import accepts either, and accepts either half on its own. | **Chosen** (user's answer: *both*). "Pick from file" therefore works whether the friend was handed the package or just printed the URL list. |
| (d) Binary/`.torrent`-like | A single opaque file. | Parked: nothing to gain, plenty to lose (no hand-editing, no diffing, no userscript interop). |

The manifest format is versioned (`format: "booru-server-manager.task"`,
`version: 1`) so a future change can migrate instead of breaking.

### 2.3 What happens when the friend imports it?

| Option | Behaviour | Verdict |
| --- | --- | --- |
| (a) Always idle | Task lands paused with a Start button. | **Chosen default.** Nobody's bandwidth or a volunteer site's rate limit should be spent because a file was opened. |
| (b) Always auto-start | Like a torrent client with auto-start. | Rejected on import. The **Start downloading immediately** setting only controls whether the queue starts after an explicit Download missing action. |
| (c) Ask every time | A prompt. | Parked: a prompt on import is noise once (a) and (b) are both reachable from settings. |
| **(d) Idle + explicit Start/Pause (user's answer)** | Lands idle; one button starts everything missing; Pause returns it to idle and can be resumed later. | **Chosen.** Pause cancels the task's pending queue rows, so "paused" means paused — the files already saved stay saved, and Start later picks up exactly where it stopped. |

### 2.4 Where does the task list live?

| Option | Behaviour | Verdict |
| --- | --- | --- |
| **(a) Rework the Links tab into task cards** | Collect runs and imports are the same thing: a list of jobs, each expandable. Raw links that belong to no task stay below in a small "unfiled links" card. | **Chosen now** — most stable: no new surface, reuses the existing store, rows and message plumbing, and keeps the userscript `.txt` flow working untouched. |
| (b) A 6th tab ("Tasks") | Tasks get their own surface; Links stays the flat list. | Parked: costs a tab and a second home for the same data; worth it only if tasks grow controls that do not belong in Links (queues of tasks, scheduling). |
| (c) Task rows inside the Queue tab | One row per task that expands into its files. | Parked: the queue is a *work* list — rows there are downloads that exist right now. A task with nothing queued would be a row that does nothing, and `queue/run { itemIds }` semantics would blur. |

## 3. The stable design that is implemented now

```
Links tab
├─ Import package (.json / .txt)        ← "pick from file"
├─ Task: Artist A · fanbox · pawchive        3 / 6 done · 1 failed · idle
│    [ Download missing (3) ] [ Pause ] [ Rescan for new posts ] [ Export ] [ Remove ]
│    last scan 2 minutes ago · 2 runs recorded
│    ▸ (expand) files grouped by post, each with its own row status + saved name
└─ Unfiled links            (a bare .txt import, or links collected without a task)
```

**Task identity** `site:service:creator` (e.g. `pawchive:fanbox:1245946`) — a
stable key, so re-importing the same package, or collecting the same creator
again, **merges into the existing task** instead of duplicating it.

**Per-file state** lives in the existing link store (`bsm.links`): `new`,
`queued` (including browser transfers in progress), `done` (Chrome reported
complete), `failed` (start or transfer error), and `unverified` (old start or
missing browser record). The task holds the member ids, keeping rescans idempotent.

**What "Download missing" queues** (`planTaskRun`): every member that is not
`done` — i.e. `new`, `failed` **and** `unverified` (a retry is the same button;
check unverified files in Chrome first to avoid duplicates). `done` members
are never re-queued unless the user asks for a full re-run (`mode: 'all'`, which
still honours the "if the file exists" download setting).

**Transfer-state classification** (`taskCompletion`): `complete` (every member
reported complete by Chrome) · `partial` (some complete, others not) · `failed`
(none complete, some failed) · `in-progress` (something queued or downloading) ·
`idle` · `empty`. These are browser outcomes, not file-content verification.

**Re-run strategy for new posts** — *Rescan*: re-lists the creator through the
site API, scans only posts it has not scanned before (or whose links are not
stored yet), adds the new files, and **records a run** (`TaskRun`: when, how many
posts scanned, how many links added, how many queued, done, failed). Runs are the
task's history: "I already ran this on the 12th, three files failed, the rest
came in".

**Both files on export** (the user's "both"): `<task>.task.json` (manifest) and
`<task>_download_links.txt` (grouped list). Import detects either by content, not
by extension, and accepts:
- a package (json) → task + members + recorded metadata;
- a grouped `.txt` from this extension → task named from the `# Creator:` header;
- a bare URL list (userscript export, hand-written) → a task named from the
  filename, or unfiled links when there is no creator to name it after.

**Pause = cancel pending rows of this task.** Running downloads are never killed
mid-file; waiting members fall back to `new`, while an active transfer remains
tracked and may keep the task in progress. Start later queues the remaining work.

## 4. Parked ideas (kept deliberately)

| Idea | Why it is parked |
| --- | --- |
| **Content hashes / piece verification** | A `.torrent` can verify pieces because the swarm has the data. Here the only authority is the hosting page: Drive/Mega links are opaque, and the booru rarely publishes a hash of the *mirrored* file (Pawchive posts can publish a SHA-256 for the site's own copy, which the adapter already surfaces). Real verification needs a resolver per provider — a project of its own. Until then the manifest carries `bytes`/`filename` as *observations*, never as proof. |
| **Per-file pre-known size / total size** | Providers only reveal the size during the download. A task therefore shows `files 3/6` immediately and a size only for files that have finished (or when a site reports it). Showing a fabricated total would be dishonest. |
| **Task-level scheduling** (start at a time, per-task concurrency, queue of tasks) | Needs the queue to gain task-aware priorities; the current per-server rate limiter already covers the "slowly" requirement. |
| **Task sharing beyond a file** (a swarm, magnets, a server) | Out of scope on principle: the extension has no backend, and the request rate belongs to each user. |
| **Tasks for non-archive sites** | A tag search ("all `artist_x` posts on e621") could be a task too. The task model is site-agnostic already; only the UI's collect flow assumes Pawchive. |
| **A 6th tab / queue lens** | See 2.4 — revisit if the task list grows its own vocabulary. |

## 5. Data model (for implementers)

```ts
DownloadTask {
  id: 'pawchive:fanbox:1245946'   // site : service : creator (or site:query)
  name, siteType, serverId, service, creator, query
  createdAt, updatedAt, lastScanAt
  memberIds: MirrorLink['id'][]   // the files; state lives in bsm.links
  runs: TaskRun[]                 // traceability: what each run did
  scannedPosts: string[]          // post ids already scanned, so Rescan is incremental
}
TaskRun { id, startedAt, finishedAt, scannedPosts, added, queued, done, failed, note }
```

Storage: `bsm.tasks` (`src/core/task-store.ts`), next to `bsm.links`, `bsm.queue`,
`bsm.history`. Tasks and manifests can contain private share URLs, bearer tokens
and Mega decryption fragments. Treat exports as sensitive even if the same URLs
are visible in the panel.
