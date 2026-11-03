import { describe, expect, it, vi } from 'vitest';
import { createHarness, e621Server } from '../helpers.js';
import { ChromeDownloader } from '../../src/core/downloads.js';
import { DownloadHistoryStore } from '../../src/core/history.js';
import { MirrorLinkStore } from '../../src/core/link-store.js';
import { TaskStore } from '../../src/core/task-store.js';
import { DownloadQueue } from '../../src/core/queue.js';
import { createRouter } from '../../src/core/router.js';
import { STORAGE_KEYS } from '../../src/core/storage.js';
import { collectMirrorLinks } from '../../src/core/links.js';
import type { UiRequest } from '../../src/core/messages.js';
import type { DownloadHistoryEntry, QueueItem, TaskView } from '../../src/shared/types.js';
import { MOCK_POSTS } from '../../src/preview/mock-data.js';

type Harness = ReturnType<typeof createHarness>;

async function ready(): Promise<Harness> {
  const harness = createHarness({ settings: { minRequestIntervalMs: 0, maxConcurrency: 4 } });
  await harness.seed({ seedServers: [e621Server({ ratingFilterEnabled: false })] });
  harness.downloader.autoComplete = false;
  return harness;
}

async function ok<T>(harness: Harness, request: UiRequest): Promise<T> {
  const response = await harness.router(request);
  if (!response.ok) throw new Error(JSON.stringify(response.error));
  return response.data as T;
}

function restart(harness: Harness) {
  const history = new DownloadHistoryStore(harness.area);
  const links = new MirrorLinkStore(harness.area);
  const tasks = new TaskStore(harness.area);
  const queue = new DownloadQueue({
    storage: harness.area, client: harness.client, servers: harness.servers, settings: harness.settings,
    downloader: harness.downloader, history, links, tasks,
  });
  const router = createRouter({
    client: harness.client, queue, servers: harness.servers, settings: harness.settings,
    downloader: harness.downloader, storage: harness.area, history, links, tasks,
    environment: 'extension', version: 'restart-test',
  });
  return { queue, history, links, tasks, router };
}

async function queuePost(harness: Harness, postId = String(MOCK_POSTS[0]!.id)) {
  const server = (await harness.servers.getDefault())!;
  await harness.queue.enqueuePosts(server.id, [{ id: postId }]);
  await harness.queue.run();
  return { server, item: harness.queue.list().find((entry) => entry.postId === postId)! };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('Chrome download completion tracking', () => {
  it('keeps a queued post running and out of history until completion, with real byte progress', async () => {
    const harness = await ready();
    const { server, item } = await queuePost(harness);
    const id = item.downloadId!;
    expect(item.status).toBe('running');
    expect(harness.queue.summary()).toMatchObject({ running: 1, done: 0 });
    expect(await harness.history.has(server.id, item.postId)).toBe(false);

    harness.downloader.setState(id, { bytesReceived: 400, totalBytes: 1000 });
    await harness.queue.refresh();
    expect(harness.queue.list()[0]).toMatchObject({ status: 'running', bytesReceived: 400, totalBytes: 1000 });
    expect(await harness.history.list()).toHaveLength(0);

    harness.downloader.setState(id, { state: 'complete', bytesReceived: 1000, totalBytes: 1000, filename: '/private/user/downloads/unique (1).jpg' });
    await harness.queue.handleDownloadChanged(id);
    expect(harness.queue.list()[0]).toMatchObject({ status: 'done', completion: 'browser-complete', bytes: 1000 });
    const history = await harness.history.list();
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ quality: 'original', completion: 'browser-complete', bytes: 1000 });
    expect(history[0]!.filename).toContain('unique (1).jpg');
    expect(history[0]!.filename).not.toContain('/private/user/');
    expect(await harness.history.has(server.id, item.postId)).toBe(true);
  });

  it('marks interrupted downloads failed and retries them without writing false history', async () => {
    const harness = await ready();
    const { item } = await queuePost(harness);
    harness.downloader.setState(item.downloadId!, { state: 'interrupted', error: 'NETWORK_FAILED' });
    await harness.queue.handleDownloadChanged(item.downloadId!);
    expect(harness.queue.list()[0]).toMatchObject({ status: 'failed', errorKind: 'network-failure' });
    expect(await harness.history.list()).toEqual([]);
    expect(await harness.queue.retryFailed()).toBe(1);
    await harness.queue.run();
    const retried = harness.queue.list()[0]!;
    expect(retried).toMatchObject({ status: 'running', attempts: 2 });
    expect(retried.downloadId).not.toBe(item.downloadId);
    harness.downloader.setState(retried.downloadId!, { state: 'complete', bytesReceived: 25 });
    await harness.queue.handleDownloadChanged(retried.downloadId!);
    expect((await harness.history.list())[0]).toMatchObject({ completion: 'browser-complete', bytes: 25 });
  });

  it('tracks direct post downloads without presenting their starts as completed history', async () => {
    const harness = await ready();
    const server = (await harness.servers.getDefault())!;
    const postId = String(MOCK_POSTS[0]!.id);
    const direct = await ok<{ downloadId: number }>(harness, { type: 'posts/download', payload: { serverId: server.id, postId } });
    expect(harness.queue.list()).toMatchObject([{ status: 'running', downloadId: direct.downloadId }]);
    expect(await harness.history.has(server.id, postId)).toBe(false);
    harness.downloader.setState(direct.downloadId, { state: 'interrupted', error: 'SERVER_FAILED' });
    await harness.queue.handleDownloadChanged(direct.downloadId);
    expect(harness.queue.summary()).toMatchObject({ failed: 1, done: 0 });
    expect(await harness.history.list()).toHaveLength(0);

    const next = await ok<{ downloadId: number }>(harness, { type: 'posts/download', payload: { serverId: server.id, postId } });
    harness.downloader.setState(next.downloadId, { state: 'complete', bytesReceived: 42 });
    await harness.queue.handleDownloadChanged(next.downloadId);
    expect(await harness.history.has(server.id, postId)).toBe(true);
    expect(harness.queue.summary()).toMatchObject({ failed: 1, done: 1 });
  });

  it('reuses a pending row for a direct start and refuses a second simultaneous start', async () => {
    const harness = await ready();
    const server = (await harness.servers.getDefault())!;
    const postId = String(MOCK_POSTS[0]!.id);
    await harness.queue.enqueuePosts(server.id, [{ id: postId }]);
    await ok(harness, { type: 'posts/download', payload: { serverId: server.id, postId } });
    expect(harness.queue.list()).toHaveLength(1);
    const duplicate = await harness.router({ type: 'posts/download', payload: { serverId: server.id, postId } });
    expect(duplicate.ok).toBe(false);
    expect(harness.downloader.log).toHaveLength(1);
  });

  it('catches a completion event that occurs before the browser ID is returned and persisted', async () => {
    const harness = await ready();
    const original = harness.downloader.download.bind(harness.downloader);
    harness.downloader.download = async (request) => {
      const result = await original(request);
      harness.downloader.setState(result.downloadId!, { state: 'complete', bytesReceived: 9 });
      // Event is delivered before the queue knows which row owns this ID.
      await harness.queue.handleDownloadChanged(result.downloadId!);
      return result;
    };
    await queuePost(harness);
    expect(harness.queue.summary()).toMatchObject({ done: 1, running: 0 });
    expect((await harness.history.list())[0]).toMatchObject({ completion: 'browser-complete', bytes: 9 });
  });

  it('keeps an accepted Chrome transfer active when persisting its ID fails once', async () => {
    const harness = await ready();
    const server = (await harness.servers.getDefault())!;
    await harness.queue.enqueuePosts(server.id, [{ id: String(MOCK_POSTS[0]!.id) }]);
    const originalSet = harness.area.set.bind(harness.area);
    let rejected = false;
    vi.spyOn(harness.area, 'set').mockImplementation(async (key, value) => {
      const queue = value as { items?: QueueItem[] };
      if (!rejected && key === STORAGE_KEYS.queue && queue.items?.some((item) => typeof item.downloadId === 'number')) {
        rejected = true;
        throw new Error('temporary storage failure');
      }
      await originalSet(key, value);
    });
    await harness.queue.run();
    expect(rejected).toBe(true);
    expect(harness.downloader.log).toHaveLength(1);
    expect(harness.queue.list()[0]).toMatchObject({ status: 'running', downloadId: 1 });
    expect(await harness.queue.retryFailed()).toBe(0);
    await harness.queue.refresh();
    const stored = await harness.area.get<{ items: QueueItem[] }>(STORAGE_KEYS.queue);
    expect(stored?.items[0]).toMatchObject({ status: 'running', downloadId: 1 });
    harness.downloader.setState(1, { state: 'complete', bytesReceived: 12 });
    await harness.queue.handleDownloadChanged(1);
    expect(harness.queue.summary()).toMatchObject({ done: 1, failed: 0 });
    expect(harness.downloader.log).toHaveLength(1);
  });

  it('records a pre-start storage error without starting a browser download', async () => {
    const harness = await ready();
    const server = (await harness.servers.getDefault())!;
    await harness.queue.enqueuePosts(server.id, [{ id: String(MOCK_POSTS[0]!.id) }]);
    const originalSet = harness.area.set.bind(harness.area);
    let rejected = false;
    vi.spyOn(harness.area, 'set').mockImplementation(async (key, value) => {
      const queue = value as { items?: QueueItem[] };
      if (!rejected && key === STORAGE_KEYS.queue && queue.items?.some((item) => item.status === 'running' && !item.downloadId)) {
        rejected = true;
        throw new Error('temporary storage failure');
      }
      await originalSet(key, value);
    });
    await harness.queue.run();
    expect(rejected).toBe(true);
    expect(harness.queue.list()[0]).toMatchObject({ status: 'failed', downloadId: null });
    expect(harness.downloader.log).toHaveLength(0);
    expect(await harness.queue.retryFailed()).toBe(1);
  });

  it('does not clear a completed row until its failed history write is repaired', async () => {
    const harness = await ready();
    const { server, item } = await queuePost(harness);
    const add = vi.spyOn(harness.history, 'add').mockRejectedValue(new Error('storage unavailable'));
    harness.downloader.setState(item.downloadId!, { state: 'complete' });
    await harness.queue.handleDownloadChanged(item.downloadId!);
    expect(harness.queue.list()[0]).toMatchObject({ status: 'done', bookkeepingPending: true });
    expect(await harness.queue.clear('completed')).toBe(0);
    expect(harness.queue.list()).toHaveLength(1);
    expect(await harness.queue.enqueuePosts(server.id, [{ id: item.postId }])).toMatchObject({ added: 0, skipped: 1 });
    const direct = await harness.router({ type: 'posts/download', payload: { serverId: server.id, postId: item.postId } });
    expect(direct.ok).toBe(false);
    expect(harness.downloader.log).toHaveLength(1);
    add.mockRestore();
    await harness.queue.refresh();
    expect(await harness.history.has(server.id, item.postId)).toBe(true);
    expect(await harness.queue.clear('completed')).toBe(1);
  });

  it('repairs a canceled pending mirror row when its link update fails', async () => {
    const harness = await ready();
    const url = 'https://catbox.moe/cancel-pending.zip';
    const link = collectMirrorLinks({ content: url }, { serverId: null, siteType: null, postId: null, postTitle: null, postUrl: null, creator: null }, { filter: 'any' })[0]!;
    await harness.links.add([link]);
    await ok(harness, { type: 'links/queue', payload: { ids: [link.id] } });
    const mark = vi.spyOn(harness.links, 'mark').mockRejectedValueOnce(new Error('storage unavailable'));
    await harness.queue.cancel(harness.queue.list()[0]!.id);
    expect(harness.queue.list()[0]).toMatchObject({ status: 'canceled', bookkeepingPending: true });
    await harness.queue.refresh();
    expect((await harness.links.byId(link.id))?.status).toBe('new');
    expect(harness.queue.list()[0]?.bookkeepingPending).toBe(false);
    mark.mockRestore();
  });

  it('defers retrying a failed mirror until its link outcome is durable', async () => {
    const harness = await ready();
    const url = 'https://catbox.moe/retry-pending.zip';
    const link = collectMirrorLinks({ content: url }, { serverId: null, siteType: null, postId: null, postTitle: null, postUrl: null, creator: null }, { filter: 'any' })[0]!;
    await harness.links.add([link]);
    await ok(harness, { type: 'links/queue', payload: { ids: [link.id] } });
    await harness.queue.run();
    const item = harness.queue.list()[0]!;
    const mark = vi.spyOn(harness.links, 'mark').mockRejectedValue(new Error('storage unavailable'));
    harness.downloader.setState(item.downloadId!, { state: 'interrupted', error: 'NETWORK_FAILED' });
    await harness.queue.handleDownloadChanged(item.downloadId!);
    expect(harness.queue.list()[0]).toMatchObject({ status: 'failed', bookkeepingPending: true });
    expect(await harness.queue.retryFailed()).toBe(0);
    expect(harness.queue.list()[0]?.status).toBe('failed');
    mark.mockRestore();
    expect(await harness.queue.retryFailed()).toBe(1);
    expect(harness.queue.list()[0]).toMatchObject({ status: 'pending', bookkeepingPending: false });
    expect((await harness.links.byId(link.id))?.status).toBe('queued');
  });

  it('reconciles a completed browser transfer after a worker restart without starting it again', async () => {
    const harness = await ready();
    const { server, item } = await queuePost(harness);
    harness.downloader.setState(item.downloadId!, { state: 'complete', bytesReceived: 321 });
    const cold = restart(harness);
    await cold.queue.recover();
    expect(cold.queue.summary()).toMatchObject({ done: 1, running: 0 });
    expect(await cold.history.has(server.id, item.postId)).toBe(true);
    expect(harness.downloader.log).toHaveLength(1);
  });

  it('restores an in-progress ID and cold queue/list from storage without requeueing it', async () => {
    const harness = await ready();
    const { item } = await queuePost(harness);
    const cold = restart(harness);
    const response = await cold.router({ type: 'queue/list' });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    const data = response.data as { items: QueueItem[] };
    expect(data.items).toMatchObject([{ status: 'running', downloadId: item.downloadId }]);
    expect(harness.downloader.log).toHaveLength(1);
    harness.downloader.setState(item.downloadId!, { state: 'interrupted', error: 'FILE_FAILED' });
    await cold.queue.handleDownloadChanged(item.downloadId!);
    expect(cold.queue.summary()).toMatchObject({ failed: 1, running: 0 });
  });

  it('marks a missing Chrome record unverified, not complete or automatically retried', async () => {
    const harness = await ready();
    const { item } = await queuePost(harness);
    harness.downloader.setState(item.downloadId!, null);
    const cold = restart(harness);
    await cold.queue.recover();
    expect(cold.queue.list()[0]).toMatchObject({ status: 'unverified', errorKind: 'unknown' });
    expect(await cold.history.list()).toEqual([]);
    expect(harness.downloader.log).toHaveLength(1);
    expect(await cold.queue.retryFailed()).toBe(1);
    expect(cold.queue.list()[0]).toMatchObject({ status: 'pending', downloadId: null });
  });

  it('resumes only the persisted selection and does not duplicate an ambiguous pre-ID start', async () => {
    const harness = await ready();
    harness.downloader.autoComplete = true;
    await harness.queue.enqueueLinks([
      { url: 'https://catbox.moe/a.zip' }, { url: 'https://catbox.moe/b.zip' }, { url: 'https://catbox.moe/c.zip' },
    ]);
    const stored = (await harness.area.get<{ items: QueueItem[]; paused: boolean; scheduledIds: string[] }>(STORAGE_KEYS.queue))!;
    stored.items[0]!.status = 'running'; // worker died before the ID was persisted
    stored.scheduledIds = [stored.items[1]!.id];
    await harness.area.set(STORAGE_KEYS.queue, stored);
    const cold = restart(harness);
    await cold.queue.recover();
    await vi.waitFor(() => expect(cold.queue.summary().done).toBe(1));
    expect(cold.queue.list().map((entry) => entry.status)).toEqual(['unverified', 'done', 'pending']);
    expect(harness.downloader.log.map((entry) => entry.url)).toEqual(['https://catbox.moe/b.zip']);
  });

  it('cancels a browser transfer and preserves active rows when clearing or removing', async () => {
    const harness = await ready();
    const { item } = await queuePost(harness);
    expect(await harness.queue.remove([item.id])).toBe(0);
    expect(await harness.queue.clear('all')).toBe(0);
    expect(harness.queue.summary().running).toBe(1);
    await harness.queue.cancel(item.id);
    expect(harness.queue.list()[0]).toMatchObject({ status: 'canceled' });
    expect(await harness.history.list()).toEqual([]);
    expect(await harness.queue.clear('all')).toBe(1);
  });

  it('cancels even when Chrome accepts the request before the ID callback returns', async () => {
    const harness = await ready();
    const accepted = deferred<number>();
    const release = deferred<void>();
    const original = harness.downloader.download.bind(harness.downloader);
    harness.downloader.download = async (request) => {
      const outcome = await original(request);
      accepted.resolve(outcome.downloadId!);
      await release.promise;
      return outcome;
    };
    const server = (await harness.servers.getDefault())!;
    await harness.queue.enqueuePosts(server.id, [{ id: String(MOCK_POSTS[0]!.id) }]);
    const running = harness.queue.run();
    const id = await accepted.promise;
    const row = harness.queue.list()[0]!;
    expect(row.downloadId).toBeNull();
    await harness.queue.cancel(row.id);
    release.resolve();
    await running;
    expect((await harness.downloader.getState(id))?.state).toBe('interrupted');
    expect(harness.queue.list()[0]).toMatchObject({ status: 'canceled' });
    expect(await harness.history.list()).toEqual([]);
  });

  it('treats completion winning a cancellation race as complete', async () => {
    const harness = await ready();
    const { item } = await queuePost(harness);
    harness.downloader.cancel = async (id) => {
      harness.downloader.setState(id, { state: 'complete', bytesReceived: 7 });
      throw new Error('already completed');
    };
    await harness.queue.cancel(item.id);
    expect(harness.queue.list()[0]).toMatchObject({ status: 'done', bytes: 7 });
    expect(await harness.history.list()).toHaveLength(1);
  });

  it('tracks a failed browser transfer resumed in Chrome without silently starting a new one', async () => {
    const harness = await ready();
    const { item } = await queuePost(harness);
    const id = item.downloadId!;
    harness.downloader.setState(id, { state: 'interrupted', error: 'NETWORK_FAILED' });
    await harness.queue.handleDownloadChanged(id);
    harness.downloader.setState(id, { state: 'in_progress', error: null });
    await harness.queue.handleDownloadChanged(id);
    expect(harness.queue.summary()).toMatchObject({ running: 1, failed: 0 });
    harness.downloader.setState(id, { state: 'complete', bytesReceived: 8 });
    await harness.queue.handleDownloadChanged(id);
    expect(harness.queue.summary().done).toBe(1);
    expect(harness.downloader.log).toHaveLength(1);
  });

  it('keeps all history and queue results when many workers finish simultaneously', async () => {
    const harness = await ready();
    const server = (await harness.servers.getDefault())!;
    const ids = MOCK_POSTS.slice(0, 6).map((post) => String(post.id));
    await harness.queue.enqueuePosts(server.id, ids.map((id) => ({ id })));
    await harness.queue.run();
    const rows = harness.queue.list();
    expect(rows).toHaveLength(ids.length);
    expect(rows.every((row) => row.status === 'running')).toBe(true);
    for (const [index, row] of rows.entries()) {
      harness.downloader.setState(row.downloadId!, { state: 'complete', bytesReceived: index + 1 });
    }
    await Promise.all(rows.flatMap((row) => [harness.queue.handleDownloadChanged(row.downloadId!), harness.queue.handleDownloadChanged(row.downloadId!)]));
    expect(harness.queue.summary().done).toBe(ids.length);
    expect((await harness.history.list()).length).toBe(ids.length);
    const cold = restart(harness);
    await cold.queue.recover();
    expect(cold.queue.summary().done).toBe(ids.length);
    expect((await cold.history.list()).length).toBe(ids.length);
  });

  it('recovers a direct post completion after a worker restart', async () => {
    const harness = await ready();
    const server = (await harness.servers.getDefault())!;
    const postId = String(MOCK_POSTS[0]!.id);
    const direct = await ok<{ downloadId: number }>(harness, { type: 'posts/download', payload: { serverId: server.id, postId } });
    const cold = restart(harness);
    await cold.queue.recover();
    expect(cold.queue.summary().running).toBe(1);
    harness.downloader.setState(direct.downloadId, { state: 'complete', bytesReceived: 12 });
    await cold.queue.handleDownloadChanged(direct.downloadId);
    expect(await cold.history.has(server.id, postId)).toBe(true);
    expect(harness.downloader.log).toHaveLength(1);
  });

  it('retries a failed history write without restarting a completed browser transfer', async () => {
    const harness = await ready();
    const { item } = await queuePost(harness);
    const original = harness.history.add.bind(harness.history);
    harness.history.add = async () => { throw new Error('temporary storage failure'); };
    harness.downloader.setState(item.downloadId!, { state: 'complete', bytesReceived: 18 });
    await harness.queue.handleDownloadChanged(item.downloadId!);
    expect(harness.queue.list()[0]).toMatchObject({ status: 'done', bookkeepingPending: true });
    expect(await harness.history.list()).toHaveLength(0);
    harness.history.add = original;
    await harness.queue.refresh();
    expect(harness.queue.list()[0]).toMatchObject({ status: 'done', bookkeepingPending: false });
    expect((await harness.history.list())[0]).toMatchObject({ completion: 'browser-complete', bytes: 18 });
    expect(harness.downloader.log).toHaveLength(1);
  });

  it('does not turn a temporary Chrome search error into a successful or failed transfer', async () => {
    const harness = await ready();
    const { item } = await queuePost(harness);
    const original = harness.downloader.getState.bind(harness.downloader);
    harness.downloader.getState = async () => { throw new Error('temporary API error'); };
    await harness.queue.handleDownloadChanged(item.downloadId!);
    expect(harness.queue.list()[0]).toMatchObject({ status: 'running', errorKind: 'unknown' });
    expect(await harness.history.list()).toHaveLength(0);
    harness.downloader.getState = original;
    harness.downloader.setState(item.downloadId!, { state: 'complete' });
    await harness.queue.handleDownloadChanged(item.downloadId!);
    expect(harness.queue.summary().done).toBe(1);
  });
});

describe('mirror links, task runs, and legacy records', () => {
  it('keeps a task in progress until every browser transfer completes or fails', async () => {
    const harness = await ready();
    const imported = await ok<{ task: TaskView }>(harness, {
      type: 'tasks/import', payload: { text: 'https://catbox.moe/a.zip\nhttps://catbox.moe/b.zip', filename: 'files.txt' },
    });
    await ok(harness, { type: 'tasks/run', payload: { taskId: imported.task.task.id, start: false } });
    await harness.queue.run();
    let view = (await ok<{ tasks: TaskView[] }>(harness, { type: 'tasks/list' })).tasks[0]!;
    expect(view).toMatchObject({ completion: 'in-progress', stats: { done: 0, queued: 2 }, lastRun: { finishedAt: null } });
    const rows = harness.queue.list();
    harness.downloader.setState(rows[0]!.downloadId!, { state: 'complete', bytesReceived: 55 });
    await harness.queue.handleDownloadChanged(rows[0]!.downloadId!);
    view = (await ok<{ tasks: TaskView[] }>(harness, { type: 'tasks/list' })).tasks[0]!;
    expect(view).toMatchObject({ completion: 'in-progress', stats: { done: 1, queued: 1 }, lastRun: { finishedAt: null } });
    harness.downloader.setState(rows[1]!.downloadId!, { state: 'interrupted', error: 'NETWORK_FAILED' });
    await harness.queue.handleDownloadChanged(rows[1]!.downloadId!);
    view = (await ok<{ tasks: TaskView[] }>(harness, { type: 'tasks/list' })).tasks[0]!;
    expect(view).toMatchObject({ completion: 'partial', stats: { done: 1, failed: 1, queued: 0 }, lastRun: { done: 1, failed: 1 } });
    expect(view.lastRun?.finishedAt).toBeTruthy();
    expect((await harness.links.list()).map((link) => link.status).sort()).toEqual(['done', 'failed']);
    const retry = await ok<{ queued: number; plan: { retrying: number; alreadyDone: number } }>(harness, {
      type: 'tasks/run', payload: { taskId: view.task.id, start: false },
    });
    expect(retry).toMatchObject({ queued: 1, plan: { retrying: 1, alreadyDone: 1 } });
  });

  it('settles a mirror and its task after a worker restart', async () => {
    const harness = await ready();
    const imported = await ok<{ task: TaskView }>(harness, {
      type: 'tasks/import', payload: { text: 'https://catbox.moe/slow.zip', filename: 'files.txt' },
    });
    await ok(harness, { type: 'tasks/run', payload: { taskId: imported.task.task.id, start: false } });
    await harness.queue.run();
    const row = harness.queue.list()[0]!;
    const cold = restart(harness);
    await cold.queue.recover();
    expect((await cold.links.list())[0]?.status).toBe('queued');
    harness.downloader.setState(row.downloadId!, { state: 'complete', bytesReceived: 44 });
    await cold.queue.handleDownloadChanged(row.downloadId!);
    expect((await cold.links.list())[0]).toMatchObject({ status: 'done', completion: 'browser-complete', bytes: 44 });
    expect((await cold.tasks.get(imported.task.task.id))?.runs.at(-1)).toMatchObject({ done: 1, failed: 0 });
    expect((await cold.tasks.get(imported.task.task.id))?.runs.at(-1)?.finishedAt).toBeTruthy();
    expect(harness.downloader.log).toHaveLength(1);
  });

  it('retains legacy start-only queue, link, and original-quality history as unverified', async () => {
    const harness = await ready();
    const url = 'https://catbox.moe/legacy.zip';
    const link = collectMirrorLinks({ content: url }, { serverId: null, siteType: null, postId: null, postTitle: null, postUrl: null, creator: null }, { filter: 'any' })[0]!;
    await harness.area.set(STORAGE_KEYS.links, [{ ...link, status: 'done', filename: 'legacy.zip', bytes: 1 }]);
    await harness.queue.enqueueLinks([{ url, id: link.id }]);
    const stored = (await harness.area.get<{ items: QueueItem[]; paused: boolean }>(STORAGE_KEYS.queue))!;
    stored.items[0]!.status = 'done';
    await harness.area.set(STORAGE_KEYS.queue, stored);
    const legacy: DownloadHistoryEntry = {
      key: 's:1', serverId: 's', siteType: 'e621', postId: '1', label: 'old', filename: 'old.jpg',
      postUrl: '', bytes: null, at: new Date().toISOString(), quality: 'original',
    };
    await harness.area.set(STORAGE_KEYS.history, [legacy]);
    const cold = restart(harness);
    await cold.queue.recover();
    expect(cold.queue.summary()).toMatchObject({ done: 0, unverified: 1 });
    expect((await cold.links.list())[0]?.status).toBe('unverified');
    expect(await cold.links.clear('pending')).toBe(0);
    expect((await cold.links.list())[0]?.status).toBe('unverified');
    expect(await cold.history.list()).toHaveLength(1);
    expect(await cold.history.has('s', '1')).toBe(false);
    expect(harness.downloader.log).toHaveLength(0);
  });
});

describe('Chrome downloader API integration', () => {
  it('registers MV3 change listeners on worker load and reconciles a stored browser ID', async () => {
    const harness = await ready();
    const { item } = await queuePost(harness);
    const data: Record<string, unknown> = {};
    for (const key of await harness.area.keys()) data[key] = structuredClone(await harness.area.get(key));
    const changedListeners: Array<(delta: { id: number }) => void> = [];
    const erasedListeners: Array<(id: number) => void> = [];
    let state: 'in_progress' | 'complete' = 'in_progress';
    const search = vi.fn(async () => [{
      id: item.downloadId, state, bytesReceived: state === 'complete' ? 88 : 10,
      totalBytes: 88, filename: '/private/downloads/test.jpg',
    }]);
    const event = () => ({ addListener: vi.fn() });
    vi.stubGlobal('chrome', {
      downloads: {
        search, cancel: vi.fn(),
        onChanged: { addListener: (callback: (delta: { id: number }) => void) => changedListeners.push(callback) },
        onErased: { addListener: (callback: (id: number) => void) => erasedListeners.push(callback) },
      },
      storage: {
        local: {
          get: async (key: string | null) => key === null ? structuredClone(data) : { [key]: structuredClone(data[key]) },
          set: async (patch: Record<string, unknown>) => { Object.assign(data, structuredClone(patch)); },
        },
        onChanged: event(),
      },
      runtime: { getManifest: () => ({ version: 'test' }), onInstalled: event(), onStartup: event(), onMessage: event() },
      action: { setPopup: async () => undefined },
    });
    try {
      await import('../../src/background/service-worker.js');
      expect(changedListeners).toHaveLength(1);
      expect(erasedListeners).toHaveLength(1);
      await vi.waitFor(() => expect(search).toHaveBeenCalled());
      state = 'complete';
      changedListeners[0]!({ id: item.downloadId! });
      await vi.waitFor(() => {
        const stored = data[STORAGE_KEYS.queue] as { items: QueueItem[] };
        expect(stored.items[0]).toMatchObject({ status: 'done', completion: 'browser-complete', bytes: 88 });
      });
      expect((data[STORAGE_KEYS.history] as DownloadHistoryEntry[])[0]).toMatchObject({ completion: 'browser-complete', bytes: 88 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reports an unavailable MV3 blob fallback without fetching the entire file', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
    const fetchImpl = vi.fn(async () => new Response('file'));
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: undefined });
    vi.stubGlobal('chrome', { downloads: { download: vi.fn().mockRejectedValue(new Error('permission denied')) } });
    try {
      const downloader = new ChromeDownloader({ fetchImpl });
      const error = await downloader.download({ url: 'https://example.test/file.jpg', filename: 'file.jpg' }).catch((caught: Error) => caught);
      expect(String(error)).toMatch(/blob.*(unavailable|not available|unsupported)/i);
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      if (descriptor) Object.defineProperty(URL, 'createObjectURL', descriptor);
      vi.unstubAllGlobals();
    }
  });

  it('reads Chrome state and progress by ID, normalizes unknown lengths, and forwards cancellation', async () => {
    const search = vi.fn(async () => [{
      id: 5, state: 'in_progress', error: undefined, bytesReceived: 123, totalBytes: -1,
      filename: '/downloads/file.jpg', endTime: undefined,
    }]);
    const cancel = vi.fn(async () => undefined);
    vi.stubGlobal('chrome', { downloads: { search, cancel } });
    try {
      const downloader = new ChromeDownloader();
      expect(await downloader.getState(5)).toMatchObject({ state: 'in_progress', bytesReceived: 123, totalBytes: null });
      expect(search).toHaveBeenCalledWith({ id: 5 });
      await downloader.cancel(5);
      expect(cancel).toHaveBeenCalledWith(5);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
