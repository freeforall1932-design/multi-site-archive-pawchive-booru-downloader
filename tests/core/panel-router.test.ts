/**
 * Router-level tests for everything the side panel asks the background worker to
 * do: history notebooks, search history, selective runs, row removal and the
 * settings-driven query composition.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createHarness, e621Server } from '../helpers.js';
import type { UiRequest } from '../../src/core/messages.js';
import type { DownloadHistoryEntry, QueueSummary, SearchHistoryEntry } from '../../src/shared/types.js';
import { MOCK_POSTS } from '../../src/preview/mock-data.js';

type Harness = ReturnType<typeof createHarness>;

async function ok<T = any>(harness: Harness, request: UiRequest): Promise<T> {
  const response = await harness.router(request);
  if (!response.ok) throw new Error(`expected ok, got ${JSON.stringify(response.error)}`);
  return response.data as T;
}

async function drain(harness: Harness) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const listed = await ok<any>(harness, { type: 'queue/list' });
    if (listed.summary.pending === 0 && listed.summary.running === 0) return listed;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('queue did not drain');
}

/**
 * Wait until a *filtered* run has finished, leaving the unticked rows pending.
 * `queue/run` is fire-and-forget through the router, so the test polls.
 */
async function waitForRun(harness: Harness, expectedDone: number) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const listed = await ok<any>(harness, { type: 'queue/list' });
    if (listed.summary.done === expectedDone && listed.summary.running === 0 && !listed.summary.active) return listed;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('the filtered run did not finish');
}

describe('panel router - query composition', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = createHarness({ settings: { tagBlacklist: 'guro', globalTagSuffix: 'solo', minRequestIntervalMs: 0 } });
    await harness.seed({ seedServers: [e621Server()] });
  });

  it('applies the tag blacklist and the global suffix to every search', async () => {
    const result = await ok<{ appliedTags: string; posts: unknown[] }>(harness, {
      type: 'browse/search',
      payload: { serverId: null, spec: { tags: 'cat', limit: 5 } },
    });
    expect(result.appliedTags).toContain('cat');
    expect(result.appliedTags).toContain('solo');
    expect(result.appliedTags).toContain('-guro');
  });

  it('does not add the suffix twice when the user typed it', async () => {
    const result = await ok<{ appliedTags: string }>(harness, {
      type: 'browse/search',
      payload: { serverId: null, spec: { tags: 'cat solo', limit: 5 } },
    });
    expect(result.appliedTags.match(/solo/g)).toHaveLength(1);
  });
});

describe('panel router - history notebooks', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = createHarness({ settings: { minRequestIntervalMs: 0, maxConcurrency: 1 } });
    await harness.seed({ seedServers: [e621Server()] });
  });

  it('records a successful download and lists it back', async () => {
    const server = (await harness.servers.getDefault())!;
    await ok(harness, { type: 'queue/enqueuePosts', payload: { serverId: server.id, posts: [{ id: String(MOCK_POSTS[0]!.id) }] } });
    await ok(harness, { type: 'queue/run' });
    await drain(harness);

    const history = await ok<{ entries: DownloadHistoryEntry[]; total: number }>(harness, { type: 'history/list' });
    expect(history.total).toBe(1);
    expect(history.entries[0]!.serverId).toBe(server.id);
    expect(history.entries[0]!.filename).toContain('booru/e621/');
    expect(history.entries[0]!.key).toBe(`${server.id}:${MOCK_POSTS[0]!.id}`);
  });

  it('does not record failed downloads', async () => {
    const server = (await harness.servers.getDefault())!;
    // The mock booru's rating filter blocks an explicit post on this profile.
    const explicit = MOCK_POSTS.find((post) => post.rating === 'explicit')!;
    await harness.queue.enqueue([{ serverId: server.id, postId: String(explicit.id) }]);
    await harness.queue.run();
    const history = await ok<{ total: number }>(harness, { type: 'history/list' });
    expect(history.total).toBe(0);
  });

  it('removes one entry and clears the rest', async () => {
    const server = (await harness.servers.getDefault())!;
    await ok(harness, {
      type: 'queue/enqueuePosts',
      payload: { serverId: server.id, posts: [{ id: String(MOCK_POSTS[0]!.id) }, { id: String(MOCK_POSTS[1]!.id) }] },
    });
    await ok(harness, { type: 'queue/run' });
    await drain(harness);

    const removed = await ok<{ removed: number; total: number }>(harness, {
      type: 'history/remove',
      payload: { serverId: server.id, postId: String(MOCK_POSTS[0]!.id) },
    });
    expect(removed.removed).toBe(1);
    expect(removed.total).toBe(1);

    const cleared = await ok<{ removed: number }>(harness, { type: 'history/clear' });
    expect(cleared.removed).toBe(1);
    expect((await ok<{ total: number }>(harness, { type: 'history/list' })).total).toBe(0);
  });

  it('remembers searches per server, up to the configured limit', async () => {
    const server = (await harness.servers.getDefault())!;
    await harness.settings.save({ searchHistoryLimit: 2 });
    for (const query of ['cat', 'dog', 'bird']) {
      await ok(harness, { type: 'searches/add', payload: { serverId: server.id, query } });
    }
    const listed = await ok<{ entries: SearchHistoryEntry[] }>(harness, { type: 'searches/list', payload: { serverId: server.id } });
    expect(listed.entries.map((entry) => entry.query)).toEqual(['bird', 'dog']);
  });

  it('stores nothing when search history is switched off', async () => {
    const server = (await harness.servers.getDefault())!;
    await harness.settings.save({ searchHistoryEnabled: false });
    await ok(harness, { type: 'searches/add', payload: { serverId: server.id, query: 'cat' } });
    const listed = await ok<{ entries: SearchHistoryEntry[] }>(harness, { type: 'searches/list' });
    expect(listed.entries).toHaveLength(0);
  });

  it('clears search history for one server or all of them', async () => {
    const server = (await harness.servers.getDefault())!;
    await ok(harness, { type: 'searches/add', payload: { serverId: server.id, query: 'cat' } });
    await ok(harness, { type: 'searches/add', payload: { serverId: 'other', query: 'dog' } });
    expect((await ok<{ removed: number }>(harness, { type: 'searches/clear', payload: { serverId: server.id } })).removed).toBe(1);
    expect((await ok<{ entries: SearchHistoryEntry[] }>(harness, { type: 'searches/list' })).entries).toHaveLength(1);
    expect((await ok<{ removed: number }>(harness, { type: 'searches/clear' })).removed).toBe(1);
  });
});

describe('panel router - selective queue control', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = createHarness({ settings: { minRequestIntervalMs: 0, maxConcurrency: 1 } });
    await harness.seed({ seedServers: [e621Server()] });
  });

  it('runs only the ticked rows', async () => {
    const server = (await harness.servers.getDefault())!;
    await ok(harness, {
      type: 'queue/enqueuePosts',
      payload: {
        serverId: server.id,
        posts: [{ id: String(MOCK_POSTS[0]!.id) }, { id: String(MOCK_POSTS[1]!.id) }, { id: String(MOCK_POSTS[2]!.id) }],
      },
    });
    const listed = await ok<{ items: Array<{ id: string }> }>(harness, { type: 'queue/list' });
    const only = [listed.items[1]!.id];
    await ok(harness, { type: 'queue/run', payload: { itemIds: only } });
    const drained = await waitForRun(harness, 1);

    expect(drained.summary.done).toBe(1);
    expect(drained.summary.pending).toBe(2);
    const done = (drained.items as Array<{ status: string; id: string }>).find((item) => item.status === 'done');
    expect(done?.id).toBe(only[0]);
  });

  it('removes specific rows without touching the others', async () => {
    const server = (await harness.servers.getDefault())!;
    await ok(harness, {
      type: 'queue/enqueuePosts',
      payload: { serverId: server.id, posts: [{ id: String(MOCK_POSTS[0]!.id) }, { id: String(MOCK_POSTS[1]!.id) }] },
    });
    const listed = await ok<{ items: Array<{ id: string }> }>(harness, { type: 'queue/list' });
    const removed = await ok<{ removed: number; summary: QueueSummary }>(harness, {
      type: 'queue/remove',
      payload: { itemIds: [listed.items[0]!.id] },
    });
    expect(removed.removed).toBe(1);
    expect(removed.summary.pending).toBe(1);
  });
});

describe('panel router - preferences that reach the download path', () => {
  it('migrates a legacy sample preference and downloads the original', async () => {
    const harness = createHarness({ settings: { filePreference: 'sample', minRequestIntervalMs: 0 } });
    await harness.seed({ seedServers: [e621Server()] });
    const server = (await harness.servers.getDefault())!;
    const result = await ok<{ filename: string; post: { fileUrl: string } }>(harness, {
      type: 'posts/download',
      payload: { serverId: server.id, postId: String(MOCK_POSTS[0]!.id) },
    });
    expect((await harness.settings.get()).filePreference).toBe('original');
    expect(result.filename).toContain('booru/e621/');
    expect(harness.downloader.log[0]!.url).toBe(result.post.fileUrl);
  });

  it('overwrites instead of uniquifying when the setting asks for it', async () => {
    const harness = createHarness({ settings: { duplicateBehaviour: 'overwrite', minRequestIntervalMs: 0 } });
    await harness.seed({ seedServers: [e621Server()] });
    const server = (await harness.servers.getDefault())!;
    const recorded: Array<{ conflictAction?: string }> = [];
    const original = harness.downloader.download.bind(harness.downloader);
    harness.downloader.download = async (request) => {
      recorded.push({ conflictAction: request.conflictAction });
      return original(request);
    };
    await ok(harness, { type: 'posts/download', payload: { serverId: server.id, postId: String(MOCK_POSTS[0]!.id) } });
    expect(recorded[0]!.conflictAction).toBe('overwrite');
  });
});
