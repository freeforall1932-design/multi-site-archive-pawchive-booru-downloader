import { inspectPawchivePost, normalizePawchiveBaseUrl, parsePawchiveQuery } from '../adapters/pawchive.js';
import { BooruError } from '../shared/errors.js';
import type {
  BooruPost,
  DownloadHistoryEntry,
  DownloadTask,
  ExtensionSettings,
  FailureKind,
  MirrorLink,
  SearchHistoryEntry,
  ServerConfig,
  TaskRun,
  TaskView,
} from '../shared/types.js';
import { deepClone, splitTags, uniqueBy } from '../shared/util.js';
import type { BooruClient } from './client.js';
import { requireOriginalFile, type Downloader } from './downloads.js';
import type { DiagnosticsInfo, RouterResponse, UiRequest } from './messages.js';
import { buildDownloadPath, sanitizePathSegment } from './naming.js';
import type { DownloadQueue } from './queue.js';
import { createAdapterContext, detectAdapterForUrl, getAdapter } from './registry.js';
import type { ServerStore } from './servers.js';
import { toServerView } from './servers.js';
import { DownloadHistoryStore, SearchHistoryStore } from './history.js';
import {
  classifyMirrorLink,
  collectMirrorLinks,
  formatLinkExport,
  linkLabel,
  mirrorLinkId,
  ownHostsOf,
  parseLinkExport,
  toMirrorLink,
} from './links.js';
import { MirrorLinkStore } from './link-store.js';
import { TaskStore } from './task-store.js';
import {
  creatorQuery,
  formatTaskManifest,
  manifestFilename,
  mergeTask,
  parseCreatorQuery,
  parseTaskPackage,
  planTaskRun,
  startRun,
  statsLabel,
  taskCompletion,
  taskIdFor,
  taskNameFor,
  taskStatsFor,
} from './tasks.js';
import { composeSearchTags } from './search.js';
import type { SettingsStore } from './settings.js';
import { STORAGE_KEYS, type StorageArea } from './storage.js';

export interface RouterDeps {
  client: BooruClient;
  queue: DownloadQueue;
  servers: ServerStore;
  settings: SettingsStore;
  downloader: Downloader;
  syncUserAgentRules?: (servers: ServerConfig[], settings: ExtensionSettings) => Promise<{ ok: boolean; applied: number; error?: string }>;
  /** Storage used by the side panel's history notebooks (optional in tests). */
  storage?: StorageArea;
  /** Pre-built history stores (the worker reuses them with the queue). */
  history?: DownloadHistoryStore;
  searches?: SearchHistoryStore;
  /** Collected mirror links (the Links tab); built from `storage` when omitted. */
  links?: MirrorLinkStore;
  /** Download tasks (one per creator); built from `storage` when omitted. */
  tasks?: TaskStore;
  environment: 'extension' | 'preview';
  version: string;
}

export type UiMessageHandler = (request: UiRequest) => Promise<RouterResponse>;

/**
 * A readable name from an imported file's own name, used when the file carries no
 * creator (`artist_a_links.txt` → `artist a`).
 */
function fileNameHint(filename: string | null | undefined): string {
  return (filename ?? '')
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[_-]+/g, ' ')
    // `artist_a_download_links.txt` is about `artist a`, not about "download links".
    .replace(/\b(download links|downloads|links|mirror|mirrors)\b\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * One request handler for every surface (service worker, popup, options page and
 * the browser preview). The UI only ever sends `UiRequest`s - it never touches
 * an adapter, a credential or a network call itself.
 *
 * Server credentials are masked in responses. Collected mirror URLs intentionally
 * retain fragments and may themselves contain bearer or decryption keys.
 */
export function createRouter(deps: RouterDeps): UiMessageHandler {
  const historyStore = deps.history ?? (deps.storage ? new DownloadHistoryStore(deps.storage) : null);
  const searchStore = deps.searches ?? (deps.storage ? new SearchHistoryStore(deps.storage) : null);
  const linkStore = deps.links ?? (deps.storage ? new MirrorLinkStore(deps.storage) : null);
  const taskStore = deps.tasks ?? (deps.storage ? new TaskStore(deps.storage) : null);

  /** The mirror-link rules currently in force, from settings + the profile. */
  async function linkRulesFor(server: ServerConfig | null): Promise<Parameters<typeof collectMirrorLinks>[2]> {
    const settings = await deps.settings.get();
    return {
      filter: settings.mirrorLinksFilter,
      extraHosts: splitTags(settings.mirrorExtraHosts),
      ownHosts: ownHostsOf(server),
    };
  }

  /** Empty answer for every links/* request when no storage is available. */
  function noLinks() {
    return { links: [] as MirrorLink[], stats: { total: 0, new: 0, queued: 0, done: 0, failed: 0, unverified: 0 } };
  }
  /** Resolve a post (by URL, by id, or the default server) and save the file. */
  async function downloadPost(options: { serverId?: string | null; postId?: string; url?: string }) {
    let post: BooruPost;
    let server: ServerConfig;
    if (options.url) {
      const resolved = await deps.client.resolvePostFromUrl(options.url);
      post = resolved.post;
      server = resolved.server;
    } else {
      if (!options.postId) throw new BooruError('A post id or post URL is required', { kind: 'incomplete-config' });
      const target = await deps.client.resolve(options.serverId ?? null);
      server = target.server;
      post = await deps.client.getPost(server.id, options.postId);
    }

    const settings = await deps.settings.get();
    const adapter = getAdapter(server.siteType);
    if (settings.enforceRatingFilterOnDownload && adapter && !deps.client.isRatingAllowed(server, adapter, post.rating)) {
      throw new BooruError(`Post ${post.id} is rated "${post.rating}", which this server's filter excludes`, {
        kind: 'incomplete-config',
        hint: 'Allow that rating in the server config, or turn off rating enforcement in Settings.',
      });
    }

    const path = buildDownloadPath({
      post,
      server,
      settings: {
        folderTemplate: settings.folderTemplate,
        filenameTemplate: settings.filenameTemplate,
        maxTagsInFilename: settings.maxTagsInFilename,
        tagSeparator: settings.tagSeparator,
      },
    });
    requireOriginalFile(post);
    const outcome = await deps.queue.startDirect({
      server,
      post,
      filename: path.fullPath,
      conflictAction: settings.duplicateBehaviour === 'overwrite' ? 'overwrite' : 'uniquify',
    });
    return { filename: path.fullPath, post, viaFallback: outcome.viaFallback, downloadId: outcome.downloadId };
  }

  /**
   * Removing a link from the Links tab also drops the *pending* queue row it
   * created, so the user does not have to clean up twice. Finished rows are
   * history and are left alone (the Queue tab has "Clear finished" for those).
   */
  async function dropPendingQueueRowsFor(linkIds: readonly string[]): Promise<void> {
    await deps.queue.refresh();
    const wanted = new Set(linkIds);
    const rows = deps.queue
      .list()
      .filter((item) => item.kind === 'link' && item.status === 'pending' && wanted.has(item.postId))
      .map((item) => item.id);
    if (rows.length) await deps.queue.remove(rows);
  }

  /** A task plus its file statistics - what every task response carries. */
  async function taskViewFor(task: DownloadTask): Promise<TaskView> {
    const links = (await linkStore?.list()) ?? [];
    const stats = taskStatsFor(task, links);
    return {
      task,
      stats,
      completion: taskCompletion(stats),
      lastRun: task.runs.length ? task.runs[task.runs.length - 1]! : null,
    };
  }

  async function taskViews(): Promise<TaskView[]> {
    const tasks = (await taskStore?.list()) ?? [];
    const views: TaskView[] = [];
    // Newest first: the task someone just imported is the one they are looking at.
    for (const task of [...tasks].reverse()) views.push(await taskViewFor(task));
    return views;
  }

  /** Mirror-link collection reads Pawchive post bodies; booru browsing is separate. */
  async function pawchiveServer(id: string): Promise<ServerConfig> {
    const server = await deps.servers.get(id);
    if (!server) throw new BooruError(`Unknown server "${id}"`, { kind: 'incomplete-config' });
    if (server.siteType !== 'pawchive') {
      throw new BooruError('Link collection requires a Pawchive profile', {
        kind: 'unsupported-site',
        hint: 'Choose a Pawchive profile for creator links. Your booru profiles are still available for browsing and downloads.',
      });
    }
    normalizePawchiveBaseUrl(server.baseUrl);
    return server;
  }

  /** The saved profile a task should be collected with (its own, else a match). */
  async function serverForTask(task: DownloadTask): Promise<ServerConfig | null> {
    // A package from a retired site must never be silently rescanned as a
    // different creator on Pawchive, even if a Pawchive profile is selected.
    if (task.siteType && task.siteType !== 'pawchive') return null;
    if (task.serverId) {
      const own = await deps.servers.get(task.serverId);
      if (own?.siteType === 'pawchive') return own;
    }
    if (!task.siteType) return null;
    return (await deps.servers.list()).find((server) => server.siteType === 'pawchive') ?? null;
  }

  /**
   * End the newest run of a task once none of its files is waiting any more, so a
   * finished task can say how the last pass actually went.
   */
  async function closeRunIfSettled(task: DownloadTask): Promise<DownloadTask> {
    if (!taskStore || !linkStore || !task.runs.length) return task;
    const links = await linkStore.list();
    const stats = taskStatsFor(task, links);
    if (stats.queued > 0) return task;
    const last = task.runs[task.runs.length - 1]!;
    if (last.finishedAt) return task;
    return (
      (await taskStore.updateLastRun(task.id, {
        finishedAt: new Date().toISOString(),
        done: stats.done,
        failed: stats.failed,
        note: statsLabel(stats),
      })) ?? task
    );
  }

  /** Build a task record from a package (or from a collect run) and store it. */
  async function upsertTask(input: {
    id: string;
    name: string;
    siteType: ServerConfig['siteType'] | null;
    serverId: string | null;
    service: string | null;
    creator: string | null;
    query: string;
    memberIds: string[];
    scannedPosts?: string[];
    runs?: TaskRun[];
    lastScanAt?: string | null;
    incoming?: DownloadTask | null;
  }): Promise<{ task: DownloadTask; created: boolean }> {
    if (!taskStore) {
      const now = new Date().toISOString();
      const task: DownloadTask = {
        id: input.id,
        name: input.name,
        siteType: input.siteType,
        serverId: input.serverId,
        service: input.service,
        creator: input.creator,
        query: input.query,
        createdAt: now,
        updatedAt: now,
        lastScanAt: input.lastScanAt ?? null,
        memberIds: input.memberIds,
        scannedPosts: input.scannedPosts ?? [],
        runs: input.runs ?? [],
      };
      return { task, created: true };
    }
    const existing = await taskStore.get(input.id);
    const now = new Date().toISOString();
    const fresh: DownloadTask = {
      id: input.id,
      name: input.name,
      siteType: input.siteType,
      serverId: input.serverId,
      service: input.service,
      creator: input.creator,
      query: input.query,
      createdAt: input.incoming?.createdAt ?? now,
      updatedAt: now,
      lastScanAt: input.lastScanAt ?? null,
      memberIds: input.memberIds,
      scannedPosts: input.scannedPosts ?? [],
      runs: input.runs ?? [],
    };
    return taskStore.upsert(existing ? mergeTask(existing, fresh) : fresh);
  }

  /**
   * Rescan a task's creator: list the posts it has not scanned yet, harvest their
   * links and attach them.
   *
   * This is what makes "run it again" meaningful months later - new posts appear,
   * old files fail; a run adds the new ones and retries the failures (the queue
   * side of that is `planTaskRun`). It is bounded: a rescan reads at most
   * `maxPosts` posts and reports whether the creator has more.
   */
  async function rescanTask(task: DownloadTask, maxPosts: number): Promise<{ scannedPosts: number; added: number; failed: number; hasMore: boolean }> {
    if (!linkStore) return { scannedPosts: 0, added: 0, failed: 0, hasMore: false };
    const server = await serverForTask(task);
    if (!server) {
      throw new BooruError(`Task "${task.name}" has no profile to collect with`, {
        kind: 'incomplete-config',
        hint: 'Add a profile for this site type (Servers tab), then rescan.',
      });
    }
    await pawchiveServer(server.id);
    const query = creatorQuery(task);
    if (!query) {
      throw new BooruError(`Task "${task.name}" does not remember a creator to re-list`, {
        kind: 'incomplete-config',
        hint: 'A plain URL list cannot be rescanned - import a task package instead.',
      });
    }

    // Older versions stored the first attachment index rather than the post id.
    const seen = new Set(task.scannedPosts.map((id) => {
      const parts = id.split('/');
      return parts.length === 4 && /^\d+$/.test(parts[3] ?? '') ? parts.slice(0, 3).join('/') : id;
    }));
    const pageSize = 50;
    const pageLimit = Math.max(1, Math.ceil(maxPosts / pageSize));
    let scanned = 0;
    let added = 0;
    let failed = 0;
    let hasMore = false;

    for (let page = 1; page <= pageLimit; page += 1) {
      const result = await deps.client.search(server.id, { tags: query, page, limit: pageSize });
      const posts = uniqueBy(
        result.sourcePosts ?? result.posts.map((post) => ({ id: post.id, postUrl: post.postUrl, label: post.description?.trim() || `#${post.id}` })),
        (post) => post.postUrl,
      );
      hasMore = result.hasMore;
      for (const post of posts) {
        if (scanned >= maxPosts) {
          hasMore = true;
          break;
        }
        if (seen.has(post.id)) continue;
        try {
          const payload = await deps.client.getPostPayload(server.id, post.id);
          const found = collectMirrorLinks(
            payload,
            {
              serverId: server.id,
              siteType: server.siteType,
              postId: post.id,
              postTitle: post.label,
              postUrl: post.postUrl,
              creator: query,
            },
            await linkRulesFor(server),
          );
          const stored = await linkStore.add(found);
          added += stored.addedIds.length;
          await taskStore?.attachMembers(task.id, stored.resolvedIds, [post.id]);
        } catch {
          // One unreadable post must not end the rescan; it stays unscanned so the
          // next attempt picks it up again.
          failed += 1;
        }
        scanned += 1;
        seen.add(post.id);
      }
      if (!result.hasMore) break;
    }

    await taskStore?.attachMembers(task.id, [], [...seen]);
    return { scannedPosts: scanned, added, failed, hasMore };
  }

  /**
   * A task with no surviving files is bookkeeping with nothing left to describe:
   * drop it, so clearing the list does not leave empty cards behind.
   */
  async function pruneTasksWithoutFiles(): Promise<void> {
    if (!taskStore || !linkStore) return;
    await taskStore.pruneEmpty((await linkStore.list()).map((link) => link.id));
  }

  async function handle(request: UiRequest): Promise<RouterResponse> {
    try {
      return { ok: true, data: await route(request) };
    } catch (error) {
      const booruError =
        error instanceof BooruError
          ? error
          : new BooruError(error instanceof Error ? error.message : String(error), { kind: 'unknown' });
      return {
        ok: false,
        error: { message: booruError.message, kind: booruError.kind as FailureKind, hint: booruError.hint },
      };
    }
  }

  async function route(request: UiRequest): Promise<unknown> {
    switch (request.type) {
      // ------------------------------------------------------------- servers
      case 'servers/list':
        return deps.servers.listViews();

      case 'servers/save':
        return toServerView(await deps.servers.save(request.payload));

      case 'servers/remove':
        return (await deps.servers.remove(request.payload.id)).map(toServerView);

      case 'servers/duplicate':
        return toServerView(await deps.servers.duplicate(request.payload.id));

      case 'servers/setDefault':
        return (await deps.servers.setDefault(request.payload.id)).map(toServerView);

      case 'servers/validate':
        return deps.client.validateServer(request.payload.id);

      case 'servers/validateDraft':
        return deps.client.validateDraft(await draftServerConfig(request.payload.server));

      case 'servers/clearCredentials': {
        const updated = await deps.servers.clearCredentials(request.payload.id);
        return updated ? toServerView(updated) : null;
      }

      case 'servers/export': {
        const includeSecrets = request.payload?.includeSecrets === true;
        return { json: await deps.servers.exportServers({ includeSecrets }), includesSecrets: includeSecrets };
      }

      case 'servers/import':
        return deps.servers.importServers(request.payload.json, { includeSecrets: request.payload.includeSecrets === true });

      // -------------------------------------------------------------- browse
      case 'browse/search': {
        // Pawchive queries are creators/titles, not booru tag expressions.
        // Adding a booru blacklist would turn `service/creator` into a title search.
        const { server } = await deps.client.resolve(request.payload.serverId);
        const settings = await deps.settings.get();
        const tags = server.siteType === 'pawchive'
          ? request.payload.spec.tags ?? ''
          : composeSearchTags({ tags: request.payload.spec.tags ?? '', blacklist: settings.tagBlacklist }).tags;
        return deps.client.search(server.id, { ...request.payload.spec, tags });
      }

      case 'posts/get':
        return deps.client.getPost(request.payload.serverId, request.payload.postId);

      case 'posts/resolveUrl': {
        const { post, server, route: resolved } = await deps.client.resolvePostFromUrl(request.payload.url);
        return { post, server: toServerView(server), route: resolved };
      }

      case 'posts/download':
        return downloadPost(request.payload);

      case 'routes/detect': {
        const detected = await deps.client.resolveRoute(request.payload.url);
        if (!detected) return null;
        return { ...detected, server: detected.server ? toServerView(detected.server) : null };
      }

      // --------------------------------------------------------------- links
      case 'links/list': {
        await deps.queue.refresh();
        if (!linkStore) return noLinks();
        return { links: await linkStore.list(), stats: await linkStore.stats() };
      }

      /**
       * One listing page, reduced to the *posts* it contains.
       *
       * Creator archives answer with one row per attachment, so a post with
       * four files appears four times with the same `postUrl` - the scan wants
       * the post once. Nothing is fetched per post here: the panel walks the
       * refs one at a time through `links/scanPost`, which keeps progress
       * visible and the request spacing honest.
       */
      case 'links/posts': {
        await pawchiveServer(request.payload.serverId);
        const result = await deps.client.search(request.payload.serverId, {
          tags: request.payload.query,
          page: request.payload.page,
          limit: 50,
        });
        const posts = uniqueBy(
          result.sourcePosts ?? result.posts.map((post) => ({
            id: post.id,
            label: post.description?.trim() || `#${post.id}`,
            postUrl: post.postUrl,
          })),
          (post) => post.postUrl,
        );
        return { posts, hasMore: result.hasMore, totalCount: result.totalCount, page: result.page };
      }

      /**
       * Read one post's raw payload and harvest its off-site download links.
       *
       * This is the extension's version of the "open every post of the creator
       * and read the links" userscript loop - except the page is never parsed:
       * the same public API the downloader already uses answers with the post
       * body, and the URLs are pulled out of that.
       */
      case 'links/scanPost': {
        if (!linkStore) return { added: [] as MirrorLink[], duplicates: 0, total: 0 };
        const { serverId, postId } = request.payload;
        const server = await pawchiveServer(serverId);
        const payload = await deps.client.getPostPayload(server.id, postId);
        const found = collectMirrorLinks(
          payload,
          {
            serverId: server.id,
            siteType: server.siteType,
            postId,
            postTitle: request.payload.postTitle ?? null,
            postUrl: request.payload.postUrl ?? null,
            creator: request.payload.creator ?? null,
          },
          await linkRulesFor(server),
        );
        const result = await linkStore.add(found);
        // A scan that belongs to a task joins its member list, which is what makes
        // "download everything again" and "what is new?" answerable later.
        if (request.payload.taskId && taskStore) {
          const task = await taskStore.get(request.payload.taskId);
          if (task) await taskStore.attachMembers(task.id, result.resolvedIds, [postId]);
        }
        return {
          added: found.filter((_link, index) => result.addedIds.includes(result.resolvedIds[index] ?? '')),
          duplicates: result.updated,
          total: result.total,
        };
      }

      /** Put collected links on the download queue (they download as `link` rows). */
      case 'links/queue': {
        if (!linkStore) return { queued: 0, skipped: 0, invalid: 0, ...noLinks() };
        const wanted = new Set(request.payload.ids);
        const chosen = (await linkStore.list()).filter((link) => wanted.has(link.id));
        const result = await deps.queue.enqueueLinks(
          chosen.map((link) => ({
            id: link.id,
            url: link.url,
            label: linkLabel(link),
            postUrl: link.postUrl,
            serverId: link.serverId,
          })),
        );
        for (const link of chosen) {
          await linkStore.mark(link.id, 'queued');
        }
        return { queued: result.added, skipped: result.skipped, invalid: result.invalid, links: await linkStore.list(), stats: await linkStore.stats() };
      }

      case 'links/remove': {
        if (!linkStore) return { removed: 0, ...noLinks() };
        const removed = await linkStore.remove(request.payload.ids);
        await dropPendingQueueRowsFor(request.payload.ids);
        await pruneTasksWithoutFiles();
        return { removed, links: await linkStore.list(), stats: await linkStore.stats() };
      }

      case 'links/clear': {
        if (!linkStore) return { removed: 0, ...noLinks() };
        const scope = request.payload.scope ?? 'all';
        const before = (await linkStore.list()).map((link) => link.id);
        const removed = await linkStore.clear(scope);
        const surviving = new Set((await linkStore.list()).map((link) => link.id));
        await dropPendingQueueRowsFor(before.filter((id) => !surviving.has(id)));
        // A task whose files are all gone is bookkeeping with nothing left to
        // describe; drop it so the Links tab does not accumulate ghosts.
        await pruneTasksWithoutFiles();
        return { removed, links: await linkStore.list(), stats: await linkStore.stats() };
      }

      /** Render the `.txt` the Links tab downloads (and can import again). */
      case 'links/export': {
        if (!linkStore) return { text: '', filename: 'mirror-links.txt', count: 0, grouping: 'post' as const };
        const links = await linkStore.list();
        const grouping = request.payload.grouping ?? 'post';
        const firstServerId = links.find((link) => link.serverId)?.serverId ?? null;
        const server = firstServerId ? await deps.servers.get(firstServerId) : null;
        const creator = links.find((link) => link.creator)?.creator ?? null;
        const text = formatLinkExport(links, {
          grouping,
          creator,
          server: server ? `${server.label} (${server.baseUrl})` : (links[0]?.siteType ?? null),
          version: deps.version,
        });
        const safeCreator = sanitizePathSegment(creator ?? server?.label ?? 'mirror', 'mirror').replace(/\s+/g, '_');
        return { text, filename: `${safeCreator}_download_links.txt`, count: links.length, grouping };
      }

      /** Read one back: rebuild the list (and optionally the queue) from a file. */
      case 'links/import': {
        if (!linkStore) return { parsed: 0, added: 0, updated: 0, queued: 0, invalid: 0, ...noLinks() };
        const parsed = parseLinkExport(request.payload.text);
        const server = request.payload.serverId ? await deps.servers.get(request.payload.serverId) : null;
        const now = new Date();
        const records: MirrorLink[] = [];
        let invalid = 0;
        for (const url of parsed.links) {
          // An imported file is an explicit instruction: no provider/format
          // filter and no own-host rule is applied, only validity.
          const verdict = classifyMirrorLink(url, { filter: 'any' });
          if (!verdict.ok) {
            invalid += 1;
            continue;
          }
          const context = parsed.contexts.get(url) ?? {};
          records.push(
            toMirrorLink(verdict, {
              serverId: server?.id ?? null,
              siteType: server?.siteType ?? null,
              postId: null,
              postTitle: context.postTitle ?? null,
              postUrl: context.postUrl ?? null,
              creator: context.creator ?? null,
            }, now),
          );
        }
        const result = await linkStore.add(records);
        let queued = 0;
        if (request.payload.queue && records.length) {
          const chosen = (await linkStore.list()).filter((link) => result.resolvedIds.includes(link.id));
          const enqueued = await deps.queue.enqueueLinks(
            chosen.map((link) => ({ id: link.id, url: link.url, label: linkLabel(link), postUrl: link.postUrl, serverId: link.serverId })),
          );
          queued = enqueued.added;
          for (const link of chosen) {
            await linkStore.mark(link.id, 'queued');
          }
        }
        return {
          parsed: parsed.links.length,
          added: result.added,
          updated: result.updated,
          queued,
          invalid,
          links: await linkStore.list(),
          stats: await linkStore.stats(),
        };
      }

      // --------------------------------------------------------------- tasks
      /**
       * The task list. A task is one creator plus the files that belong to them:
       * the unit a package is exported as, and the unit "run it again" applies to.
       */
      case 'tasks/list': {
        await deps.queue.refresh();
        return { tasks: await taskViews() };
      }

      /** Open (or fetch) the task a collect run belongs to, before scanning. */
      case 'tasks/begin': {
        const server = await pawchiveServer(request.payload.serverId);
        const query = request.payload.query.trim();
        parsePawchiveQuery(query); // Reject creator URLs belonging to other sites.
        const parsed = parseCreatorQuery(query);
        const id = taskIdFor({ siteType: server.siteType, service: parsed.service, creator: parsed.creator, query });
        const { task, created } = await upsertTask({
          id,
          name: request.payload.name?.trim() || taskNameFor({ service: parsed.service, creator: parsed.creator, query }),
          siteType: server.siteType,
          serverId: server.id,
          service: parsed.service,
          creator: parsed.creator,
          query,
          memberIds: [],
        });
        return { task: await taskViewFor(task), created };
      }

      /**
       * "Pick from file": read a task package (or a plain link list) and rebuild
       * the job from it.
       *
       * The file is the instruction - imported URLs are added with no provider
       * filter and no own-host rule - and a package that is already known merges
       * into its task instead of duplicating it. Nothing downloads until the user
       * presses Start.
       */
      case 'tasks/import': {
        if (!linkStore || !taskStore) {
          return { kind: 'unknown' as const, created: false, parsed: 0, added: 0, updated: 0, invalid: 0, task: null, error: 'Storage is unavailable.' };
        }
        const parsed = parseTaskPackage(request.payload.text);
        const selectedServer = request.payload.serverId ? await deps.servers.get(request.payload.serverId) : null;
        const server = selectedServer && (!parsed.task?.siteType || parsed.task.siteType === selectedServer.siteType) ? selectedServer : null;

        // Plain list: reuse the tolerant reader (bullets, comments, duplicates).
        const list = parsed.kind === 'json' ? null : parseLinkExport(request.payload.text);
        const urls = parsed.kind === 'json' ? parsed.urls : (list?.links ?? []);
        if (parsed.kind === 'unknown') {
          return { kind: 'unknown' as const, created: false, parsed: 0, added: 0, updated: 0, invalid: 0, task: null, error: parsed.error };
        }
        if (!urls.length) {
          return {
            kind: parsed.kind,
            created: false,
            parsed: 0,
            added: 0,
            updated: 0,
            invalid: 0,
            task: null,
            error: 'No http(s) link was found in this file.',
          };
        }

        const now = new Date();
        const records: MirrorLink[] = [];
        let invalid = 0;
        for (const url of urls) {
          const verdict = classifyMirrorLink(url, { filter: 'any' });
          if (!verdict.ok) {
            invalid += 1;
            continue;
          }
          // Post context comes from the manifest when there is one, else from the
          // `# Post:` headers of a grouped list - so imported rows still group.
          const packaged = parsed.files.get(mirrorLinkId(verdict.url)) ?? null;
          const fromText = list?.contexts.get(verdict.url) ?? null;
          records.push(
            toMirrorLink(
              verdict,
              {
                serverId: server?.id ?? null,
                siteType: (parsed.task?.siteType ?? server?.siteType ?? null) as MirrorLink['siteType'],
                postId: packaged?.postId ?? null,
                postTitle: packaged?.postTitle ?? fromText?.postTitle ?? null,
                postUrl: packaged?.postUrl ?? fromText?.postUrl ?? null,
                creator: parsed.creator ?? fromText?.creator ?? null,
              },
              now,
            ),
          );
        }
        const stored = await linkStore.add(records);

        // Who the task is about: the manifest says it outright; a `.txt` list says
        // it in its `# Creator:` header (`fanbox/1245946`); only a list with
        // neither falls back to the file's own name.
        const headerCreator =
          parsed.creator ??
          [...(list?.contexts.values() ?? [])].map((context) => context.creator ?? null).find((value): value is string => !!value) ??
          null;
        const fromHeader = headerCreator ? parseCreatorQuery(headerCreator) : { service: null, creator: null };
        // A `.txt` names no site type, but its `# Post:` URLs do - and knowing it
        // is what makes the text half and the manifest half land on the *same*
        // task instead of two.
        const siteFromPosts =
          parsed.task?.siteType ??
          server?.siteType ??
          [...(list?.contexts.values() ?? [])]
            .map((context) => (context.postUrl ? detectAdapterForUrl(context.postUrl)?.adapter.siteType ?? null : null))
            .find((value): value is ServerConfig['siteType'] => !!value) ??
          null;
        const identity = {
          siteType: siteFromPosts as ServerConfig['siteType'] | null,
          service: parsed.task?.service ?? fromHeader.service,
          creator: parsed.task?.creator ?? fromHeader.creator,
          query: parsed.task?.query ?? headerCreator ?? '',
        };
        const hint = fileNameHint(request.payload.filename);
        const id =
          parsed.kind === 'json' && parsed.task
            ? parsed.task.id
            : taskIdFor({ ...identity, query: identity.query || hint });
        const { task, created } = await upsertTask({
          id,
          name: parsed.task?.name ?? (identity.creator ? taskNameFor(identity) : hint || 'Imported links'),
          siteType: identity.siteType,
          serverId: server?.id ?? null,
          service: identity.service,
          creator: identity.creator,
          query: identity.query || taskNameFor(identity),
          memberIds: stored.resolvedIds,
          scannedPosts: parsed.task?.scannedPosts ?? [],
          runs: parsed.task?.runs ?? [],
          lastScanAt: parsed.task?.lastScanAt ?? null,
        });
        return {
          kind: parsed.kind,
          created,
          parsed: urls.length,
          added: stored.added,
          updated: stored.updated,
          invalid,
          task: await taskViewFor(task),
          error: null,
        };
      }

      /** Write the package: the `.json` manifest and the grouped `.txt` list. */
      case 'tasks/export': {
        if (!taskStore || !linkStore) return null;
        const task = await taskStore.get(request.payload.taskId);
        if (!task) {
          throw new BooruError(`Unknown task "${request.payload.taskId}"`, {
            kind: 'unknown',
            hint: 'Refresh the Links tab - the task may have been removed.',
          });
        }
        const links = (await linkStore.list()).filter((link) => task.memberIds.includes(link.id));
        const server = task.serverId ? await deps.servers.get(task.serverId) : null;
        const manifest = formatTaskManifest(task, links, { tool: `Booru Server Manager ${deps.version}` });
        const text = formatLinkExport(links, {
          grouping: 'post',
          creator: creatorQuery(task),
          server: server ? `${server.label} (${server.baseUrl})` : task.name,
          version: deps.version,
        });
        const base = sanitizePathSegment(task.name, 'task').replace(/\s+/g, '_');
        return {
          files: [
            { filename: manifestFilename(base), text: manifest, mime: 'application/json' },
            { filename: `${base}_download_links.txt`, text, mime: 'text/plain' },
          ],
          count: links.length,
          task: await taskViewFor(task),
        };
      }

      /**
       * Start a task: queue every file it is missing (new ones *and* retries),
       * never one that is already saved unless the caller asks for `mode: 'all'`.
       */
      case 'tasks/run': {
        if (!taskStore || !linkStore) return null;
        let task = await taskStore.get(request.payload.taskId);
        if (!task) {
          throw new BooruError(`Unknown task "${request.payload.taskId}"`, {
            kind: 'unknown',
            hint: 'Refresh the Links tab - the task may have been removed.',
          });
        }
        const links = await linkStore.list();
        const plan = planTaskRun(task, links, request.payload.mode ?? 'missing');
        const chosen = links.filter((link) => plan.ids.includes(link.id));
        const result = await deps.queue.enqueueLinks(
          chosen.map((link) => ({
            id: link.id,
            url: link.url,
            label: linkLabel(link),
            postUrl: link.postUrl,
            serverId: link.serverId,
          })),
        );
        for (const link of chosen) {
          await linkStore.mark(link.id, 'queued');
        }
        task = (await taskStore.recordRun(task.id, startRun({ queued: result.added, note: statsLabel(taskStatsFor(task, await linkStore.list())) }))) ?? task;
        const settings = await deps.settings.get();
        const shouldStart = request.payload.start ?? settings.autoStartQueue;
        if (shouldStart && result.added > 0) await deps.queue.start();
        return {
          task: await taskViewFor(task),
          queued: result.added,
          skipped: result.skipped,
          invalid: result.invalid,
          started: shouldStart && result.added > 0,
          plan: {
            alreadyDone: plan.alreadyDone,
            alreadyQueued: plan.alreadyQueued,
            retrying: plan.retrying,
            total: plan.total,
          },
        };
      }

      /** Pause a task: drop its pending rows; nothing in flight is killed. */
      case 'tasks/pause': {
        if (!taskStore || !linkStore) return null;
        const task = await taskStore.get(request.payload.taskId);
        if (!task) {
          throw new BooruError(`Unknown task "${request.payload.taskId}"`, { kind: 'unknown' });
        }
        await dropPendingQueueRowsFor(task.memberIds);
        const after = await closeRunIfSettled(task);
        return { task: await taskViewFor(after), cancelled: 0 };
      }

      /** Look for posts the task has not seen yet and add the files they link. */
      case 'tasks/rescan': {
        if (!taskStore || !linkStore) return null;
        const task = await taskStore.get(request.payload.taskId);
        if (!task) {
          throw new BooruError(`Unknown task "${request.payload.taskId}"`, { kind: 'unknown' });
        }
        const maxPosts = Math.min(Math.max(1, request.payload.maxPosts ?? 200), 1000);
        const outcome = await rescanTask(task, maxPosts);
        const fresh = (await taskStore.get(task.id)) ?? task;
        const run = startRun({
          scannedPosts: outcome.scannedPosts,
          added: outcome.added,
          note: `${outcome.scannedPosts} new post(s) scanned, ${outcome.added} file(s) added`,
        });
        let updated = (await taskStore.recordRun(fresh.id, run)) ?? fresh;
        updated = (await taskStore.attachMembers(updated.id, [], [])) ?? updated;
        const links = await linkStore.list();
        updated =
          (await taskStore.updateLastRun(updated.id, {
            finishedAt: new Date().toISOString(),
            done: taskStatsFor(updated, links).done,
            failed: outcome.failed,
            note: outcome.failed ? `${outcome.failed} post(s) could not be read` : run.note,
          })) ?? updated;
        return {
          task: await taskViewFor(updated),
          scannedPosts: outcome.scannedPosts,
          added: outcome.added,
          failed: outcome.failed,
          hasMore: outcome.hasMore,
        };
      }

      /** Remove a task; its files stay in the link list unless told otherwise. */
      case 'tasks/remove': {
        if (!taskStore || !linkStore) return { removed: false };
        const task = await taskStore.get(request.payload.taskId);
        if (!task) return { removed: false };
        if (request.payload.keepFiles === false) {
          await linkStore.remove(task.memberIds);
          await dropPendingQueueRowsFor(task.memberIds);
        }
        return { removed: await taskStore.remove(task.id) };
      }

      // --------------------------------------------------------------- queue
      case 'queue/list': {
        await deps.queue.refresh();
        const settings = await deps.settings.get();
        return { summary: deps.queue.summary(), items: deps.queue.list(), maxConcurrency: settings.maxConcurrency };
      }

      case 'queue/enqueue': {
        const result = await deps.queue.enqueue(request.payload.items);
        return { ...result, summary: deps.queue.summary() };
      }

      case 'queue/enqueuePosts': {
        // Rating filtering plus de-duplication live in the queue so the message
        // layer stays a thin translation of UI intent.
        const result = await deps.queue.enqueuePosts(request.payload.serverId, request.payload.posts);
        return { ...result, summary: deps.queue.summary() };
      }

      case 'queue/enqueuePawchivePost': {
        const { server, adapter } = await deps.client.resolve(request.payload.serverId);
        if (server.siteType !== 'pawchive') {
          throw new BooruError('This action requires a Pawchive post.', { kind: 'unsupported-site' });
        }
        const raw = await deps.client.getPostPayload(server.id, request.payload.postId);
        const ctx = createAdapterContext(adapter, server, await deps.settings.get());
        const inspected = inspectPawchivePost(raw, ctx);
        let unavailable = inspected.unavailable;
        const candidates = inspected.posts.filter((post) => {
          try {
            requireOriginalFile(post);
            return true;
          } catch {
            unavailable += 1;
            return false;
          }
        });
        const result = await deps.queue.enqueuePosts(server.id, candidates.map((post) => ({
          id: post.id,
          label: post.description || `Pawchive ${post.id}`,
          postUrl: post.postUrl,
          rating: post.rating,
          expectedFileHash: post.md5,
        })));
        return { ...result, unavailable, summary: deps.queue.summary() };
      }

      case 'queue/enqueueLinks': {
        // Mirror links skip the adapter and the rating filter: the file is not
        // on the site, so there is nothing to look up and nothing to rate.
        const result = await deps.queue.enqueueLinks(request.payload.links, request.payload.serverId ?? '');
        return { ...result, summary: deps.queue.summary() };
      }

      case 'queue/run':
        // Persist the selection before replying; browser transfers continue in the background.
        await deps.queue.start({ onlyIds: request.payload?.itemIds });
        return { started: true, summary: deps.queue.summary() };

      case 'queue/pause':
        await deps.queue.pause();
        return { summary: deps.queue.summary() };

      case 'queue/resume':
        await deps.queue.resume();
        await deps.queue.start();
        return { started: true, summary: deps.queue.summary() };

      case 'queue/retryFailed': {
        const requeued = await deps.queue.retryFailed();
        return { requeued, summary: deps.queue.summary() };
      }

      case 'queue/clear': {
        const removed = await deps.queue.clear(request.payload.scope);
        return { removed, summary: deps.queue.summary() };
      }

      case 'queue/cancel':
        await deps.queue.cancel(request.payload.itemId);
        return { summary: deps.queue.summary() };

      // ------------------------------------------------------------ settings
      case 'queue/remove': {
        const removed = await deps.queue.remove(request.payload.itemIds);
        const summary = deps.queue.summary();
        return { removed, summary };
      }

      // ------------------------------------------------------------- history
      case 'history/list': {
        await deps.queue.refresh();
        const entries = historyStore ? await historyStore.list() : [];
        return { entries, total: entries.length };
      }

      case 'history/remove': {
        if (!historyStore) return { removed: 0, total: 0 };
        const removed = await historyStore.remove(request.payload.serverId, request.payload.postId);
        return { removed, total: await historyStore.size() };
      }

      case 'history/clear': {
        const removed = historyStore ? await historyStore.clear() : 0;
        return { removed };
      }

      case 'searches/list':
        return { entries: searchStore ? await searchStore.list(request.payload?.serverId ?? null) : [] };

      case 'searches/add': {
        if (!searchStore) return { entries: [] };
        const settings = await deps.settings.get();
        if (!settings.searchHistoryEnabled || settings.searchHistoryLimit === 0) {
          return { entries: await searchStore.list(request.payload.serverId) };
        }
        return { entries: await searchStore.add(request.payload.serverId, request.payload.query, settings.searchHistoryLimit) };
      }

      case 'searches/remove':
        return { entries: searchStore ? await searchStore.remove(request.payload.serverId, request.payload.query) : [] };

      case 'searches/clear':
        return { removed: searchStore ? await searchStore.clear(request.payload?.serverId ?? null) : 0 };

      case 'settings/get':
        return deps.settings.get();

      case 'settings/save': {
        const saved = await deps.settings.save(request.payload);
        await resyncUserAgent(saved);
        return saved;
      }

      case 'settings/reset': {
        const saved = await deps.settings.reset();
        await resyncUserAgent(saved);
        return saved;
      }

      case 'userAgent/sync': {
        const settings = await deps.settings.get();
        const servers = await deps.servers.list();
        return (await deps.syncUserAgentRules?.(servers, settings)) ?? { ok: true, applied: 0 };
      }

      // --------------------------------------------------------- diagnostics
      case 'diagnostics/info':
        return buildDiagnostics(deps, true);

      default: {
        const exhaustive: never = request;
        throw new BooruError(`Unsupported request: ${JSON.stringify(exhaustive)}`, { kind: 'unknown' });
      }
    }
  }

  async function resyncUserAgent(settings: ExtensionSettings): Promise<void> {
    if (!deps.syncUserAgentRules) return;
    const servers = await deps.servers.list();
    await deps.syncUserAgentRules(servers, settings);
  }

  /** Build a ServerConfig from unsaved form input so it can be validated. */
  async function draftServerConfig(input: Partial<ServerConfig>): Promise<ServerConfig> {
    const adapter = input.siteType ? getAdapter(input.siteType) : null;
    const draft: ServerConfig = {
      id: input.id ?? 'draft',
      label: (input.label ?? adapter?.defaults.label ?? 'Draft').trim(),
      siteType: input.siteType ?? '',
      baseUrl: (input.baseUrl ?? adapter?.defaults.baseUrl ?? '').trim(),
      ratingFilterEnabled: input.ratingFilterEnabled ?? true,
      username: (input.username ?? '').trim(),
      apiKey: (input.apiKey ?? '').trim(),
      userId: (input.userId ?? '').trim(),
      customUserAgent: (input.customUserAgent ?? '').trim(),
      isDefault: false,
      validationStatus: 'unknown',
      validationMessage: '',
      lastValidatedAt: null,
      allowedRatings: input.allowedRatings,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    // A blank secret on an existing profile means "keep the stored one" - the UI
    // never receives the stored key, so validation must fill it back in.
    if (input.id) {
      const existing = await deps.servers.get(input.id);
      if (existing) {
        if (!draft.apiKey) draft.apiKey = existing.apiKey;
        if (!draft.username) draft.username = existing.username;
        if (!draft.userId) draft.userId = existing.userId;
        if (!draft.customUserAgent) draft.customUserAgent = existing.customUserAgent;
      }
    }
    return draft;
  }

  return handle;
}

export async function buildDiagnostics(deps: RouterDeps, includeUserAgentSync = false): Promise<DiagnosticsInfo> {
  const settings = await deps.settings.get();
  const servers = await deps.servers.list();
  const adapters = deps.client.adapters.map((adapter) => ({
    siteType: adapter.siteType,
    displayName: adapter.displayName,
    capabilitySummary: [
      adapter.capabilities.supportsRatingFilter ? 'rating filter' : 'no rating filter',
      adapter.capabilities.authStyle,
      adapter.capabilities.requiresUserAgent ? 'user-agent required' : 'user-agent optional',
      `${adapter.capabilities.minRequestIntervalMs}ms spacing`,
    ].join(' · '),
    baseUrl: adapter.defaults.baseUrl,
    authStyle: adapter.capabilities.authStyle,
    requiresUserAgent: adapter.capabilities.requiresUserAgent,
    maxPostsPerRequest: adapter.capabilities.maxPostsPerRequest,
    ratingTokens: [...adapter.siteRatingTokens],
    defaultRatings: [...adapter.defaults.ratings],
    supportsRatingFilter: adapter.capabilities.supportsRatingFilter,
    supportsPostLookup: adapter.capabilities.supportsPostLookup,
    apiDocsUrl: adapter.capabilities.apiDocsUrl,
    notes: adapter.capabilities.notes,
    credentialFields: adapter.credentialFields().map((field) => ({
      key: field.key,
      label: field.label,
      required: field.required,
      secret: field.secret,
      help: field.help,
    })),
  }));
  const userAgentRules =
    includeUserAgentSync && deps.syncUserAgentRules
      ? await deps.syncUserAgentRules(servers, settings)
      : { ok: true, applied: 0 };
  return {
    version: deps.version,
    environment: deps.environment,
    storageKeys: Object.values(STORAGE_KEYS),
    settings,
    adapters,
    servers: servers.map((server) => ({
      id: server.id,
      label: server.label,
      siteType: server.siteType,
      baseUrl: server.baseUrl,
      ratingFilterEnabled: server.ratingFilterEnabled,
      hasApiKey: !!server.apiKey,
      validationStatus: server.validationStatus,
      lastValidatedAt: server.lastValidatedAt,
      trace: deepClone(server.lastValidationTrace ?? []),
    })),
    userAgentRules: { ok: userAgentRules.ok, applied: userAgentRules.applied, error: userAgentRules.error },
  };
}
