import { describe, expect, it, vi } from 'vitest';
import { ChromeDownloader } from '../../src/core/downloads.js';
import { collectMirrorLinks, extractUrlsFromHtml, extractUrlsFromText, formatLinkExport, mirrorLinkId, parseLinkExport } from '../../src/core/links.js';
import { createServerConfig } from '../../src/core/servers.js';
import { redactUrl } from '../../src/shared/util.js';
import type { MirrorLink, TaskView } from '../../src/shared/types.js';
import { createHarness, httpSnapshot } from '../helpers.js';

const modern = 'https://mega.nz/file/AbCd1234#this-is-a-secret-key';
const legacy = 'https://mega.nz/#!oldId!oldKey';
const proton = 'https://drive.proton.me/urls/share#proton-key';

describe('share-link fragments', () => {
  it('keeps modern and old Mega links plus other providers through extraction and text round-trip', () => {
    const html = `<a href="${modern}">file</a> ${legacy} <a href="${proton}">proton</a>`;
    expect(extractUrlsFromHtml(html)).toEqual(expect.arrayContaining([modern, legacy, proton]));
    expect(extractUrlsFromText(`Links: ${modern}, ${legacy}.`)).toEqual([modern, legacy]);
    const links = collectMirrorLinks({ content: html }, { postId: 'fanbox/1/2' });
    const text = formatLinkExport(links, { grouping: 'plain' });
    expect(text).toContain(modern);
    expect(text).toContain(legacy);
    expect(text).toContain(proton);
    expect(parseLinkExport(text).links).toEqual(expect.arrayContaining([modern, legacy, proton]));
    expect(redactUrl(modern)).not.toContain('this-is-a-secret-key');
  });

  it('keeps distinct keys and old-style fragment IDs distinct', async () => {
    const harness = createHarness();
    const links = collectMirrorLinks({ content: `${modern} https://mega.nz/file/AbCd1234#other-key ${legacy} https://mega.nz/#!another!key` }, {});
    expect(new Set(links.map((link) => link.id)).size).toBe(4);
    await harness.links.add(links);
    expect(await harness.links.list()).toHaveLength(4);
    expect((await harness.links.add(links)).updated).toBe(4);
  });

  it('does not falsely associate an old bare-host row with a legacy share or selected folder', async () => {
    const harness = createHarness();
    await harness.links.add(collectMirrorLinks({ content: 'https://mega.nz/' }, {}));
    await harness.links.add(collectMirrorLinks({ content: legacy }, {}));
    await harness.links.add(collectMirrorLinks({ content: 'https://mega.nz/folder/abc' }, {}));
    await harness.links.add(collectMirrorLinks({ content: 'https://mega.nz/folder/abc#key/folder/subfolder' }, {}));
    expect(await harness.links.list()).toHaveLength(4);
  });

  it('recovers a modern keyless row in place without breaking task or pending queue membership', async () => {
    const harness = createHarness({ settings: { minRequestIntervalMs: 0, maxConcurrency: 1 } });
    const profile = createServerConfig({ siteType: 'pawchive', baseUrl: 'https://pawchive.pw', ratingFilterEnabled: false });
    await harness.seed({ seedServers: [profile] });
    const oldUrl = modern.split('#')[0]!;
    const oldId = mirrorLinkId(oldUrl);
    const imported = await harness.router({ type: 'links/import', payload: { text: oldUrl } });
    expect(imported.ok).toBe(true);
    const begun = await harness.router({ type: 'tasks/begin', payload: { serverId: profile.id, query: 'fanbox/1' } });
    if (!begun.ok) throw new Error(begun.error.message);
    const task = (begun.data as { task: TaskView }).task.task;
    await harness.tasks.attachMembers(task.id, [oldId]);
    const queued = await harness.router({ type: 'links/queue', payload: { ids: [oldId] } });
    expect(queued.ok).toBe(true);
    expect(harness.queue.list()[0]?.url).toBe(oldUrl);

    vi.spyOn(harness.http, 'request').mockResolvedValue(httpSnapshot({
      id: '2', service: 'fanbox', user: '1', content: `<a href="${modern}">share</a>`, file: {}, attachments: [],
    }));
    const scanned = await harness.router({
      type: 'links/scanPost', payload: { serverId: profile.id, postId: 'fanbox/1/2', taskId: task.id },
    });
    expect(scanned.ok).toBe(true);
    const records = await harness.links.list();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ id: oldId, url: modern, status: 'queued' });
    expect((await harness.tasks.get(task.id))?.memberIds).toEqual([oldId]);
    const requeued = await harness.router({ type: 'links/queue', payload: { ids: [oldId] } });
    expect(requeued.ok && requeued.data).toMatchObject({ queued: 0, skipped: 1 });
    expect(harness.queue.list()).toHaveLength(1);

    // The old pending item resolves its upgraded stored URL, but never sends a
    // Mega landing page to Chrome as if it were a direct file.
    expect((await harness.queue.run()).failed).toBe(1);
    expect(harness.queue.list()[0]).toMatchObject({ postId: oldId, url: modern, status: 'failed' });
    expect(harness.downloader.log).toEqual([]);
    const again = await harness.links.add(collectMirrorLinks({ content: modern }, {}));
    expect(again).toMatchObject({ added: 0, updated: 1, resolvedIds: [oldId] });
  });

  it('discards old share-page done claims while retaining records, then recovers the key', async () => {
    const harness = createHarness();
    const oldUrl = modern.split('#')[0]!;
    const old = collectMirrorLinks({ content: oldUrl }, {})[0]!;
    await harness.links.add([old]);
    await harness.links.mark(old.id, 'done', { filename: 'landing.html', bytes: 123 });
    harness.links.invalidate();
    expect((await harness.links.list())[0]).toMatchObject({ status: 'new', filename: null, bytes: null });
    const recovery = await harness.links.add(collectMirrorLinks({ content: modern }, {}));
    expect(recovery.resolvedIds).toEqual([old.id]);
    expect((await harness.links.list())[0]).toMatchObject({ id: old.id, url: modern, status: 'new' });
  });

  it('preserves keyed URLs through task manifest and text export/import', async () => {
    const harness = createHarness();
    const imported = await harness.router({
      type: 'tasks/import', payload: { text: `# Creator: fanbox/1\n${modern}\n${legacy}\n${proton}\n`, filename: 'artist.txt' },
    });
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    const task = (imported.data as { task: TaskView }).task.task;
    const exported = await harness.router({ type: 'tasks/export', payload: { taskId: task.id } });
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    const files = (exported.data as { files: Array<{ text: string; filename: string }> }).files;
    for (const file of files) {
      expect(file.text).toContain(modern);
      expect(file.text).toContain(legacy);
      expect(file.text).toContain(proton);
    }
    const friend = createHarness();
    const again = await friend.router({ type: 'tasks/import', payload: { text: files[0]!.text, filename: files[0]!.filename } });
    expect(again.ok).toBe(true);
    expect((await friend.links.list()).map((link: MirrorLink) => link.url)).toEqual(expect.arrayContaining([modern, legacy, proton]));
  });
});

describe('known provider share pages', () => {
  it('redacts signed URLs embedded in browser and fallback download errors', async () => {
    const url = 'https://t1.pawchive.pw/f/file?s=signed-secret#fragment-secret';
    vi.stubGlobal('chrome', { downloads: { download: async () => { throw new Error(`permission denied: ${url}`); } } });
    try {
      const downloader = new ChromeDownloader({ fetchImpl: async () => { throw new Error(`fetch failed: ${url}`); } });
      // Check the internal direct rejection and the public fallback failure: both
      // can contain a browser-supplied URL, which is later persisted as error text.
      const direct = downloader as unknown as { direct(url: string, filename: string, action: 'uniquify'): Promise<number> };
      const first = await direct.direct(url, 'file', 'uniquify').catch((caught: Error) => caught);
      const second = await downloader.download({ url, filename: 'file' }).catch((caught: Error) => caught);
      for (const error of [first, second]) {
        expect(String(error)).not.toContain('signed-secret');
        expect(String(error)).not.toContain('fragment-secret');
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('refuses known landing pages but still starts direct file URLs', async () => {
    const harness = createHarness({ settings: { minRequestIntervalMs: 0, maxConcurrency: 1 } });
    const shareUrls = [
      modern,
      'https://drive.google.com/file/d/abc/view',
      proton,
      'https://www.mediafire.com/file/abc/a.zip/file',
      'https://gofile.io/d/abc',
      'https://pixeldrain.com/u/abc',
      'https://www.dropbox.com/s/abc/a.zip?dl=0',
    ];
    const direct = ['https://catbox.moe/a.zip', 'https://pixeldrain.com/api/file/abc'];
    await harness.queue.enqueueLinks([...shareUrls, ...direct].map((url) => ({ url })));
    const result = await harness.queue.run();
    expect(result.failed).toBe(shareUrls.length);
    expect(result.done).toBe(direct.length);
    expect(harness.downloader.log.map((entry) => entry.url)).toEqual(direct);
    for (const row of harness.queue.list().slice(0, shareUrls.length)) expect(row.error).toContain('provider downloader');
  });
});
