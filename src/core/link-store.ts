/**
 * The collected mirror-link list (`bsm.links`).
 *
 * One durable list, shared by the Links tab, the tasks it belongs to, the queue
 * and the import/export flow - the same idea as the download queue: closing the
 * panel, reloading the page or restarting the service worker must not lose work.
 * A row keeps the URL and where it came from (post, provider, creator), plus the
 * download outcome so a re-import of the same package can skip what is already
 * on disk.
 *
 * Every mutation runs through `serialize()`: two queue workers routinely finish
 * two files at the same moment, and a read-modify-write of the whole list would
 * otherwise lose one of the two status changes.
 *
 * Nothing here is site-specific and nothing here is secret: a link list is
 * exactly what the user can read in the UI.
 */
import type { MirrorLink, MirrorLinkStats, MirrorLinkStatus } from '../shared/types.js';
import { legacyMegaKeylessUrl, manualMirrorProvider, mirrorLinkId } from './links.js';
import { STORAGE_KEYS, type StorageArea } from './storage.js';

/** Hard ceiling so a long-lived profile cannot grow the list without bound. */
export const MAX_MIRROR_LINKS = 20_000;

function isMirrorLink(value: unknown): value is MirrorLink {
  const link = value as Partial<MirrorLink> | null;
  return !!link && typeof link.id === 'string' && typeof link.url === 'string' && typeof link.host === 'string';
}

/** Fill in fields an older/partial record may lack. */
function normalizeLink(link: MirrorLink): MirrorLink {
  // Every old "done" was only a start; even a quality-tagged record might have
  // been interrupted. Retain it as unverified rather than skipping it as saved.
  const legacyDone = link.status === 'done' && link.completion !== 'browser-complete';
  // Known provider shares are not direct files even if a browser saved HTML.
  const legacyShareDone = link.status === 'done' && !!manualMirrorProvider(link.url);
  return {
    ...link,
    provider: link.provider || link.host,
    status: legacyShareDone ? 'new' : legacyDone ? 'unverified' : link.status ?? 'new',
    attempts: link.attempts ?? 0,
    error: legacyShareDone ? null : legacyDone ? 'Older version recorded a start only; check Chrome Downloads before retrying.' : link.error ?? null,
    filename: legacyShareDone ? null : link.filename ?? null,
    bytes: legacyShareDone ? null : link.bytes ?? null,
    addedAt: link.addedAt ?? new Date().toISOString(),
    updatedAt: link.updatedAt ?? link.addedAt ?? new Date().toISOString(),
  };
}

export class MirrorLinkStore {
  private cache: MirrorLink[] | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly area: StorageArea) {}

  /**
   * Run a mutation on its own.
   *
   * A mutation reads the whole list, changes one row and writes it back, so two
   * of them interleaved would drop one change (a file that downloaded perfectly
   * would stay "in the queue" in the Links tab). Chaining keeps the read inside
   * the same critical section as the write.
   */
  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const next = this.chain.then(task, task);
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async list(): Promise<MirrorLink[]> {
    if (!this.cache) {
      const stored = await this.area.get<unknown>(STORAGE_KEYS.links);
      this.cache = Array.isArray(stored) ? stored.filter(isMirrorLink).map(normalizeLink) : [];
    }
    return this.cache.map((link) => ({ ...link }));
  }

  async stats(): Promise<MirrorLinkStats> {
    const links = await this.list();
    const stats: MirrorLinkStats = { total: links.length, new: 0, queued: 0, done: 0, failed: 0, unverified: 0 };
    for (const link of links) stats[link.status] += 1;
    return stats;
  }

  async byId(id: string): Promise<MirrorLink | null> {
    return (await this.list()).find((link) => link.id === id) ?? null;
  }

  async byUrl(url: string): Promise<MirrorLink | null> {
    return (await this.list()).find((link) => link.url === url) ?? null;
  }

  /**
   * Add collected links.
   *
   * A URL that is already stored is *merged*, not duplicated: the newest post
   * context wins (a file is often re-linked by a newer post) while an existing
   * download outcome - `done`, `failed`, its filename and error - is preserved,
   * so re-scanning a creator never hides a file you already have.
   */
  async add(links: readonly MirrorLink[]): Promise<{ added: number; updated: number; total: number; addedIds: string[]; resolvedIds: string[] }> {
    return this.serialize(async () => {
      const existing = await this.list();
      const index = new Map(existing.map((link) => [link.id, link]));
      const byUrl = new Map(existing.map((link) => [link.url, link.id]));
      let added = 0;
      let updated = 0;
      const addedIds: string[] = [];
      // One stored ID for each input, including old IDs retained on recovery.
      const resolvedIds: string[] = [];

      for (const incoming of links) {
        const exactId = byUrl.get(incoming.url);
        let current = exactId ? index.get(exactId) : undefined;
        let recoveredKey = false;
        if (!current) {
          const keyless = legacyMegaKeylessUrl(incoming.url);
          const legacy = keyless ? index.get(mirrorLinkId(keyless)) : undefined;
          // Reuse only a genuinely keyless old row. Distinct keyed URLs must
          // stay distinct; old /#... links have no recoverable identity.
          if (legacy && legacy.url === keyless) {
            current = legacy;
            recoveredKey = true;
          }
        }
        if (!current) {
          const record = normalizeLink(incoming);
          index.set(record.id, record);
          byUrl.set(record.url, record.id);
          added += 1;
          addedIds.push(record.id);
          resolvedIds.push(record.id);
          continue;
        }
        const next: MirrorLink = {
          ...current,
          url: recoveredKey ? incoming.url : current.url,
          host: incoming.host || current.host,
          provider: incoming.provider || current.provider,
          serverId: incoming.serverId ?? current.serverId,
          siteType: incoming.siteType ?? current.siteType,
          postId: incoming.postId ?? current.postId,
          postTitle: incoming.postTitle ?? current.postTitle,
          postUrl: incoming.postUrl ?? current.postUrl,
          creator: incoming.creator ?? current.creator,
          // Old Mega "done" could have been a saved HTML landing page, not a
          // file. Preserve a pending queue relationship, but not that outcome.
          status: recoveredKey && current.status !== 'queued' ? 'new' : current.status,
          filename: recoveredKey ? null : current.filename,
          bytes: recoveredKey ? null : current.bytes,
          error: recoveredKey ? null : current.error,
          updatedAt: new Date().toISOString(),
        };
        index.set(current.id, next);
        byUrl.delete(current.url);
        byUrl.set(next.url, next.id);
        resolvedIds.push(next.id);
        updated += 1;
      }

      const next = [...index.values()].slice(-MAX_MIRROR_LINKS);
      this.cache = next;
      await this.area.set(STORAGE_KEYS.links, next);
      return { added, updated, total: next.length, addedIds, resolvedIds };
    });
  }

  async remove(ids: readonly string[]): Promise<number> {
    return this.serialize(async () => {
      const wanted = new Set(ids);
      const links = await this.list();
      this.cache = links.filter((link) => !wanted.has(link.id));
      await this.area.set(STORAGE_KEYS.links, this.cache);
      return links.length - this.cache.length;
    });
  }

  /** Clear the list. `scope: 'done'` keeps everything that is not finished yet. */
  async clear(scope: 'all' | 'done' | 'pending' = 'all'): Promise<number> {
    return this.serialize(async () => {
      const links = await this.list();
      if (scope === 'all') this.cache = [];
      else if (scope === 'done') this.cache = links.filter((link) => link.status !== 'done');
      else this.cache = links.filter((link) => link.status !== 'new' && link.status !== 'queued');
      await this.area.set(STORAGE_KEYS.links, this.cache);
      return links.length - this.cache.length;
    });
  }

  /** Update one row's download state (called by the queue, never by the UI). */
  async mark(id: string, status: MirrorLinkStatus, patch: Partial<MirrorLink> = {}): Promise<MirrorLink | null> {
    return this.serialize(async () => {
      const links = await this.list();
      const index = links.findIndex((link) => link.id === id);
      if (index < 0) return null;
      const current = links[index]!;
      const next: MirrorLink = {
        ...current,
        ...patch,
        status,
        completion: status === 'done' ? 'browser-complete' : undefined,
        attempts: patch.attempts ?? current.attempts,
        updatedAt: new Date().toISOString(),
      };
      links[index] = next;
      this.cache = links;
      await this.area.set(STORAGE_KEYS.links, links);
      return { ...next };
    });
  }

  /** Same as `mark`, keyed by URL - the queue only knows the URL it downloads. */
  async markByUrl(url: string, status: MirrorLinkStatus, patch: Partial<MirrorLink> = {}): Promise<MirrorLink | null> {
    const link = await this.byUrl(url);
    return link ? this.mark(link.id, status, patch) : null;
  }

  /** Reset every row the queue owns back to `new` (used when rows are removed). */
  async release(ids: readonly string[]): Promise<number> {
    return this.serialize(async () => {
      const links = await this.list();
      const wanted = new Set(ids);
      let changed = 0;
      const next = links.map((link) => {
        if (!wanted.has(link.id) || link.status !== 'queued') return link;
        changed += 1;
        return { ...link, status: 'new' as const, updatedAt: new Date().toISOString() };
      });
      if (changed) {
        this.cache = next;
        await this.area.set(STORAGE_KEYS.links, next);
      }
      return changed;
    });
  }

  invalidate(): void {
    this.cache = null;
  }
}
