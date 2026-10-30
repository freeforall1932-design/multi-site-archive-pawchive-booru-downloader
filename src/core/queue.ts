import { BooruError } from '../shared/errors.js';
import type { HttpClient } from '../shared/http.js';
import type {
  BooruPost,
  DownloadHistoryEntry,
  ExtensionSettings,
  FailureKind,
  MirrorLinkStatus,
  QueueItem,
  QueueItemKind,
  QueueSummary,
  Rating,
  ServerConfig,
} from '../shared/types.js';
import { historyKey, type DownloadHistoryStore } from './history.js';
import { createId, deepClone, isValidHttpUrl, redactUrlsInText } from '../shared/util.js';
import { manualMirrorProvider, mirrorLinkId } from './links.js';
import type { MirrorLinkStore } from './link-store.js';
import type { TaskStore } from './task-store.js';
import type { BooruClient } from './client.js';
import { requireOriginalFile, type Downloader, type DownloadOutcome, type DownloadRequest } from './downloads.js';
import { buildDownloadPath, buildMirrorPath } from './naming.js';
import { createAdapterContext, requireAdapter } from './registry.js';
import type { ServerStore } from './servers.js';
import type { SettingsStore } from './settings.js';
import { STORAGE_KEYS, type StorageArea } from './storage.js';

export interface QueueDeps {
  storage: StorageArea;
  client: BooruClient;
  servers: ServerStore;
  settings: SettingsStore;
  downloader: Downloader;
  /** Optional download notebook: written on success, read by "skip downloaded". */
  history?: DownloadHistoryStore;
  /** Optional mirror-link list: keeps a link row's own status in sync. */
  links?: MirrorLinkStore;
  /** Optional task list: closes a task's run record once its files settle. */
  tasks?: TaskStore;
  http?: HttpClient;
  /** Explicit per-server rate spacing override (defaults to adapter + settings). */
  spacingMs?: number;
  now?: () => number;
}

export interface EnqueueInput {
  serverId: string;
  postId: string;
  label?: string;
  postUrl?: string;
  rating?: Rating | null;
  /** `link` rows download `url` directly; omitted means a normal post row. */
  kind?: QueueItemKind;
  /** The mirror URL of a `link` row. */
  url?: string;
  /** Pawchive path hash observed in the listing, when available. */
  expectedFileHash?: string | null;
}

/**
 * Minimal shape a caller needs to queue a listing result: the queue itself
 * looks up the server, the adapter and the canonical post.
 */
export interface EnqueueCandidate {
  id: string;
  label?: string;
  postUrl?: string;
  rating?: Rating;
  expectedFileHash?: string | null;
}

/** One collected mirror link, as the Links tab hands it to the queue. */
export interface EnqueueLinkInput {
  url: string;
  /** Stored ID, including a legacy ID retained when a Mega key is recovered. */
  id?: string;
  label?: string;
  /** The post the link was collected from, kept for the row's link-out. */
  postUrl?: string | null;
  serverId?: string | null;
}

/**
 * De-duplication key for a queue row.
 *
 * Post rows are unique per `serverId:postId`; link rows use the durable link ID,
 * normally derived from the full URL. This also preserves legacy Mega rows
 * whose key was recovered after they were already queued.
 */
export function queueItemKey(item: Pick<QueueItem, 'kind' | 'serverId' | 'postId' | 'url'>): string {
  if (item.kind === 'link') return `link:${item.postId || mirrorLinkId(item.url ?? '')}`;
  return `${item.serverId}:${item.postId}`;
}

/**
 * Batch download queue.
 *
 * - one worker per concurrency slot, respecting per-server rate limits
 * - every attempt is re-validated against the server's rating filter
 * - state is persisted so a service-worker restart does not lose the queue
 */
export class DownloadQueue {
  private items: QueueItem[] = [];
  private paused = false;
  /** True only while workers are preparing browser starts, not while Chrome transfers. */
  private running = false;
  private loadPromise: Promise<void> | null = null;
  private saveChain: Promise<unknown> = Promise.resolve();
  private dispatchPromise: Promise<void> | null = null;
  private scheduledIds = new Set<string>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly reconcileChains = new Map<number, Promise<void>>();
  private bookkeepingPromise: Promise<void> | null = null;
  private readonly listeners = new Set<(summary: QueueSummary, items: QueueItem[]) => void>();
  private readonly now: () => number;

  constructor(private readonly deps: QueueDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  // ------------------------------------------------------------------ state

  private async ensureLoaded(): Promise<void> {
    if (!this.loadPromise) {
      this.loadPromise = this.loadStored().catch((error) => {
        this.loadPromise = null;
        throw error;
      });
    }
    await this.loadPromise;
  }

  private async loadStored(): Promise<void> {
    const stored = (await this.deps.storage.get<unknown>(STORAGE_KEYS.queue)) as
      | { items?: QueueItem[]; paused?: boolean; scheduledIds?: string[] }
      | null;
    const items = Array.isArray(stored?.items) ? stored.items : [];
    const changed: QueueItem[] = [];
    this.items = items.map((previous) => {
      const item: QueueItem = { ...previous, kind: previous.kind ?? 'post', url: previous.url ?? null, rating: previous.rating ?? null };
      // A start-only legacy success is not a completion. Also, a worker can die
      // between asking Chrome to start and persisting the returned ID; do not
      // silently re-start that ambiguous request and create a duplicate.
      if (item.status === 'done' && item.completion !== 'browser-complete') {
        item.status = 'unverified';
        item.error = 'Older version recorded a start only; check Chrome Downloads before retrying.';
        item.errorKind = 'unknown';
        item.bookkeepingPending = true;
        changed.push(item);
      } else if (item.status === 'running' && typeof item.downloadId !== 'number') {
        item.status = 'unverified';
        item.error = 'The worker stopped before the browser download ID was saved. Check Chrome Downloads before retrying.';
        item.errorKind = 'unknown';
        item.bookkeepingPending = true;
        changed.push(item);
      }
      return item;
    });
    this.paused = stored?.paused ?? false;
    this.scheduledIds = new Set(Array.isArray(stored?.scheduledIds) ? stored.scheduledIds : []);
    if (changed.length) await this.persist();
  }

  private async persist(): Promise<void> {
    // Capture a snapshot when the mutation happens and serialize writes. Queue
    // workers and download events may otherwise overwrite one another in storage.
    const value = deepClone({ items: this.items, paused: this.paused, scheduledIds: [...this.scheduledIds], updatedAt: new Date().toISOString() });
    const write = this.saveChain.then(() => this.deps.storage.set(STORAGE_KEYS.queue, value));
    this.saveChain = write.catch(() => undefined);
    await write;
    this.emit();
  }

  /** Load, reconcile browser IDs, and resume only the previously scheduled rows. */
  async recover(): Promise<void> {
    await this.refresh();
    if (!this.paused && this.scheduledIds.size) void this.dispatchScheduled();
  }

  /** Used by queue/list and on startup; Chrome change events do not report bytes. */
  async refresh(): Promise<void> {
    await this.ensureLoaded();
    const ids = this.items.filter((item) => item.status === 'running' && typeof item.downloadId === 'number').map((item) => item.downloadId!);
    // Limit concurrent Chrome API calls even if a large queue was started.
    for (let index = 0; index < ids.length; index += 8) {
      await Promise.all(ids.slice(index, index + 8).map((id) => this.handleDownloadChanged(id)));
    }
    await this.repairBookkeeping();
  }

  private emit(): void {
    const summary = this.summary();
    const snapshot = this.list();
    this.listeners.forEach((listener) => listener(summary, snapshot));
  }

  onChange(listener: (summary: QueueSummary, items: QueueItem[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list(): QueueItem[] {
    return this.items.map((item) => deepClone(item));
  }

  summary(): QueueSummary {
    const counts: QueueSummary = {
      pending: 0,
      running: 0,
      done: 0,
      failed: 0,
      skipped: 0,
      canceled: 0,
      unverified: 0,
      total: this.items.length,
      paused: this.paused,
      active: this.running,
    };
    for (const item of this.items) counts[item.status] += 1;
    return counts;
  }

  // --------------------------------------------------------------- mutation

  async enqueue(inputs: EnqueueInput[]): Promise<{ added: number; skipped: number }> {
    await this.ensureLoaded();
    const existing = new Set(
      this.items
        .filter((item) => item.status === 'pending' || item.status === 'running')
        .map((item) => queueItemKey(item)),
    );
    let added = 0;
    let skipped = 0;
    for (const input of inputs) {
      const key = input.kind === 'link' ? `link:${input.postId || mirrorLinkId(input.url ?? '')}` : `${input.serverId}:${input.postId}`;
      if (existing.has(key)) {
        skipped += 1;
        continue;
      }
      existing.add(key);
      const timestamp = new Date(this.now()).toISOString();
      this.items.push({
        id: createId('q'),
        serverId: input.serverId,
        postId: input.postId,
        label: input.label ?? `post ${input.postId}`,
        postUrl: input.postUrl ?? '',
        kind: input.kind ?? 'post',
        url: input.url ?? null,
        rating: input.rating ?? null,
        attachmentIndexVersion: 2,
        expectedFileHash: input.expectedFileHash ?? null,
        status: 'pending',
        attempts: 0,
        error: null,
        errorKind: null,
        filename: null,
        bytes: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      added += 1;
    }
    await this.persist();
    return { added, skipped };
  }

  /**
   * Enqueue collected mirror links.
   *
   * The default `serverId` is the profile the links were collected with; it is
   * provenance, not a requirement - a link row downloads with no server at all
   * (that is the whole point of importing a `.txt` on a fresh profile).
   */
  async enqueueLinks(inputs: readonly EnqueueLinkInput[], defaultServerId = ''): Promise<{ added: number; skipped: number; invalid: number }> {
    const valid = inputs.filter((input) => isValidHttpUrl(input.url));
    const result = await this.enqueue(
      valid.map((input) => ({
        kind: 'link' as const,
        serverId: input.serverId ?? defaultServerId,
        postId: input.id || mirrorLinkId(input.url),
        url: input.url,
        label: input.label?.trim() || input.url,
        postUrl: input.postUrl || input.url,
      })),
    );
    return { ...result, invalid: inputs.length - valid.length };
  }

  /** Enqueue every post from a listing result, honouring the rating filter. */
  async enqueuePosts(serverId: string, posts: readonly EnqueueCandidate[]): Promise<{ added: number; skipped: number }> {
    const server = await this.deps.servers.get(serverId);
    if (!server) {
      throw new BooruError(`Unknown server "${serverId}"`, {
        kind: 'unknown',
        hint: 'The profile may have been deleted - refresh the server list and try again.',
      });
    }
    const adapter = requireAdapter(server.siteType);
    const allowed = posts.filter((post) => this.deps.client.isRatingAllowed(server, adapter, post.rating ?? 'unknown'));
    const denied = posts.length - allowed.length;
    const result = await this.enqueue(
      allowed.map((post) => ({
        serverId,
        postId: post.id,
        label: post.label ?? `${server.siteType} #${post.id}`,
        postUrl: post.postUrl,
        rating: post.rating ?? null,
        expectedFileHash: post.expectedFileHash ?? null,
      })),
    );
    // Rating-filtered posts count as skipped so the UI can say "3 skipped".
    return { added: result.added, skipped: result.skipped + denied };
  }

  /** Cancel a pending row or ask Chrome to cancel an active transfer. */
  async cancel(itemId: string): Promise<void> {
    await this.ensureLoaded();
    const item = this.items.find((entry) => entry.id === itemId);
    if (!item || (item.status !== 'pending' && item.status !== 'running')) return;
    if (item.status === 'pending') {
      this.scheduledIds.delete(item.id);
      item.status = 'canceled';
      item.updatedAt = new Date(this.now()).toISOString();
      await this.syncLinkRow(item, 'new', {});
      await this.persist();
      return;
    }
    item.cancelRequested = true;
    item.updatedAt = new Date(this.now()).toISOString();
    this.controllers.get(item.id)?.abort();
    await this.persist();
    // While metadata or chrome.downloads.download is pending, the worker checks
    // this flag again before/after receiving the ID. Do not pretend it stopped.
    if (typeof item.downloadId === 'number') await this.handleDownloadChanged(item.downloadId);
  }

  /** Requeue explicit failures and ambiguous old starts, without duplicating active rows. */
  async retryFailed(): Promise<number> {
    await this.ensureLoaded();
    await Promise.all([...this.reconcileChains.values()].map((job) => job.catch(() => undefined)));
    const active = new Set(this.items.filter((item) => item.status === 'pending' || item.status === 'running').map(queueItemKey));
    let requeued = 0;
    for (const item of this.items) {
      if (item.status !== 'failed' && item.status !== 'skipped' && item.status !== 'unverified') continue;
      const key = queueItemKey(item);
      if (active.has(key)) continue;
      active.add(key);
      item.status = 'pending';
      item.error = null;
      item.errorKind = null;
      item.downloadId = null;
      item.bytes = null;
      item.bytesReceived = null;
      item.totalBytes = null;
      item.cancelRequested = false;
      item.completion = undefined;
      item.historyEntry = null;
      item.bookkeepingPending = false;
      item.updatedAt = new Date(this.now()).toISOString();
      await this.syncLinkRow(item, 'queued', {});
      requeued += 1;
    }
    await this.persist();
    return requeued;
  }

  async clear(scope: 'completed' | 'failed' | 'all'): Promise<number> {
    await this.ensureLoaded();
    const ids = this.items.filter((item) => {
      if (item.status === 'running') return false; // keep tracking in-flight transfers
      if (scope === 'all') return true;
      if (scope === 'completed') return item.status === 'done';
      return item.status === 'failed' || item.status === 'skipped';
    }).map((item) => item.id);
    return this.remove(ids);
  }

  /** Active rows cannot be removed: their browser outcomes would be lost. */
  async remove(itemIds: readonly string[]): Promise<number> {
    await this.ensureLoaded();
    const wanted = new Set(itemIds);
    const removed = this.items.filter((item) => wanted.has(item.id) && item.status !== 'running');
    const removedIds = new Set(removed.map((item) => item.id));
    this.items = this.items.filter((item) => !removedIds.has(item.id));
    for (const id of removedIds) this.scheduledIds.delete(id);
    const linkIds = removed.filter((item) => item.kind === 'link').map((item) => item.postId);
    if (linkIds.length) await this.deps.links?.release(linkIds);
    await this.persist();
    return removed.length;
  }

  async pause(): Promise<void> {
    await this.ensureLoaded();
    this.paused = true;
    await this.persist();
  }

  async resume(): Promise<void> {
    await this.ensureLoaded();
    this.paused = false;
    await this.persist();
    if (this.scheduledIds.size) void this.dispatchScheduled().catch(() => undefined);
  }

  // ---------------------------------------------------------------- running

  /** Persist the selection before starting workers, so a cold worker can resume it. */
  async start(options: { onlyIds?: readonly string[] } = {}): Promise<void> {
    await this.ensureLoaded();
    if (this.running) return;
    // The previous dispatch may have finished its workers but still be flushing.
    if (this.dispatchPromise) await this.dispatchPromise;
    if (this.running) return;
    this.running = true; // reserve the scheduler while persisting its selection
    try {
      const only = options.onlyIds ? new Set(options.onlyIds) : null;
      this.scheduledIds = new Set(this.items.filter((item) => item.status === 'pending' && (!only || only.has(item.id))).map((item) => item.id));
      this.paused = false;
      await this.persist();
    } finally {
      this.running = false;
    }
    void this.dispatchScheduled().catch(() => undefined);
  }

  /** Wait for start workers (not browser transfers); useful for tests and callers. */
  async run(options: { onlyIds?: readonly string[] } = {}): Promise<QueueSummary> {
    await this.start(options);
    if (this.dispatchPromise) await this.dispatchPromise;
    return this.summary();
  }

  private dispatchScheduled(): Promise<void> {
    if (this.dispatchPromise) return this.dispatchPromise;
    if (this.paused || !this.scheduledIds.size) return Promise.resolve();
    this.running = true;
    const job = (async () => {
      try {
        const settings = await this.deps.settings.get();
        const concurrency = Math.max(1, Math.min(settings.maxConcurrency, 8));
        await Promise.all(Array.from({ length: concurrency }, () => this.worker(settings)));
      } finally {
        // Keep the scheduler reserved until its final snapshot is durable.
        try { await this.persist(); } finally {
          this.running = false;
          this.emit();
        }
      }
    })();
    this.dispatchPromise = job;
    void job.then(
      () => {
        if (this.dispatchPromise !== job) return;
        this.dispatchPromise = null;
        for (const id of this.scheduledIds) {
          if (!this.items.some((item) => item.id === id && item.status === 'pending')) this.scheduledIds.delete(id);
        }
        // Resume can race the last paused worker exiting. Do not strand the plan.
        if (!this.paused && this.scheduledIds.size) void this.dispatchScheduled().catch(() => undefined);
      },
      () => { if (this.dispatchPromise === job) this.dispatchPromise = null; },
    );
    return job;
  }

  private async worker(settings: ExtensionSettings): Promise<void> {
    for (;;) {
      if (this.paused) return;
      const next = this.items.find((item) => item.status === 'pending' && this.scheduledIds.has(item.id));
      if (!next) return;
      this.scheduledIds.delete(next.id);
      next.status = 'running';
      next.attempts += 1;
      next.downloadId = null;
      next.cancelRequested = false;
      next.updatedAt = new Date(this.now()).toISOString();
      this.controllers.set(next.id, new AbortController());
      // This must be durable BEFORE a Chrome start is attempted.
      await this.persist();
      await this.syncLinkRow(next, 'queued', { attempts: next.attempts });
      try {
        await this.processItem(next, settings);
      } catch (error) {
        await this.recordStartError(next, error);
      } finally {
        this.controllers.delete(next.id);
      }
    }
  }

  /** Start an already resolved post immediately, while tracking it like a queued row. */
  async startDirect(input: {
    server: ServerConfig;
    post: BooruPost;
    filename: string;
    conflictAction: DownloadRequest['conflictAction'];
  }): Promise<DownloadOutcome> {
    await this.ensureLoaded();
    const target = requireOriginalFile(input.post);
    const key = `${input.server.id}:${input.post.id}`;
    let item = this.items.find((entry) => entry.kind !== 'link' && queueItemKey(entry) === key && entry.status === 'pending');
    if (input.server.siteType === 'pawchive' && item && item.attachmentIndexVersion !== 2) {
      throw new BooruError('This Pawchive queue row was created with older, ambiguous attachment numbering.', {
        kind: 'incomplete-config', hint: 'Remove the old row and add the post or its attachments to the queue again.',
      });
    }
    if (input.server.siteType === 'pawchive' && item?.expectedFileHash && input.post.md5 !== item.expectedFileHash) {
      throw new BooruError('This Pawchive attachment changed since it was listed; refusing to download a different file.', {
        kind: 'incomplete-config', hint: 'Remove the row and list the post again to use its current attachment order.',
      });
    }
    if (this.items.some((entry) => entry.kind !== 'link' && queueItemKey(entry) === key && entry.status === 'running')) {
      throw new BooruError('This file is already being downloaded.', { kind: 'incomplete-config' });
    }
    const timestamp = new Date(this.now()).toISOString();
    if (!item) {
      item = {
        id: createId('q'), serverId: input.server.id, postId: input.post.id,
        label: `${input.server.siteType} #${input.post.id}`, postUrl: input.post.postUrl,
        kind: 'post', url: null, rating: input.post.rating, attachmentIndexVersion: 2,
        expectedFileHash: input.server.siteType === 'pawchive' ? input.post.md5 : null,
        status: 'pending', attempts: 0, error: null, errorKind: null,
        filename: null, bytes: null, createdAt: timestamp, updatedAt: timestamp,
      };
      this.items.push(item);
    }
    this.scheduledIds.delete(item.id);
    item.status = 'running';
    item.attempts += 1;
    item.downloadId = null;
    item.cancelRequested = false;
    item.updatedAt = timestamp;
    item.historyEntry = this.historyFor(item, input.server, input.post, input.filename);
    this.controllers.set(item.id, new AbortController());
    await this.persist();
    try {
      return await this.startBrowser(item, { url: target, filename: input.filename, conflictAction: input.conflictAction });
    } catch (error) {
      await this.recordStartError(item, error);
      throw error;
    } finally {
      this.controllers.delete(item.id);
    }
  }

  private historyFor(item: QueueItem, server: ServerConfig, post: BooruPost, filename: string): DownloadHistoryEntry {
    return {
      key: historyKey(server.id, post.id), serverId: server.id, siteType: server.siteType,
      postId: post.id, label: item.label, filename, postUrl: post.postUrl,
      bytes: null, at: new Date(this.now()).toISOString(), quality: 'original',
    };
  }

  private async startBrowser(item: QueueItem, request: DownloadRequest): Promise<DownloadOutcome> {
    item.filename = request.filename;
    await this.persist();
    const controller = this.controllers.get(item.id);
    if (item.cancelRequested || controller?.signal.aborted) {
      throw new BooruError('Download canceled before the browser started it.', { kind: 'unknown' });
    }
    const outcome = await this.deps.downloader.download({ ...request, signal: controller?.signal });
    item.downloadId = outcome.downloadId;
    item.bytes = outcome.bytes;
    item.updatedAt = new Date(this.now()).toISOString();
    // The completion event can precede this write. Querying Chrome after it is
    // durable catches that race, as well as a worker restart between the two.
    await this.persist();
    if (typeof outcome.downloadId !== 'number') {
      await this.markUnverified(item, 'The browser did not return a download ID; check Chrome Downloads before retrying.');
    } else {
      await this.handleDownloadChanged(outcome.downloadId);
    }
    return outcome;
  }

  private async recordStartError(item: QueueItem, error: unknown): Promise<void> {
    const booruError = error instanceof BooruError
      ? error
      : new BooruError(redactUrlsInText(error instanceof Error ? error.message : String(error)), { kind: 'unknown' });
    const status = item.cancelRequested ? 'canceled' : booruError.kind === 'unsupported-site' ? 'skipped' : 'failed';
    const message = status === 'canceled' ? null : booruError.message;
    const synced = await this.syncLinkRow(item, status === 'canceled' || status === 'skipped' ? 'new' : 'failed', {
      error: message, attempts: item.attempts,
    });
    item.status = status;
    item.error = message;
    item.errorKind = status === 'canceled' ? null : booruError.kind as FailureKind;
    item.bookkeepingPending = !synced;
    item.updatedAt = new Date(this.now()).toISOString();
    await this.persist();
  }

  /** Called synchronously-registered download events and by periodic reconciliation. */
  async handleDownloadChanged(downloadId: number): Promise<void> {
    await this.ensureLoaded();
    if (!this.items.some((item) => item.downloadId === downloadId && ['running', 'failed', 'canceled', 'unverified'].includes(item.status))) return;
    const previous = this.reconcileChains.get(downloadId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.reconcileDownload(downloadId));
    this.reconcileChains.set(downloadId, next);
    try {
      await next;
    } finally {
      if (this.reconcileChains.get(downloadId) === next) this.reconcileChains.delete(downloadId);
    }
  }

  private async reconcileDownload(downloadId: number): Promise<void> {
    const item = this.items.find((entry) => entry.downloadId === downloadId && ['running', 'failed', 'canceled', 'unverified'].includes(entry.status));
    if (!item) return;
    let snapshot;
    try {
      snapshot = await this.deps.downloader.getState(downloadId);
      if (snapshot?.state === 'in_progress' && item.status === 'running' && item.cancelRequested) {
        let cancellationError: unknown = null;
        try { await this.deps.downloader.cancel(downloadId); } catch (error) { cancellationError = error; }
        snapshot = await this.deps.downloader.getState(downloadId);
        if (snapshot?.state === 'in_progress' && cancellationError) {
          item.cancelRequested = false;
          item.error = `Could not cancel the browser download: ${redactUrlsInText(cancellationError instanceof Error ? cancellationError.message : String(cancellationError))}`;
          item.errorKind = 'unknown';
          await this.persist();
          return;
        }
      }
    } catch (error) {
      // A temporary API failure is not evidence of either success or failure.
      item.error = `Could not check Chrome Downloads: ${redactUrlsInText(error instanceof Error ? error.message : String(error))}`;
      item.errorKind = 'unknown';
      await this.persist();
      return;
    }
    // A retry may have detached this old browser ID while search was pending.
    if (item.downloadId !== downloadId || item.status === 'pending') return;
    if (!snapshot) {
      if (item.status === 'running') {
        await this.markUnverified(item, 'Chrome no longer has this download record. Its outcome is unknown; check the file before retrying.');
      }
      return;
    }
    const wasRunning = item.status === 'running';
    const progressChanged = !wasRunning || item.bytesReceived !== snapshot.bytesReceived || item.totalBytes !== snapshot.totalBytes || item.error !== null;
    item.bytesReceived = snapshot.bytesReceived;
    item.totalBytes = snapshot.totalBytes;
    if (snapshot.state === 'in_progress') {
      if (!wasRunning) {
        // The user may resume an interrupted download in Chrome itself.
        item.status = 'running';
        item.cancelRequested = false;
        item.bookkeepingPending = false;
        await this.syncLinkRow(item, 'queued', { attempts: item.attempts });
      }
      item.error = null;
      item.errorKind = null;
      if (progressChanged) {
        item.updatedAt = new Date(this.now()).toISOString();
        await this.persist();
      }
      return;
    }
    item.updatedAt = new Date(this.now()).toISOString();
    if (snapshot.state === 'interrupted') {
      const canceled = snapshot.error === 'USER_CANCELED';
      const message = canceled ? null : `Chrome interrupted the download${snapshot.error ? `: ${redactUrlsInText(snapshot.error)}` : '.'}`;
      // Write dependent records first. If the worker stops between writes, the
      // durable row is still running and the next reconciliation repeats them.
      const synced = await this.syncLinkRow(item, canceled ? 'new' : 'failed', { error: message, attempts: item.attempts });
      item.status = canceled ? 'canceled' : 'failed';
      item.error = message;
      item.errorKind = canceled ? null : 'network-failure';
      item.cancelRequested = false;
      item.bookkeepingPending = !synced;
      await this.persist();
      return;
    }
    // Chrome reported complete. This is not a hash/content verification and does
    // not prove the file remains on disk after the browser's report.
    item.bytes = snapshot.bytesReceived ?? item.bytes;
    const basename = snapshot.filename?.split(/[\\/]/).pop();
    if (basename && item.filename) {
      const slash = item.filename.lastIndexOf('/');
      item.filename = `${slash >= 0 ? item.filename.slice(0, slash + 1) : ''}${basename}`;
    }
    let historySaved = true;
    if (item.historyEntry && this.deps.history) {
      const endTime = snapshot.endTime && Number.isFinite(Date.parse(snapshot.endTime)) ? snapshot.endTime : item.updatedAt;
      item.historyEntry = { ...item.historyEntry, filename: item.filename ?? item.historyEntry.filename,
        bytes: item.bytes, at: endTime, completion: 'browser-complete' };
      try { await this.deps.history.add(item.historyEntry); } catch { historySaved = false; }
    }
    const synced = await this.syncLinkRow(item, 'done', { filename: item.filename, bytes: item.bytes, error: null, attempts: item.attempts });
    item.status = 'done';
    item.completion = 'browser-complete';
    item.error = null;
    item.errorKind = null;
    item.bookkeepingPending = !historySaved || !synced;
    await this.persist();
  }

  private async markUnverified(item: QueueItem, message: string): Promise<void> {
    const synced = await this.syncLinkRow(item, 'unverified', { error: message, attempts: item.attempts });
    item.status = 'unverified';
    item.error = message;
    item.errorKind = 'unknown';
    item.bookkeepingPending = !synced;
    item.updatedAt = new Date(this.now()).toISOString();
    await this.persist();
  }

  /** Retry failed history/link writes without repeating the browser transfer. */
  private repairBookkeeping(): Promise<void> {
    if (this.bookkeepingPromise) return this.bookkeepingPromise;
    const job = (async () => {
      for (const item of this.items.filter((entry) => entry.bookkeepingPending && entry.status !== 'running' && entry.status !== 'pending')) {
        let historySaved = true;
        if (item.status === 'done' && item.historyEntry?.completion === 'browser-complete' && this.deps.history) {
          try { await this.deps.history.add(item.historyEntry); } catch { historySaved = false; }
        }
        const target: MirrorLinkStatus = item.status === 'done' ? 'done'
          : item.status === 'failed' ? 'failed' : item.status === 'unverified' ? 'unverified' : 'new';
        const synced = await this.syncLinkRow(item, target, { filename: item.filename, bytes: item.bytes, error: item.error, attempts: item.attempts });
        if (historySaved && synced) {
          item.bookkeepingPending = false;
          await this.persist();
        }
      }
    })();
    this.bookkeepingPromise = job;
    void job.then(
      () => { if (this.bookkeepingPromise === job) this.bookkeepingPromise = null; },
      () => { if (this.bookkeepingPromise === job) this.bookkeepingPromise = null; },
    );
    return job;
  }

  /** Keep the Links tab and its task run in step with the actual transfer. */
  private async syncLinkRow(
    item: QueueItem,
    status: MirrorLinkStatus,
    patch: { filename?: string | null; bytes?: number | null; error?: string | null; attempts?: number },
  ): Promise<boolean> {
    if (item.kind !== 'link' || !item.url || !this.deps.links) return true;
    try {
      await this.deps.links.mark(item.postId, status, {
        ...(patch.filename !== undefined ? { filename: patch.filename } : {}),
        ...(patch.bytes !== undefined ? { bytes: patch.bytes } : {}),
        error: patch.error ?? null,
        ...(patch.attempts !== undefined ? { attempts: patch.attempts } : {}),
      });
      if (this.deps.tasks && status !== 'queued') {
        await this.deps.tasks.noteLinkSettled(item.postId, await this.deps.links.list());
      }
      return true;
    } catch {
      /* A bookkeeping error cannot change the browser's outcome. */
      return false;
    }
  }

  /** Start one direct mirror file, rejecting known provider share pages. */
  private async processLinkItem(item: QueueItem, settings: ExtensionSettings): Promise<void> {
    const stored = (await this.deps.links?.byId(item.postId)) ?? null;
    const url = stored?.url ?? item.url ?? '';
    item.url = url;
    if (!isValidHttpUrl(url)) {
      throw new BooruError(`"${redactUrlsInText(url)}" is not a downloadable http(s) URL`, {
        kind: 'parse-failure', hint: 'Remove the row, or fix the link in the exported .txt and import it again.',
      });
    }
    const manual = manualMirrorProvider(url);
    if (manual) {
      throw new BooruError(`${manual} share links need a provider downloader or browser; this is not a direct file URL.`, {
        kind: 'incomplete-config', hint: 'Open the collected link or export it and use the provider’s downloader.',
      });
    }
    const server = item.serverId ? await this.deps.servers.get(item.serverId) : null;
    const path = buildMirrorPath({
      url, provider: stored?.provider ?? null, siteType: server?.siteType ?? stored?.siteType ?? null,
      filename: stored?.filename ?? null, settings: { mirrorFolderTemplate: settings.mirrorFolderTemplate }, now: new Date(this.now()),
    });
    await this.startBrowser(item, {
      url, filename: path.fullPath, conflictAction: settings.duplicateBehaviour === 'overwrite' ? 'overwrite' : 'uniquify',
    });
  }

  private async processItem(item: QueueItem, settings: ExtensionSettings): Promise<void> {
    if (item.kind === 'link') return this.processLinkItem(item, settings);
    const known = await this.deps.servers.get(item.serverId);
    if (!known) {
      throw new BooruError(`Server profile for "${item.label}" no longer exists`, {
        kind: 'unsupported-site', hint: 'Re-add the server, then re-queue the post.',
      });
    }
    const { server, adapter } = await this.deps.client.resolve(item.serverId);
    if (server.siteType === 'pawchive' && item.attachmentIndexVersion !== 2) {
      throw new BooruError('This Pawchive queue row was created with older, ambiguous attachment numbering.', {
        kind: 'incomplete-config', hint: 'Remove the old row and add the post or its attachments to the queue again.',
      });
    }
    const post = await this.deps.client.getPost(server.id, item.postId);
    if (server.siteType === 'pawchive' && item.expectedFileHash && post.md5 !== item.expectedFileHash) {
      throw new BooruError('This Pawchive attachment changed since it was listed; refusing to download a different file.', {
        kind: 'incomplete-config', hint: 'Remove the row and list the post again to use its current attachment order.',
      });
    }
    if (server.siteType === 'pawchive') {
      item.label = item.label.replace(/\s*\[preview only\]$/, '');
      if (post.fileAvailability === 'preview') item.label += ' [preview only]';
    }
    if (settings.enforceRatingFilterOnDownload && !this.deps.client.isRatingAllowed(server, adapter, post.rating)) {
      throw new BooruError(`Skipped: rating "${post.rating}" is not allowed by this server's filter`, {
        kind: 'incomplete-config', hint: 'Enable the rating in the server config or turn off rating enforcement in Settings.',
      });
    }
    const target = requireOriginalFile(post);
    const path = buildDownloadPath({ post, server, settings: {
      folderTemplate: settings.folderTemplate, filenameTemplate: settings.filenameTemplate,
      maxTagsInFilename: settings.maxTagsInFilename, tagSeparator: settings.tagSeparator,
    } });
    item.historyEntry = this.historyFor(item, server, post, path.fullPath);
    await this.startBrowser(item, {
      url: target, filename: path.fullPath, conflictAction: settings.duplicateBehaviour === 'overwrite' ? 'overwrite' : 'uniquify',
    });
  }

}

/** Minimum spacing between requests to one server, per adapter + settings. */
export function requestSpacingFor(server: ServerConfig, settings: ExtensionSettings, adapterMinIntervalMs: number): number {
  return Math.max(settings.minRequestIntervalMs, adapterMinIntervalMs);
}

/** Helper used by the service worker to build an adapter context for a server. */
export async function contextForServer(server: ServerConfig, settings: ExtensionSettings) {
  return createAdapterContext(requireAdapter(server.siteType), server, settings);
}
