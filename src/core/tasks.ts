/**
 * Download tasks: the portable "job" behind the Links tab.
 *
 * A task is one creator on one site plus the files that belong to them - the
 * extension's answer to a `.torrent`. Everything in this module is **pure**:
 * planning a run, classifying a task's completeness, and turning a task into the
 * package that gets sent to another person (and back).
 *
 * Why a task exists at all: a flat URL list cannot answer the three questions the
 * user actually asks - *is this artist finished?*, *which files failed?*, and
 * *what is new since last time?* - because it has no identity, no history and no
 * memory of what was already scanned.
 *
 * The package is deliberately two files in one action:
 *   - `<name>.task.json`  - the manifest: creator, service, site, every file with
 *     its post, provider and the outcome that was known when it was written;
 *   - `<name>_download_links.txt` - the grouped list, still edible by a userscript
 *     or a download manager, and still importable on its own.
 * `parseTaskPackage` reads either half, so a friend can be handed either file.
 */
import type {
  DownloadTask,
  MirrorLink,
  MirrorLinkStats,
  SiteType,
  TaskCompletion,
  TaskRun,
  TaskStats,
} from '../shared/types.js';
import { mirrorLinkId } from './links.js';
import { uniqueBy } from '../shared/util.js';

/** What `formatTaskManifest` writes in the `format` field. */
export const TASK_FORMAT = 'booru-server-manager.task';
/** Bump when the manifest shape changes in a way a reader must notice. */
export const TASK_FORMAT_VERSION = 1;

export function emptyStats(): MirrorLinkStats {
  return { total: 0, new: 0, queued: 0, done: 0, failed: 0, unverified: 0 };
}

export interface TaskIdentity {
  siteType?: SiteType | string | null;
  service?: string | null;
  creator?: string | null;
  /** Fallback when there is no creator to key on (a bare URL list, a tag search). */
  query?: string | null;
}

/**
 * Stable task id.
 *
 * `site:service:creator` is what makes a second import, or a second collect of
 * the same creator, *merge* instead of creating a second job. When a file carries
 * no creator (a hand-written URL list) the id falls back to the query, and
 * finally to a hash of nothing at all - "unfiled".
 */
export function taskIdFor(identity: TaskIdentity): string {
  const site = (identity.siteType ?? 'link').toString();
  const service = (identity.service ?? '').trim().toLowerCase();
  const creator = (identity.creator ?? '').trim();
  if (creator) return [site, service || 'na', creator].join(':');
  const query = (identity.query ?? '').trim();
  if (query) return `${site}:query:${query.toLowerCase().replace(/\s+/g, '_')}`;
  return `${site}:unfiled`;
}

/** Human name for a task: what the friend sees first. */
export function taskNameFor(identity: TaskIdentity & { name?: string | null }): string {
  if (identity.name?.trim()) return identity.name.trim();
  const creator = identity.creator?.trim();
  const service = identity.service?.trim();
  if (creator) return service ? `${creator} · ${service}` : creator;
  const query = identity.query?.trim();
  if (query) return query;
  return 'Imported links';
}

/** `service/creator` as the site spells it - what the panel's search box takes. */
export function creatorQuery(task: Pick<DownloadTask, 'service' | 'creator' | 'query'>): string {
  if (task.service && task.creator) return `${task.service}/${task.creator}`;
  if (task.creator) return task.creator;
  return task.query;
}

/** Split `fanbox/1245946` (or a creator URL) into the parts a task keys on. */
export function parseCreatorQuery(query: string): { service: string | null; creator: string | null } {
  const text = (query ?? '').trim();
  const fromUrl = /(?:^|\/)([a-z0-9_-]+)\/user\/([^/?#\s]+)/i.exec(text);
  if (fromUrl) return { service: fromUrl[1]!.toLowerCase(), creator: fromUrl[2]! };
  const short = /^([a-z0-9_-]+)\/([^/\s]+)$/i.exec(text);
  if (short) return { service: short[1]!.toLowerCase(), creator: short[2]! };
  return { service: null, creator: null };
}

// ------------------------------------------------------------------- statistics

/** Add up what a task's files are doing, from the stored link records. */
export function taskStatsFor(task: DownloadTask, links: readonly MirrorLink[]): TaskStats {
  const wanted = new Set(task.memberIds);
  const mine = links.filter((link) => wanted.has(link.id));
  const stats: TaskStats = { total: mine.length, done: 0, failed: 0, queued: 0, unverified: 0, pending: 0, bytes: null };
  let bytes = 0;
  let sized = false;
  for (const link of mine) {
    if (link.status === 'done') stats.done += 1;
    else if (link.status === 'failed') stats.failed += 1;
    else if (link.status === 'queued') stats.queued += 1;
    else if (link.status === 'unverified') stats.unverified += 1;
    if (link.status !== 'done') stats.pending += 1;
    if (link.status === 'done' && typeof link.bytes === 'number') {
      bytes += link.bytes;
      sized = true;
    }
  }
  stats.bytes = sized ? bytes : null;
  return stats;
}

/**
 * The headline: complete, partial, failed, in progress.
 *
 * `partial` earns its own state - "some came in, some did not" is the normal
 * outcome of a run against volunteer hosting, and a task stuck on "failed" would
 * misrepresent it.
 */
export function taskCompletion(stats: TaskStats): TaskCompletion {
  if (stats.total === 0) return 'empty';
  if (stats.queued > 0) return 'in-progress';
  if (stats.done === stats.total) return 'complete';
  if (stats.done > 0) return 'partial';
  if (stats.failed > 0) return 'failed';
  return 'idle';
}

/** One-line summary for the card, e.g. `3 / 6 done · 1 failed · 2 new`. */
export function statsLabel(stats: TaskStats): string {
  if (stats.total === 0) return 'no files yet';
  const parts = [`${stats.done} / ${stats.total} done`];
  if (stats.failed) parts.push(`${stats.failed} failed`);
  if (stats.unverified) parts.push(`${stats.unverified} unverified`);
  const fresh = stats.total - stats.done - stats.failed - stats.queued - stats.unverified;
  if (fresh > 0) parts.push(`${fresh} not downloaded`);
  if (stats.queued) parts.push(`${stats.queued} in the queue`);
  return parts.join(' · ');
}

// ------------------------------------------------------------------ run planning

export type TaskRunMode = 'missing' | 'all';

export interface TaskRunPlan {
  /** Link ids to hand to the queue, in discovery order. */
  ids: string[];
  /** Files skipped because they are already saved. */
  alreadyDone: number;
  /** Rows already waiting in the queue (never queued twice). */
  alreadyQueued: number;
  /** Files that are queued again as a retry of an earlier failure. */
  retrying: number;
  total: number;
}

/**
 * Decide what "Download missing" means for one task.
 *
 * `missing` (the default, and what the button does) queues everything that is not
 * already saved - so it fetches **new files and retries failures** in one press,
 * and never re-downloads what is on disk. `all` is the explicit "do it again"
 * (useful when the user deleted files, or changed the naming template), and even
 * then the browser's duplicate behaviour decides what happens to existing files.
 */
export function planTaskRun(task: DownloadTask, links: readonly MirrorLink[], mode: TaskRunMode = 'missing'): TaskRunPlan {
  const wanted = new Set(task.memberIds);
  const mine = links.filter((link) => wanted.has(link.id));
  const plan: TaskRunPlan = { ids: [], alreadyDone: 0, alreadyQueued: 0, retrying: 0, total: mine.length };
  for (const link of mine) {
    if (link.status === 'queued') {
      plan.alreadyQueued += 1;
      continue;
    }
    if (link.status === 'done' && mode === 'missing') {
      plan.alreadyDone += 1;
      continue;
    }
    if (link.status === 'failed' || link.status === 'unverified') plan.retrying += 1;
    plan.ids.push(link.id);
  }
  return plan;
}

/** A run record, opened when a task starts and closed as its rows settle. */
export function startRun(input: { scannedPosts?: number; added?: number; queued?: number; note?: string | null } = {}, now = new Date()): TaskRun {
  return {
    id: `run_${now.getTime().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`,
    startedAt: now.toISOString(),
    finishedAt: null,
    scannedPosts: input.scannedPosts ?? 0,
    added: input.added ?? 0,
    queued: input.queued ?? 0,
    done: 0,
    failed: 0,
    note: input.note ?? null,
    completionTracking: 'browser-complete',
  };
}

/** Keep the task's history bounded: the newest runs are the useful ones. */
export const MAX_TASK_RUNS = 20;
export const MAX_TASKS = 500;
export const MAX_TASK_MEMBERS = 5_000;
export const MAX_SCANNED_POSTS = 20_000;

export function trimRuns(runs: readonly TaskRun[]): TaskRun[] {
  return runs.slice(-MAX_TASK_RUNS);
}

// -------------------------------------------------------------------- manifests

/** The JSON half of a package. */
export interface TaskManifest {
  format: typeof TASK_FORMAT;
  version: number;
  exportedAt: string;
  tool: string;
  task: {
    id: string;
    name: string;
    siteType: string | null;
    service: string | null;
    creator: string | null;
    query: string;
    lastScanAt: string | null;
    scannedPosts: string[];
  };
  summary: { total: number; done: number; failed: number; pending: number; bytes: number | null; completion: TaskCompletion };
  runs: TaskRun[];
  /** One entry per file: everything a reader needs to re-create the job. */
  files: Array<{
    url: string;
    provider: string;
    host: string;
    postId: string | null;
    postTitle: string | null;
    postUrl: string | null;
    status: MirrorLink['status'];
    filename: string | null;
    bytes: number | null;
    error: string | null;
  }>;
}

export interface TaskExportOptions {
  tool?: string;
  now?: Date;
}

/** Build the manifest for one task (the `.json` half of the package). */
export function formatTaskManifest(task: DownloadTask, links: readonly MirrorLink[], options: TaskExportOptions = {}): string {
  const wanted = new Set(task.memberIds);
  const mine = links.filter((link) => wanted.has(link.id));
  const stats = taskStatsFor(task, links);
  const manifest: TaskManifest = {
    format: TASK_FORMAT,
    version: TASK_FORMAT_VERSION,
    exportedAt: (options.now ?? new Date()).toISOString(),
    tool: options.tool ?? 'Booru Server Manager',
    task: {
      id: task.id,
      name: task.name,
      siteType: task.siteType,
      service: task.service,
      creator: task.creator,
      query: creatorQuery(task),
      lastScanAt: task.lastScanAt,
      scannedPosts: task.scannedPosts,
    },
    summary: {
      total: stats.total,
      done: stats.done,
      failed: stats.failed,
      pending: stats.pending,
      bytes: stats.bytes,
      completion: taskCompletion(stats),
    },
    runs: task.runs,
    files: mine.map((link) => ({
      url: link.url,
      provider: link.provider,
      host: link.host,
      postId: link.postId,
      postTitle: link.postTitle,
      postUrl: link.postUrl,
      status: link.status,
      filename: link.filename,
      bytes: link.bytes,
      error: link.error,
    })),
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** File name for the manifest half - `<task>_task.json`, filesystem-safe. */
export function manifestFilename(name: string): string {
  const safe = name
    .trim()
    .replace(/[^\w.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
  return `${safe || 'task'}_task.json`;
}

export interface ParsedTaskPackage {
  /** `json` for a manifest, `txt` for a link list, `unknown` when neither. */
  kind: 'json' | 'txt' | 'unknown';
  task: {
    id: string;
    name: string;
    siteType: SiteType | null;
    service: string | null;
    creator: string | null;
    query: string;
    lastScanAt: string | null;
    scannedPosts: string[];
    runs: TaskRun[];
  } | null;
  /** Per-file metadata, keyed by URL id, so an import can restore post context. */
  files: Map<string, { postId: string | null; postTitle: string | null; postUrl: string | null; provider: string | null }>;
  urls: string[];
  /** `#`-header creator of a `.txt` list, when it has one. */
  creator: string | null;
  summary: TaskManifest['summary'] | null;
  error: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Read a package: the `.json` manifest, or a `.txt` list (this extension's, the
 * userscript's, or something hand-written).
 *
 * Detection is by **content**, never by extension: a file that starts with `{` and
 * parses as our manifest is a package; anything else is treated as text and every
 * `http(s)://` URL line is taken, which is exactly the tolerant reader the plain
 * list has always used.
 */
export function parseTaskPackage(text: string): ParsedTaskPackage {
  const body = (text ?? '').trim();
  if (!body) return { kind: 'unknown', task: null, files: new Map(), urls: [], creator: null, summary: null, error: 'The file is empty.' };

  if (body.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      return {
        kind: 'unknown',
        task: null,
        files: new Map(),
        urls: [],
        creator: null,
        summary: null,
        error: `The JSON could not be read: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (!isRecord(parsed)) {
      return { kind: 'unknown', task: null, files: new Map(), urls: [], creator: null, summary: null, error: 'The JSON is not an object.' };
    }
    const format = asString(parsed.format) ?? '';
    const rawTask = isRecord(parsed.task) ? parsed.task : null;
    const rawFiles = Array.isArray(parsed.files) ? parsed.files : Array.isArray(parsed.links) ? parsed.links : null;
    if (!format.startsWith('booru-server-manager') && !rawTask && !rawFiles) {
      return {
        kind: 'unknown',
        task: null,
        files: new Map(),
        urls: [],
        creator: null,
        summary: null,
        error: 'This JSON is not a Booru Server Manager task package.',
      };
    }

    const files = new Map<ParsedTaskPackage['files'] extends Map<string, infer V> ? string : never, ParsedTaskPackage['files'] extends Map<string, infer V> ? V : never>();
    const urls: string[] = [];
    for (const entry of rawFiles ?? []) {
      if (typeof entry === 'string') {
        urls.push(entry);
        continue;
      }
      if (!isRecord(entry)) continue;
      const url = asString(entry.url);
      if (!url) continue;
      const id = mirrorLinkId(url);
      urls.push(url);
      files.set(id, {
        postId: asString(entry.postId),
        postTitle: asString(entry.postTitle),
        postUrl: asString(entry.postUrl),
        provider: asString(entry.provider),
      });
    }

    const siteType = asString(rawTask?.siteType) as SiteType | null;
    const service = asString(rawTask?.service);
    const creator = asString(rawTask?.creator);
    const query = asString(rawTask?.query) ?? '';
    const identity = { siteType, service, creator, query };
    return {
      kind: 'json',
      task: {
        id: asString(rawTask?.id) ?? taskIdFor(identity),
        name: asString(rawTask?.name) ?? taskNameFor(identity),
        siteType,
        service,
        creator,
        query: query || creatorQuery({ service, creator, query: '' }),
        lastScanAt: asString(rawTask?.lastScanAt),
        scannedPosts: Array.isArray(rawTask?.scannedPosts)
          ? rawTask.scannedPosts.filter((entry): entry is string => typeof entry === 'string').slice(0, MAX_SCANNED_POSTS)
          : [],
        runs: Array.isArray(parsed.runs)
          ? parsed.runs.filter(isRecord).map((run) => ({
              id: asString(run.id) ?? `run_${Math.floor(Math.random() * 1e6).toString(36)}`,
              startedAt: asString(run.startedAt) ?? new Date().toISOString(),
              finishedAt: asString(run.finishedAt),
              scannedPosts: asNumber(run.scannedPosts) ?? 0,
              added: asNumber(run.added) ?? 0,
              queued: asNumber(run.queued) ?? 0,
              done: asNumber(run.done) ?? 0,
              failed: asNumber(run.failed) ?? 0,
              note: asString(run.note),
              completionTracking: run.completionTracking === 'browser-complete' ? 'browser-complete' as const : undefined,
            }))
          : [],
      },
      files,
      urls: uniqueBy(urls, (url) => url),
      creator: creator ? (service ? `${service}/${creator}` : creator) : null,
      summary: isRecord(parsed.summary)
        ? {
            total: asNumber(parsed.summary.total) ?? urls.length,
            done: asNumber(parsed.summary.done) ?? 0,
            failed: asNumber(parsed.summary.failed) ?? 0,
            pending: asNumber(parsed.summary.pending) ?? 0,
            bytes: asNumber(parsed.summary.bytes),
            completion: (asString(parsed.summary.completion) ?? 'idle') as TaskCompletion,
          }
        : null,
      error: null,
    };
  }

  return { kind: 'txt', task: null, files: new Map(), urls: [], creator: null, summary: null, error: null };
}

/** Fold a run record forward (used when rows settle, without a full new run). */
export function foldRun(run: TaskRun, patch: Partial<Pick<TaskRun, 'done' | 'failed' | 'queued' | 'added' | 'scannedPosts' | 'note'>>, now = new Date()): TaskRun {
  return {
    ...run,
    ...patch,
    finishedAt: patch.note !== undefined || run.finishedAt ? run.finishedAt : now.toISOString(),
  };
}

/** Merge an incoming task over a stored one: members and scan memory accumulate. */
export function mergeTask(existing: DownloadTask, incoming: DownloadTask): DownloadTask {
  return {
    ...existing,
    name: incoming.name || existing.name,
    siteType: incoming.siteType ?? existing.siteType,
    serverId: incoming.serverId ?? existing.serverId,
    service: incoming.service ?? existing.service,
    creator: incoming.creator ?? existing.creator,
    query: incoming.query || existing.query,
    lastScanAt: existing.lastScanAt ?? incoming.lastScanAt,
    memberIds: uniqueBy([...existing.memberIds, ...incoming.memberIds], (id) => id).slice(-MAX_TASK_MEMBERS),
    scannedPosts: uniqueBy([...existing.scannedPosts, ...incoming.scannedPosts], (id) => id).slice(-MAX_SCANNED_POSTS),
    runs: trimRuns([...existing.runs, ...incoming.runs]),
    updatedAt: new Date().toISOString(),
  };
}
