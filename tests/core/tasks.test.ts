/**
 * Download tasks: the portable job behind the Links tab.
 *
 * The behaviours under test are the ones the feature exists for:
 *   - a package survives the round trip between two people (export → import);
 *   - re-importing or re-collecting never duplicates files and never forgets an
 *     outcome (so "partial" stays partial until the missing files arrive);
 *   - "Download missing" fetches new files and retries failures, and never
 *     re-downloads one that is already saved;
 *   - the run history records what each pass did.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createHarness } from '../helpers.js';
import { createServerConfig } from '../../src/core/servers.js';
import { collectMirrorLinks, mirrorLinkId } from '../../src/core/links.js';
import {
  creatorQuery,
  formatTaskManifest,
  manifestFilename,
  parseCreatorQuery,
  parseTaskPackage,
  planTaskRun,
  statsLabel,
  taskCompletion,
  taskIdFor,
  taskNameFor,
  taskStatsFor,
} from '../../src/core/tasks.js';
import type { DownloadTask, MirrorLink, ServerConfig, TaskView } from '../../src/shared/types.js';
import type { UiRequest } from '../../src/core/messages.js';
import { MOCK_CREATOR, MOCK_CREATOR_POSTS } from '../../src/preview/mock-data.js';

type Harness = ReturnType<typeof createHarness>;

const SERVER = createServerConfig({
  siteType: 'pawchive',
  baseUrl: 'https://pawchive.pw',
  label: 'Pawchive test',
  ratingFilterEnabled: false,
});

async function ok<T = any>(harness: Harness, request: UiRequest): Promise<T> {
  const response = await harness.router(request);
  if (!response.ok) throw new Error(`expected ok, got ${JSON.stringify(response.error)}`);
  return response.data as T;
}

function link(overrides: Partial<MirrorLink> = {}): MirrorLink {
  const url = overrides.url ?? 'https://mega.nz/file/a';
  return {
    id: mirrorLinkId(url),
    url,
    host: 'mega.nz',
    provider: 'Mega',
    serverId: 'srv_1',
    siteType: 'pawchive',
    postId: 'fanbox/1/10',
    postTitle: 'Post ten',
    postUrl: 'https://pawchive.pw/fanbox/user/1/post/10',
    creator: 'fanbox/1',
    addedAt: '2026-09-01T00:00:00.000Z',
    status: 'new',
    attempts: 0,
    error: null,
    filename: null,
    bytes: null,
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

function task(overrides: Partial<DownloadTask> = {}): DownloadTask {
  return {
    id: 'pawchive:fanbox:1',
    name: 'Artist A',
    siteType: 'pawchive',
    serverId: 'srv_1',
    service: 'fanbox',
    creator: '1',
    query: 'fanbox/1',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    lastScanAt: null,
    memberIds: [],
    scannedPosts: [],
    runs: [],
    ...overrides,
  };
}

// ------------------------------------------------------------------- identity

describe('task identity', () => {
  it('keys a task on site + service + creator, so the same creator is one task', () => {
    expect(taskIdFor({ siteType: 'pawchive', service: 'fanbox', creator: '1245946' })).toBe('pawchive:fanbox:1245946');
    expect(taskIdFor({ siteType: 'pawchive', service: 'Fanbox', creator: '1245946' })).toBe('pawchive:fanbox:1245946');
  });

  it('falls back to the query, then to a plain unfiled id', () => {
    expect(taskIdFor({ siteType: 'e621', query: 'artist:foo bar' })).toBe('e621:query:artist:foo_bar');
    expect(taskIdFor({})).toBe('link:unfiled');
  });

  it('reads a creator out of the box styles the panel accepts', () => {
    expect(parseCreatorQuery('fanbox/1245946')).toEqual({ service: 'fanbox', creator: '1245946' });
    expect(parseCreatorQuery('https://pawchive.pw/fanbox/user/1245946')).toEqual({ service: 'fanbox', creator: '1245946' });
    expect(parseCreatorQuery('some artist name')).toEqual({ service: null, creator: null });
  });

  it('names a task the way a person would', () => {
    expect(taskNameFor({ service: 'fanbox', creator: '1245946' })).toBe('1245946 · fanbox');
    expect(taskNameFor({ name: 'Artist A' })).toBe('Artist A');
    expect(creatorQuery({ service: 'fanbox', creator: '1245946', query: '' })).toBe('fanbox/1245946');
  });
});

// ---------------------------------------------------------------- completeness

describe('task completeness', () => {
  const id = 'pawchive:fanbox:1';
  const links: MirrorLink[] = [
    link({ url: 'https://mega.nz/file/a', status: 'done', bytes: 1000, filename: 'mirrors/mega.nz/a.zip' }),
    link({ url: 'https://mega.nz/file/b', status: 'done', bytes: 500 }),
    link({ url: 'https://pixeldrain.com/u/c', status: 'failed', error: 'HTTP 403' }),
    link({ url: 'https://catbox.moe/d.psd', status: 'new' }),
  ].map((entry) => ({ ...entry, id: mirrorLinkId(entry.url) }));
  const subject = task({ memberIds: links.map((entry) => entry.id) });

  it('counts what a task owns and what it still needs', () => {
    const stats = taskStatsFor(subject, links);
    expect(stats).toMatchObject({ total: 4, done: 2, failed: 1, pending: 2, queued: 0, bytes: 1500 });
    expect(statsLabel(stats)).toContain('2 / 4 done');
    expect(statsLabel(stats)).toContain('1 failed');
  });

  it('calls a half-finished task partial, not failed', () => {
    expect(taskCompletion(taskStatsFor(subject, links))).toBe('partial');
    const all = links.map((entry) => ({ ...entry, status: 'done' as const }));
    expect(taskCompletion(taskStatsFor(subject, all))).toBe('complete');
    const broken = links.map((entry) => ({ ...entry, status: 'failed' as const }));
    expect(taskCompletion(taskStatsFor(subject, broken))).toBe('failed');
    const queued = links.map((entry) => ({ ...entry, status: 'queued' as const }));
    expect(taskCompletion(taskStatsFor(subject, queued))).toBe('in-progress');
    expect(taskCompletion(taskStatsFor(subject, []))).toBe('empty');
  });

  it('ignores files that belong to another task', () => {
    const stranger = link({ url: 'https://example.com/x.zip', status: 'done' });
    const stats = taskStatsFor(subject, [...links, stranger]);
    expect(stats.total).toBe(4);
    expect(stats.done).toBe(2);
  });

  it('plans "download missing" as new files + retries, never what is saved', () => {
    const plan = planTaskRun(subject, links, 'missing');
    expect(plan.ids).toEqual([mirrorLinkId('https://pixeldrain.com/u/c'), mirrorLinkId('https://catbox.moe/d.psd')]);
    expect(plan).toMatchObject({ alreadyDone: 2, retrying: 1, alreadyQueued: 0 });

    const everything = planTaskRun(subject, links, 'all');
    expect(everything.ids).toHaveLength(4);
    expect(everything.alreadyDone).toBe(0);
  });

  it('never queues a file that is already waiting', () => {
    const waiting = links.map((entry) => (entry.status === 'new' ? { ...entry, status: 'queued' as const } : entry));
    const plan = planTaskRun(subject, waiting, 'missing');
    expect(plan.ids).toEqual([mirrorLinkId('https://pixeldrain.com/u/c')]);
    expect(plan.alreadyQueued).toBe(1);
  });
});

// ------------------------------------------------------------------ the package

describe('the package', () => {
  const subject = task({
    memberIds: [mirrorLinkId('https://mega.nz/file/a'), mirrorLinkId('https://pixeldrain.com/u/c')],
    scannedPosts: ['fanbox/1/10'],
    lastScanAt: '2026-09-10T00:00:00.000Z',
    runs: [
      {
        id: 'run_1',
        startedAt: '2026-09-10T00:00:00.000Z',
        finishedAt: '2026-09-10T00:10:00.000Z',
        scannedPosts: 4,
        added: 6,
        queued: 6,
        done: 3,
        failed: 1,
        note: '3 / 6 done · 1 failed',
      },
    ],
  });
  const links = [
    link({ url: 'https://mega.nz/file/a', status: 'done', bytes: 2048, filename: 'mirrors/mega.nz/a.zip' }),
    link({ url: 'https://pixeldrain.com/u/c', status: 'failed', error: 'HTTP 403' }),
  ].map((entry) => ({ ...entry, id: mirrorLinkId(entry.url), memberIds: undefined })) as MirrorLink[];

  it('writes a manifest a stranger can read', () => {
    const text = formatTaskManifest(subject, links, { now: new Date('2026-09-29T00:00:00.000Z') });
    const parsed = JSON.parse(text);
    expect(parsed.format).toBe('booru-server-manager.task');
    expect(parsed.task).toMatchObject({ id: 'pawchive:fanbox:1', service: 'fanbox', creator: '1' });
    expect(parsed.summary).toMatchObject({ total: 2, done: 1, failed: 1, completion: 'partial' });
    expect(parsed.files[0]).toMatchObject({ url: 'https://mega.nz/file/a', status: 'done', postTitle: 'Post ten' });
    expect(parsed.runs).toHaveLength(1);
  });

  it('reads its own manifest back with everything needed to rebuild the job', () => {
    const text = formatTaskManifest(subject, links);
    const parsed = parseTaskPackage(text);
    expect(parsed.kind).toBe('json');
    expect(parsed.task).toMatchObject({ id: 'pawchive:fanbox:1', name: 'Artist A', service: 'fanbox', creator: '1' });
    expect(parsed.task?.scannedPosts).toEqual(['fanbox/1/10']);
    expect(parsed.task?.runs).toHaveLength(1);
    expect(parsed.urls).toHaveLength(2);
    expect(parsed.files.get(mirrorLinkId('https://mega.nz/file/a'))?.postTitle).toBe('Post ten');
    expect(parsed.summary).toMatchObject({ done: 1, failed: 1 });
  });

  it('tells a text list apart from a manifest, and reads neither wrongly', () => {
    const list = parseTaskPackage('# Creator: fanbox/1\n- https://mega.nz/file/a\n');
    expect(list.kind).toBe('txt');
    expect(list.task).toBeNull();

    const rubbish = parseTaskPackage('{ "hello": "world" }');
    expect(rubbish.kind).toBe('unknown');
    expect(rubbish.error).toBeTruthy();

    expect(parseTaskPackage('   ').kind).toBe('unknown');
  });

  it('keeps the file name safe for a filesystem', () => {
    expect(manifestFilename('1245946 · fanbox')).toBe('1245946_fanbox_task.json');
    expect(manifestFilename('')).toBe('task_task.json');
  });
});

// ---------------------------------------------------------------------- store

describe('task store + router flow', () => {
  let harness: Harness;
  let server: ServerConfig;

  beforeEach(async () => {
    harness = createHarness({ settings: { minRequestIntervalMs: 0, maxConcurrency: 1 } });
    await harness.seed({ seedServers: [SERVER] });
    server = (await harness.servers.getDefault())!;
  });

  /** Collect the demo creator the way the panel does, into a task. */
  async function collect(): Promise<TaskView> {
    const begun = await ok<{ task: TaskView; created: boolean }>(harness, {
      type: 'tasks/begin',
      payload: { serverId: server.id, query: `${MOCK_CREATOR.service}/${MOCK_CREATOR.user}` },
    });
    expect(begun.created).toBe(true);
    const listing = await ok<{ posts: Array<{ id: string; label: string; postUrl: string }> }>(harness, {
      type: 'links/posts',
      payload: { serverId: server.id, query: `${MOCK_CREATOR.service}/${MOCK_CREATOR.user}`, page: 1 },
    });
    for (const post of listing.posts) {
      await ok(harness, {
        type: 'links/scanPost',
        payload: {
          serverId: server.id,
          postId: post.id,
          postUrl: post.postUrl,
          postTitle: post.label,
          creator: `${MOCK_CREATOR.service}/${MOCK_CREATOR.user}`,
          taskId: begun.task.task.id,
        },
      });
    }
    const { tasks } = await ok<{ tasks: TaskView[] }>(harness, { type: 'tasks/list' });
    return tasks[0]!;
  }

  it('a collect run becomes one task with every file it found', async () => {
    const view = await collect();
    expect(view.task.id).toBe(`pawchive:${MOCK_CREATOR.service}:${MOCK_CREATOR.user}`);
    expect(view.task.name).toBe(`${MOCK_CREATOR.user} · ${MOCK_CREATOR.service}`);
    expect(view.stats.total).toBe(6);
    expect(view.task.scannedPosts).toHaveLength(MOCK_CREATOR_POSTS.length);
    expect(view.completion).toBe('idle');
    expect(view.task.lastScanAt).toBeTruthy();
  });

  it('starts direct files and reports share pages as requiring manual download', async () => {
    const view = await collect();
    const first = await ok<{ queued: number; started: boolean; plan: { alreadyDone: number; retrying: number } }>(harness, {
      type: 'tasks/run',
      payload: { taskId: view.task.id, start: false },
    });
    expect(first.queued).toBe(6);
    expect(first.plan.retrying).toBe(0);
    expect(first.started).toBe(false);
    await harness.queue.run();

    const after = await ok<{ tasks: TaskView[] }>(harness, { type: 'tasks/list' });
    expect(after.tasks[0]?.stats.done).toBe(1);
    expect(after.tasks[0]?.stats.failed).toBe(5);
    expect(after.tasks[0]?.completion).toBe('partial');
    expect(after.tasks[0]?.lastRun?.finishedAt).toBeTruthy();
    expect(after.tasks[0]?.lastRun?.done).toBe(1);

    // The direct link is skipped; share pages remain available for manual use.
    const again = await ok<{ queued: number; plan: { alreadyDone: number } }>(harness, {
      type: 'tasks/run',
      payload: { taskId: view.task.id, start: false },
    });
    expect(again.queued).toBe(5);
    expect(again.plan.alreadyDone).toBe(1);
  });

  it('retries only the failures on the next run', async () => {
    const view = await collect();
    // The one direct mirror refuses; the five share pages already need a provider.
    const target = (await harness.links.list()).find((link) => link.host === 'catbox.moe')!;
    harness.downloader.failUrls.add(target.url);
    await ok(harness, { type: 'tasks/run', payload: { taskId: view.task.id, start: false } });
    await harness.queue.run();

    const afterFirst = await ok<{ tasks: TaskView[] }>(harness, { type: 'tasks/list' });
    const broken = afterFirst.tasks[0]!;
    expect(broken.stats.failed).toBe(6);
    expect(broken.completion).toBe('failed');
    expect(broken.lastRun?.failed).toBe(6);

    // The next run retries the direct failure and the unresolved share pages.
    const retry = await ok<{ queued: number; plan: { retrying: number; alreadyDone: number } }>(harness, {
      type: 'tasks/run',
      payload: { taskId: view.task.id, start: false },
    });
    expect(retry.plan.retrying).toBe(6);
    expect(retry.queued).toBe(6);
    expect(retry.plan.alreadyDone).toBe(0);

    // Only the direct file starts once the mirror behaves; share pages remain manual.
    harness.downloader.failUrls.clear();
    await harness.queue.run();
    const healed = await ok<{ tasks: TaskView[] }>(harness, { type: 'tasks/list' });
    expect(healed.tasks[0]?.completion).toBe('partial');
    expect(healed.tasks[0]?.stats.done).toBe(1);
    expect(healed.tasks[0]?.stats.failed).toBe(5);
  });

  it('pauses a task by dropping what is still waiting', async () => {
    const view = await collect();
    await ok(harness, { type: 'tasks/run', payload: { taskId: view.task.id, start: false } });
    expect(harness.queue.list().filter((row) => row.status === 'pending')).toHaveLength(6);

    await ok(harness, { type: 'tasks/pause', payload: { taskId: view.task.id } });
    expect(harness.queue.list().filter((row) => row.status === 'pending')).toHaveLength(0);
    const paused = await ok<{ tasks: TaskView[] }>(harness, { type: 'tasks/list' });
    // Paused means "the files are back to waiting", not "forgotten".
    expect(paused.tasks[0]?.stats.pending).toBe(6);
    expect(paused.tasks[0]?.stats.queued).toBe(0);
  });

  it('exports both halves of the package and re-imports them into a second profile', async () => {
    const view = await collect();
    const exported = await ok<{ files: Array<{ filename: string; text: string; mime: string }>; count: number }>(harness, {
      type: 'tasks/export',
      payload: { taskId: view.task.id },
    });
    expect(exported.count).toBe(6);
    expect(exported.files.map((file) => file.filename)).toEqual([
      expect.stringContaining('_task.json'),
      expect.stringContaining('_download_links.txt'),
    ]);

    // The friend's side: a fresh profile, nothing but the file.
    const friend = createHarness({ settings: { minRequestIntervalMs: 0, maxConcurrency: 1 } });
    const manifest = exported.files.find((file) => file.mime === 'application/json')!;
    const imported = await ok<{ created: boolean; added: number; task: TaskView; kind: string }>(friend, {
      type: 'tasks/import',
      payload: { text: manifest.text, filename: manifest.filename },
    });
    expect(imported.kind).toBe('json');
    expect(imported.created).toBe(true);
    expect(imported.added).toBe(6);
    expect(imported.task.task.id).toBe(view.task.id);
    expect(imported.task.task.name).toBe(view.task.name);
    expect(imported.task.stats.pending).toBe(6);
    expect(imported.task.completion).toBe('idle');

    // It queues with no server configured on this side at all. (`start: false`
    // only keeps the test deterministic - the default is the user's
    // "Start downloading immediately" setting.)
    const run = await ok<{ queued: number }>(friend, { type: 'tasks/run', payload: { taskId: view.task.id, start: false } });
    expect(run.queued).toBe(6);
    await friend.queue.run();
    const done = await ok<{ tasks: TaskView[] }>(friend, { type: 'tasks/list' });
    expect(done.tasks[0]?.completion).toBe('partial');
    expect(done.tasks[0]?.stats.done).toBe(1);
    expect(done.tasks[0]?.stats.failed).toBe(5);

    // Importing the same package preserves the outcomes without duplicating links.
    const repeat = await ok<{ created: boolean; added: number; updated: number; task: TaskView }>(friend, {
      type: 'tasks/import',
      payload: { text: manifest.text, filename: manifest.filename },
    });
    expect(repeat.created).toBe(false);
    expect(repeat.added).toBe(0);
    expect(repeat.task.stats.done).toBe(1);
    expect(repeat.task.stats.failed).toBe(5);
  });

  it('imports the plain text half too, naming the task from the creator header', async () => {
    const view = await collect();
    const exported = await ok<{ files: Array<{ filename: string; text: string; mime: string }> }>(harness, {
      type: 'tasks/export',
      payload: { taskId: view.task.id },
    });
    const friend = createHarness({ settings: { minRequestIntervalMs: 0 } });
    const text = exported.files.find((file) => file.mime === 'text/plain')!;
    const imported = await ok<{ kind: string; added: number; task: TaskView }>(friend, {
      type: 'tasks/import',
      payload: { text: text.text, filename: text.filename, serverId: null },
    });
    expect(imported.kind).toBe('txt');
    expect(imported.added).toBe(6);
    expect(imported.task.task.name).toBe(`${MOCK_CREATOR.user} · ${MOCK_CREATOR.service}`);
    expect(imported.task.task.id).toBe(`pawchive:${MOCK_CREATOR.service}:${MOCK_CREATOR.user}`);
    // Grouping survives: every file remembers the post it came from, because the
    // `# Post:` section headers of the text file are read back as context.
    const links = await friend.links.list();
    expect(links.every((entry) => entry.postTitle && entry.postUrl?.startsWith('https://pawchive.pw/'))).toBe(true);
  });

  it('names a nameless file after itself instead of inventing a creator', async () => {
    const bare = createHarness({ settings: { minRequestIntervalMs: 0 } });
    const imported = await ok<{ task: TaskView; added: number }>(bare, {
      type: 'tasks/import',
      payload: { text: 'https://mega.nz/file/aaa\nhttps://catbox.moe/x.psd\n', filename: 'artist_a_links.txt' },
    });
    expect(imported.added).toBe(2);
    expect(imported.task.task.name).toBe('artist a');
  });

  it('rescans a creator and only adds posts it has not seen', async () => {
    const view = await collect();
    const first = await ok<{ scannedPosts: number; added: number }>(harness, {
      type: 'tasks/rescan',
      payload: { taskId: view.task.id },
    });
    expect(first.scannedPosts).toBe(0); // everything was already scanned
    expect(first.added).toBe(0);

    // A post that was never scanned (the collector stopped early) is picked up.
    const stopped = await ok<{ tasks: TaskView[] }>(harness, { type: 'tasks/list' });
    const taskId = stopped.tasks[0]!.task.id;
    const partial = createHarness({ settings: { minRequestIntervalMs: 0 } });
    await partial.seed({ seedServers: [SERVER] });
    const begun = await ok<{ task: TaskView }>(partial, {
      type: 'tasks/begin',
      payload: { serverId: (await partial.servers.getDefault())!.id, query: `${MOCK_CREATOR.service}/${MOCK_CREATOR.user}` },
    });
    const second = await ok<{ scannedPosts: number; added: number; task: TaskView }>(partial, {
      type: 'tasks/rescan',
      payload: { taskId: begun.task.task.id, maxPosts: 2 },
    });
    expect(second.scannedPosts).toBe(2);
    expect(second.added).toBeGreaterThan(0);
    expect(second.task.task.runs.at(-1)?.scannedPosts).toBe(2);
    void taskId;
  });

  it('removes a task but keeps its files unless asked otherwise', async () => {
    const view = await collect();
    const removed = await ok<{ removed: boolean }>(harness, {
      type: 'tasks/remove',
      payload: { taskId: view.task.id, keepFiles: true },
    });
    expect(removed.removed).toBe(true);
    expect((await harness.tasks.list())).toHaveLength(0);
    expect((await harness.links.list())).toHaveLength(6);

    const { tasks } = await ok<{ tasks: TaskView[] }>(harness, { type: 'tasks/list' });
    expect(tasks).toHaveLength(0);
  });

  it('drops a task whose files were cleared, so no ghosts stay behind', async () => {
    const view = await collect();
    await ok(harness, { type: 'links/clear', payload: { scope: 'all' } });
    expect(await harness.tasks.list()).toHaveLength(0);
    expect(view.task.memberIds.length).toBeGreaterThan(0);
  });
});
