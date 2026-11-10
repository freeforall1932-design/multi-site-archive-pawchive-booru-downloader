/**
 * Two small persistent notebooks that the side panel uses:
 *
 *  - **Download history** (`bsm.history`): what was already saved, so re-running
 *    a search does not download everything twice (the "Skip downloaded" switch).
 *    This is the booru equivalent of the history file the NHentai downloader and
 *    the Rule 34 side panel keep.
 *  - **Search history** (`bsm.searches`): the last few queries per server, shown
 *    as suggestions under the panel's search box.
 *
 * Both are storage-backed lists. History includes post URLs; search queries can
 * also be sensitive. Old Hydrus key-bearing post URLs are cleaned on read.
 */
import type { DownloadHistoryEntry, SearchHistoryEntry } from '../shared/types.js';
import { stripHydrusCredentials } from '../shared/util.js';
import { STORAGE_KEYS, type StorageArea } from './storage.js';

/** Hard ceiling so a long-lived profile cannot grow the store without bound. */
export const MAX_HISTORY_ENTRIES = 5000;
const MAX_SEARCH_ENTRIES = 500;

export function historyKey(serverId: string, postId: string): string {
  return `${serverId}:${postId}`;
}

function isHistoryEntry(value: unknown): value is DownloadHistoryEntry {
  const entry = value as Partial<DownloadHistoryEntry> | null;
  return !!entry && typeof entry.key === 'string' && typeof entry.serverId === 'string' && typeof entry.postId === 'string';
}

/**
 * Newest-first list of successful downloads.
 *
 * Entries are written by the queue when an item finishes and read by the
 * listing card to grey out/omit posts the user already has on disk.
 */
export class DownloadHistoryStore {
  private cache: DownloadHistoryEntry[] | null = null;
  private loadPromise: Promise<void> | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly area: StorageArea) {}

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const next = this.chain.then(task, task);
    this.chain = next.then(() => undefined, () => undefined);
    return next;
  }

  async list(): Promise<DownloadHistoryEntry[]> {
    if (!this.cache) {
      if (!this.loadPromise) {
        this.loadPromise = (async () => {
          const stored = await this.area.get<unknown>(STORAGE_KEYS.history);
          let changed = false;
          const entries = (Array.isArray(stored) ? stored.filter(isHistoryEntry) : []).map((entry) => {
            const postUrl = stripHydrusCredentials(entry.postUrl ?? '');
            if (postUrl !== entry.postUrl) changed = true;
            return { ...entry, postUrl };
          });
          // Finish the privacy migration before exposing the rows or accepting
          // concurrent mutations; a failed write is retried on the next read.
          if (changed) await this.area.set(STORAGE_KEYS.history, entries);
          this.cache = entries;
        })().finally(() => { this.loadPromise = null; });
      }
      await this.loadPromise;
    }
    return (this.cache ?? []).map((entry) => ({ ...entry }));
  }

  async size(): Promise<number> {
    return (await this.list()).length;
  }

  async has(serverId: string, postId: string): Promise<boolean> {
    const key = historyKey(serverId, postId);
    return (await this.list()).some((entry) => entry.key === key && entry.quality === 'original' && entry.completion === 'browser-complete');
  }

  /** Legacy start-only or unknown-quality entries must never hide an original. */
  async index(): Promise<Map<string, DownloadHistoryEntry>> {
    const map = new Map<string, DownloadHistoryEntry>();
    for (const entry of await this.list()) {
      if (entry.quality === 'original' && entry.completion === 'browser-complete' && !map.has(entry.key)) map.set(entry.key, entry);
    }
    return map;
  }

  /** Record a download; serialized mutations prevent simultaneous completions losing entries. */
  async add(entry: DownloadHistoryEntry): Promise<void> {
    return this.serialize(async () => {
      const entries = await this.list();
      const next = entries.filter((existing) => existing.key !== entry.key);
      next.unshift({ ...entry, postUrl: stripHydrusCredentials(entry.postUrl ?? '') });
      const saved = next.slice(0, MAX_HISTORY_ENTRIES);
      await this.area.set(STORAGE_KEYS.history, saved);
      this.cache = saved;
    });
  }

  async remove(serverId: string, postId: string): Promise<number> {
    return this.serialize(async () => {
      const key = historyKey(serverId, postId);
      const entries = await this.list();
      const saved = entries.filter((entry) => entry.key !== key);
      await this.area.set(STORAGE_KEYS.history, saved);
      this.cache = saved;
      return entries.length - saved.length;
    });
  }

  /** "Reset history" in the panel: everything is listed again afterwards. */
  async clear(): Promise<number> {
    return this.serialize(async () => {
      const entries = await this.list();
      await this.area.set(STORAGE_KEYS.history, []);
      this.cache = [];
      return entries.length;
    });
  }

  /** Another context wrote the history (options page / worker). */
  invalidate(): void {
    this.cache = null;
  }
}

/** Newest-first recent-search list, deduplicated per server. */
export class SearchHistoryStore {
  private cache: SearchHistoryEntry[] | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly area: StorageArea) {}

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const next = this.chain.then(task, task);
    this.chain = next.then(() => undefined, () => undefined);
    return next;
  }

  async list(serverId?: string | null): Promise<SearchHistoryEntry[]> {
    if (!this.cache) {
      const stored = await this.area.get<unknown>(STORAGE_KEYS.searches);
      this.cache = Array.isArray(stored)
        ? stored.filter((entry): entry is SearchHistoryEntry => !!entry && typeof (entry as SearchHistoryEntry).query === 'string')
        : [];
    }
    const entries = this.cache.map((entry) => ({ ...entry }));
    return serverId ? entries.filter((entry) => entry.serverId === serverId) : entries;
  }

  async add(serverId: string, query: string, perServerLimit: number): Promise<SearchHistoryEntry[]> {
    return this.serialize(async () => {
      const trimmed = (query ?? '').trim();
      const limit = Math.max(0, Math.floor(perServerLimit));
      if (limit === 0) return this.list(serverId);
      let entries = await this.list();
      if (trimmed) {
        // The query moves to the front when it is used again.
        entries = entries.filter((entry) => !(entry.serverId === serverId && entry.query.toLowerCase() === trimmed.toLowerCase()));
        entries.unshift({ serverId, query: trimmed, at: new Date().toISOString() });
      }
      const counts = new Map<string, number>();
      entries = entries.filter((entry) => {
        const used = counts.get(entry.serverId) ?? 0;
        if (used >= limit && limit > 0) return false;
        counts.set(entry.serverId, used + 1);
        return true;
      });
      this.cache = entries.slice(0, MAX_SEARCH_ENTRIES);
      await this.area.set(STORAGE_KEYS.searches, this.cache);
      return this.list(serverId);
    });
  }

  async remove(serverId: string, query: string): Promise<SearchHistoryEntry[]> {
    return this.serialize(async () => {
      const entries = await this.list();
      this.cache = entries.filter((entry) => !(entry.serverId === serverId && entry.query === query));
      await this.area.set(STORAGE_KEYS.searches, this.cache);
      return this.list(serverId);
    });
  }

  async clear(serverId?: string | null): Promise<number> {
    return this.serialize(async () => {
      const entries = await this.list();
      this.cache = serverId ? entries.filter((entry) => entry.serverId !== serverId) : [];
      await this.area.set(STORAGE_KEYS.searches, this.cache);
      return entries.length - this.cache.length;
    });
  }

  invalidate(): void {
    this.cache = null;
  }
}
