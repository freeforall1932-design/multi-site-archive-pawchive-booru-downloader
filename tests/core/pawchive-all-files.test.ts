import { describe, expect, it, vi } from 'vitest';
import { DownloadQueue } from '../../src/core/queue.js';
import { createServerConfig } from '../../src/core/servers.js';
import { STORAGE_KEYS } from '../../src/core/storage.js';
import type { QueueItem } from '../../src/shared/types.js';
import { createHarness, httpSnapshot } from '../helpers.js';

const hashA = 'a'.repeat(64);
const hashB = 'b'.repeat(64);
const hashC = 'c'.repeat(64);

function server() {
  return createServerConfig({ siteType: 'pawchive', baseUrl: 'https://pawchive.pw', ratingFilterEnabled: false });
}

describe('queue all original files from a Pawchive post', () => {
  it('queues each original attachment, skips deferred/preview-only slots, and ignores off-site links', async () => {
    const harness = createHarness({ settings: { minRequestIntervalMs: 0, maxConcurrency: 1 } });
    const profile = server();
    await harness.seed({ seedServers: [profile] });
    const raw = {
      post: {
        id: '42', user: '123', service: 'fanbox', title: 'Several files',
        file: { name: 'cover.png', path: `/ab/cd/${hashA}.png` },
        attachments: [{ name: 'waiting.zip', deferred: true }],
        content: 'Download more: https://mega.nz/file/abc#decryption-key',
      },
      attachments: [
        { name: 'cover.png', path: `/ab/cd/${hashA}.png` },
        { name: 'movie.webm', path: `/12/34/${hashB}.webm` },
        { name: 'preview.png', path: `/56/78/${hashC}.png`, preview_only: true },
      ],
    };
    vi.spyOn(harness.http, 'request').mockResolvedValue(httpSnapshot(raw));
    const result = await harness.router({ type: 'queue/enqueuePawchivePost', payload: { serverId: profile.id, postId: 'fanbox/123/42' } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toMatchObject({ added: 2, skipped: 0, unavailable: 2 });
    expect(harness.queue.list().map((item) => item.postId)).toEqual(['fanbox/123/42/0', 'fanbox/123/42/2']);
    expect(harness.queue.list().map((item) => item.expectedFileHash)).toEqual([hashA, hashB]);

    const summary = await harness.queue.run();
    expect(summary.done).toBe(2);
    expect(harness.downloader.log.map((entry) => entry.url)).toEqual([
      `https://file.pawchive.pw/data/ab/cd/${hashA}.png?f=cover.png`,
      `https://file.pawchive.pw/data/12/34/${hashB}.webm?f=movie.webm`,
    ]);
    expect(harness.downloader.log.every((entry) => !entry.url.includes('thumbnail') && !entry.url.includes('mega.nz'))).toBe(true);
  });

  it('can queue a later file even if the first slot is deferred', async () => {
    const harness = createHarness({ settings: { minRequestIntervalMs: 0 } });
    const profile = server();
    await harness.seed({ seedServers: [profile] });
    vi.spyOn(harness.http, 'request').mockResolvedValue(httpSnapshot({
      id: '42', user: '123', service: 'fanbox', file: { name: 'waiting.zip', deferred: true },
      attachments: [{ name: 'page.jpg', path: `/ab/cd/${hashA}.jpg` }],
    }));
    const response = await harness.router({ type: 'queue/enqueuePawchivePost', payload: { serverId: profile.id, postId: 'fanbox/123/42' } });
    expect(response.ok && response.data).toMatchObject({ added: 1, unavailable: 1 });
    expect(harness.queue.list()[0]?.postId).toBe('fanbox/123/42/1');
  });

  it('fails closed when a queued attachment hash changes', async () => {
    const harness = createHarness({ settings: { minRequestIntervalMs: 0 } });
    const profile = server();
    await harness.seed({ seedServers: [profile] });
    vi.spyOn(harness.http, 'request').mockResolvedValue(httpSnapshot({
      id: '42', user: '123', service: 'fanbox', file: { name: 'other.png', path: `/ab/cd/${hashB}.png` }, attachments: [],
    }));
    await harness.queue.enqueuePosts(profile.id, [{ id: 'fanbox/123/42/0', expectedFileHash: hashA }]);
    expect((await harness.queue.run()).failed).toBe(1);
    expect(harness.queue.list()[0]?.error).toMatch(/attachment changed/i);
    expect(harness.downloader.log).toEqual([]);
  });

  it('does not bypass a queued attachment identity check when starting the same file directly', async () => {
    const harness = createHarness({ settings: { minRequestIntervalMs: 0 } });
    const profile = server();
    await harness.seed({ seedServers: [profile] });
    vi.spyOn(harness.http, 'request').mockResolvedValue(httpSnapshot({
      id: '42', user: '123', service: 'fanbox', file: { name: 'other.png', path: `/ab/cd/${hashB}.png` }, attachments: [],
    }));
    await harness.queue.enqueuePosts(profile.id, [{ id: 'fanbox/123/42/0', expectedFileHash: hashA }]);
    const response = await harness.router({ type: 'posts/download', payload: { serverId: profile.id, postId: 'fanbox/123/42/0' } });
    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error.message).toMatch(/attachment changed/i);
    expect(harness.queue.list()[0]?.status).toBe('pending');
    expect(harness.downloader.log).toEqual([]);
  });

  it('refuses legacy Pawchive queue rows with ambiguous attachment numbering until re-added', async () => {
    const harness = createHarness({ settings: { minRequestIntervalMs: 0 } });
    const profile = server();
    await harness.seed({ seedServers: [profile] });
    await harness.queue.enqueuePosts(profile.id, [{ id: 'fanbox/123/42/0' }]);
    const stored = (await harness.area.get<{ items: QueueItem[]; paused: boolean }>(STORAGE_KEYS.queue))!;
    delete stored.items[0]!.attachmentIndexVersion;
    await harness.area.set(STORAGE_KEYS.queue, stored);
    const restarted = new DownloadQueue({
      storage: harness.area, client: harness.client, servers: harness.servers,
      settings: harness.settings, downloader: harness.downloader,
    });
    expect((await restarted.run()).failed).toBe(1);
    expect(restarted.list()[0]?.error).toMatch(/older, ambiguous attachment numbering/i);
    expect(harness.downloader.log).toEqual([]);
  });

  it('does not treat a signed preview or has_full=false as a full file', async () => {
    const harness = createHarness({ settings: { minRequestIntervalMs: 0 } });
    const profile = server();
    await harness.seed({ seedServers: [profile] });
    vi.spyOn(harness.http, 'request').mockResolvedValue(httpSnapshot({
      id: '42', user: '123', service: 'fanbox', has_full: false,
      file: { name: 'page.png', path: `/ab/cd/${hashA}.png`, temp_url: 'https://t1.pawchive.pw/f/page.png?s=secret' },
      attachments: [],
    }));
    const response = await harness.router({ type: 'queue/enqueuePawchivePost', payload: { serverId: profile.id, postId: 'fanbox/123/42' } });
    expect(response.ok && response.data).toMatchObject({ added: 0, unavailable: 1 });
    expect(harness.downloader.log).toEqual([]);
  });
});
