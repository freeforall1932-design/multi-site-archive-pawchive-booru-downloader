import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, danbooruServer, e621Server, gelbooruServer } from '../helpers.js';
import type { UiRequest } from '../../src/core/messages.js';
import type { ServerConfigView } from '../../src/shared/types.js';
import { MOCK_POSTS } from '../../src/preview/mock-data.js';

type Harness = ReturnType<typeof createHarness>;

/** Poll `queue/list` until the queue stops working (fire-and-forget runs). */
async function drain(harness: Harness) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const listed = await ok<any>(harness, { type: 'queue/list' });
    if (listed.summary.pending === 0 && listed.summary.running === 0) return listed;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('queue did not drain');
}

/** Assert the envelope succeeded and hand back the payload. */
async function ok<T = any>(harness: Harness, request: UiRequest): Promise<T> {
  const response = await harness.router(request);
  if (!response.ok) throw new Error(`expected ok, got ${JSON.stringify(response.error)}`);
  return response.data as T;
}

async function fail(harness: Harness, request: UiRequest) {
  const response = await harness.router(request);
  if (response.ok) throw new Error('expected a failure response');
  return response.error;
}

describe('router - server management', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = createHarness();
    await harness.seed({ seedServers: [e621Server(), danbooruServer(), gelbooruServer()] });
  });

  it('lists servers as masked views with exactly one default', async () => {
    const views = await ok<ServerConfigView[]>(harness, { type: 'servers/list' });
    expect(views).toHaveLength(3);
    expect(views.filter((view) => view.isDefault)).toHaveLength(1);
    expect(views[0]!.isDefault).toBe(true);
    for (const view of views) {
      expect(view.apiKeyMask).toBeTruthy();
      expect(view.hasApiKey).toBe(true);
      expect('apiKey' in view).toBe(false);
    }
  });

  it('saves a new profile and makes the first one the default', async () => {
    const fresh = createHarness();
    const created = await ok<ServerConfigView>(fresh, {
      type: 'servers/save',
      payload: { label: 'My e621', siteType: 'e621', baseUrl: 'https://e621.net', username: 'someone', apiKey: 'key' },
    });
    expect(created.isDefault).toBe(true);
    expect(created.validationStatus).toBe('unknown');
    expect(created.apiKeyMask).toMatch(/•+$/);
  });

  it('rejects an unknown site type with the unsupported-site kind', async () => {
    const error = await fail(harness, {
      type: 'servers/save',
      payload: { siteType: 'some-future-booru', baseUrl: 'https://future.example', label: 'Future' },
    });
    expect(error.kind).toBe('unsupported-site');
    expect(error.message).toMatch(/site type/i);
  });

  it('duplicates a profile without copying default or validation state', async () => {
    const views = await ok<ServerConfigView[]>(harness, { type: 'servers/list' });
    const copy = await ok<ServerConfigView>(harness, { type: 'servers/duplicate', payload: { id: views[0]!.id } });
    expect(copy.id).not.toBe(views[0]!.id);
    expect(copy.isDefault).toBe(false);
    expect(copy.validationStatus).toBe('unknown');
    expect(copy.lastValidatedAt).toBeNull();
    expect(copy.hasApiKey).toBe(true);
    expect(copy.label).toContain('copy');
  });

  it('promotes another profile when the default is deleted', async () => {
    const views = await ok<ServerConfigView[]>(harness, { type: 'servers/list' });
    const remaining = await ok<ServerConfigView[]>(harness, { type: 'servers/remove', payload: { id: views[0]!.id } });
    expect(remaining).toHaveLength(2);
    expect(remaining.filter((view) => view.isDefault)).toHaveLength(1);
  });

  it('switches the default explicitly', async () => {
    const views = await ok<ServerConfigView[]>(harness, { type: 'servers/list' });
    const updated = await ok<ServerConfigView[]>(harness, { type: 'servers/setDefault', payload: { id: views[2]!.id } });
    expect(updated.find((view) => view.id === views[2]!.id)?.isDefault).toBe(true);
    expect(updated.filter((view) => view.isDefault)).toHaveLength(1);
  });

  it('clears stored credentials on request', async () => {
    const views = await ok<ServerConfigView[]>(harness, { type: 'servers/list' });
    const cleared = await ok<ServerConfigView | null>(harness, {
      type: 'servers/clearCredentials',
      payload: { id: views[0]!.id },
    });
    expect(cleared?.hasApiKey).toBe(false);
    expect(cleared?.apiKeyMask).toBe('');
  });

  it('exports without secrets by default and re-imports cleanly', async () => {
    const plain = await ok<{ json: string; includesSecrets: boolean }>(harness, { type: 'servers/export' });
    expect(plain.includesSecrets).toBe(false);
    expect(plain.json).not.toContain('e621-demo-key');
    expect(plain.json).not.toContain('gelbooru-demo-key');
    const parsed = JSON.parse(plain.json) as { servers: unknown[] };
    expect(parsed.servers).toHaveLength(3);

    const target = createHarness();
    const imported = await ok<{ imported: number; skipped: number; errors: string[] }>(target, {
      type: 'servers/import',
      payload: { json: plain.json },
    });
    expect(imported.imported).toBe(3);
    expect(imported.errors).toEqual([]);
    const views = await ok<ServerConfigView[]>(target, { type: 'servers/list' });
    expect(views.filter((view) => view.isDefault)).toHaveLength(1);
  });

  it('includes secrets only when explicitly asked', async () => {
    const withSecrets = await ok<{ json: string; includesSecrets: boolean }>(harness, {
      type: 'servers/export',
      payload: { includeSecrets: true },
    });
    expect(withSecrets.includesSecrets).toBe(true);
    expect(withSecrets.json).toContain('e621-demo-key');
  });
});

describe('router - validation', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = createHarness();
    await harness.seed({ seedServers: [e621Server()] });
  });

  it('validates the stored profile through the mock API and persists the result', async () => {
    const views = await ok<ServerConfigView[]>(harness, { type: 'servers/list' });
    const result = await ok<any>(harness, { type: 'servers/validate', payload: { id: views[0]!.id } });
    expect(result.ok).toBe(true);
    expect(result.kind).toBe('ok');
    expect(result.endpointOk).toBe(true);
    expect(result.authOk).toBe(true);
    expect(result.trace.length).toBeGreaterThan(0);

    const after = await ok<ServerConfigView[]>(harness, { type: 'servers/list' });
    expect(after[0]!.validationStatus).toBe('valid');
    expect(after[0]!.validationMessage).toMatch(/signed in as demo_e621/i);
    expect(after[0]!.lastValidatedAt).toBeTruthy();
  });

  it('classifies a rejected API key as auth-failure and stores the reason', async () => {
    const views = await ok<ServerConfigView[]>(harness, { type: 'servers/list' });
    await harness.servers.update(views[0]!.id, { apiKey: 'totally-wrong' });
    const result = await ok<any>(harness, { type: 'servers/validate', payload: { id: views[0]!.id } });
    expect(result.kind).toBe('auth-failure');
    expect(result.authOk).toBe(false);
    expect(result.endpointOk).toBe(true);

    const after = await ok<ServerConfigView[]>(harness, { type: 'servers/list' });
    expect(after[0]!.validationStatus).toBe('invalid');
    expect(after[0]!.validationMessage).toMatch(/credential|401|reject/i);
  });

  it('classifies a reached-but-not-a-booru base URL as endpoint-mismatch', async () => {
    const views = await ok<ServerConfigView[]>(harness, { type: 'servers/list' });
    await harness.servers.update(views[0]!.id, { baseUrl: 'https://e621.net/not-the-api' });
    const result = await ok<any>(harness, { type: 'servers/validate', payload: { id: views[0]!.id } });
    expect(result.kind).toBe('endpoint-mismatch');
    expect(result.endpointOk).toBe(false);

    const after = await ok<ServerConfigView[]>(harness, { type: 'servers/list' });
    expect(after[0]!.validationStatus).toBe('invalid');
  });

  it('classifies an offline host as unreachable', async () => {
    const views = await ok<ServerConfigView[]>(harness, { type: 'servers/list' });
    await harness.servers.update(views[0]!.id, { baseUrl: 'https://e621.net/force-offline/host-does-not-exist' });
    const result = await ok<any>(harness, { type: 'servers/validate', payload: { id: views[0]!.id } });
    expect(['endpoint-mismatch', 'network-failure']).toContain(result.kind);
  });

  it('validates an unsaved draft and reuses the stored key when the field is blank', async () => {
    const views = await ok<ServerConfigView[]>(harness, { type: 'servers/list' });
    const stored = await harness.servers.get(views[0]!.id);
    const result = await ok<any>(harness, {
      type: 'servers/validateDraft',
      payload: {
        server: { ...stored!, apiKey: '' },
      },
    });
    expect(result.ok).toBe(true);
    expect(result.kind).toBe('ok');
  });

  it('never sends a masked stored key to a different draft endpoint', async () => {
    const views = await ok<ServerConfigView[]>(harness, { type: 'servers/list' });
    const stored = await harness.servers.get(views[0]!.id);
    const validate = vi.spyOn(harness.validation, 'validate');
    const response = await harness.router({
      type: 'servers/validateDraft',
      payload: { server: { ...stored!, baseUrl: 'https://other.example', apiKey: '' } },
    });
    // An incomplete configuration must be returned before any request is issued.
    expect(response.ok ? response.data : response.error).toMatchObject({ kind: 'incomplete-config' });
    expect(validate).not.toHaveBeenCalled();
  });

  it('reports an incomplete draft instead of throwing', async () => {
    const result = await ok<any>(harness, {
      type: 'servers/validateDraft',
      // A user id without an API key is a genuinely incomplete Gelbooru pair.
      payload: { server: { id: '', siteType: 'gelbooru', baseUrl: 'https://gelbooru.com', userId: '4242', apiKey: '' } },
    });
    expect(result.ok).toBe(false);
    expect(result.kind).toBe('incomplete-config');
  });

  it('never leaks the stored key through a validation response', async () => {
    const views = await ok<ServerConfigView[]>(harness, { type: 'servers/list' });
    const result = await ok<any>(harness, { type: 'servers/validate', payload: { id: views[0]!.id } });
    expect(JSON.stringify(result)).not.toContain('e621-demo-key');
  });
});

describe('router - browse, resolve and download', () => {
  let harness: Harness;
  let e621Id: string;
  let gelbooruId: string;

  beforeEach(async () => {
    harness = createHarness();
    const e621 = e621Server();
    const gelbooru = gelbooruServer();
    await harness.seed({ seedServers: [e621, gelbooru] });
    e621Id = e621.id;
    gelbooruId = gelbooru.id;
  });

  it('searches a listing and returns canonical posts', async () => {
    const result = await ok<any>(harness, {
      type: 'browse/search',
      payload: { serverId: e621Id, spec: { tags: 'safe', limit: 5, page: 1 } },
    });
    expect(result.posts.length).toBeGreaterThan(0);
    expect(result.posts.length).toBeLessThanOrEqual(5);
    for (const post of result.posts) {
      expect(post.siteType).toBe('e621');
      expect(post.fileUrl).toMatch(/^https:\/\/e621\.net\//);
      expect(['safe', 'questionable', 'explicit', 'sensitive', 'general', 'unknown']).toContain(post.rating);
    }
  });

  it('applies the server rating filter to the search request', async () => {
    const result = await ok<any>(harness, {
      type: 'browse/search',
      payload: { serverId: e621Id, spec: { tags: '', limit: 10, page: 1 } },
    });
    expect(result.posts.every((post: any) => post.rating === 'safe' || post.rating === 'unknown')).toBe(true);
  });

  it('passes the rating filter through for gelbooru (safe/sensitive)', async () => {
    const result = await ok<any>(harness, {
      type: 'browse/search',
      payload: { serverId: gelbooruId, spec: { tags: '', limit: 12, page: 0 } },
    });
    expect(result.posts.every((post: any) => ['general', 'sensitive', 'unknown'].includes(post.rating))).toBe(true);
  });

  it('surfaces a rate-limit search failure as a router error', async () => {
    const error = await fail(harness, {
      type: 'browse/search',
      payload: { serverId: e621Id, spec: { tags: 'force:429', limit: 5, page: 1 } },
    });
    expect(error.kind).toBe('rate-limited');
    expect(error.hint).toBeTruthy();
  });

  it('surfaces an HTML reply as an endpoint mismatch', async () => {
    const error = await fail(harness, {
      type: 'browse/search',
      payload: { serverId: e621Id, spec: { tags: 'force:html', limit: 5, page: 1 } },
    });
    expect(error.kind).toBe('endpoint-mismatch');
  });

  it('fetches one post by id', async () => {
    const post = await ok<any>(harness, { type: 'posts/get', payload: { serverId: e621Id, postId: String(MOCK_POSTS[3]!.id) } });
    expect(post.id).toBe(String(MOCK_POSTS[3]!.id));
    expect(post.tags.length).toBeGreaterThan(0);
  });

  it('resolves a post URL to a server + post without knowing the id', async () => {
    const resolved = await ok<any>(harness, {
      type: 'posts/resolveUrl',
      payload: { url: `https://e621.net/posts/${MOCK_POSTS[4]!.id}` },
    });
    expect(resolved.post.id).toBe(String(MOCK_POSTS[4]!.id));
    expect(resolved.server.id).toBe(e621Id);
    expect(resolved.server.apiKeyMask).toBeTruthy();
    expect('apiKey' in resolved.server).toBe(false);
  });

  it('detects a route and attaches the matching saved server', async () => {
    const detected = await ok<any>(harness, {
      type: 'routes/detect',
      payload: { url: `https://gelbooru.com/index.php?page=post&s=view&id=${MOCK_POSTS[5]!.id}` },
    });
    expect(detected.siteType).toBe('gelbooru');
    expect(detected.server?.id).toBe(gelbooruId);
    expect(detected.postId).toBe(String(MOCK_POSTS[5]!.id));
  });

  it('returns null for a URL that is not a booru post page', async () => {
    const detected = await ok<any>(harness, { type: 'routes/detect', payload: { url: 'https://example.com/hello' } });
    expect(detected).toBeNull();
  });

  it('downloads a single post by id and names the file from the template', async () => {
    const safe = MOCK_POSTS.find((post) => post.rating === 'safe')!;
    const result = await ok<any>(harness, {
      type: 'posts/download',
      payload: { serverId: e621Id, postId: String(safe.id) },
    });
    expect(result.filename).toMatch(/^booru\/e621\//);
    expect(result.filename).toMatch(/\.(png|jpg)$/);
    expect(harness.downloader.log).toHaveLength(1);
    expect(harness.downloader.log[0]!.filename).toBe(result.filename);
  });

  it('downloads from a post URL using the matching profile', async () => {
    const allowed = MOCK_POSTS.find((post) => post.rating === 'sensitive' || post.rating === 'general')!;
    const result = await ok<any>(harness, {
      type: 'posts/download',
      payload: { url: `https://gelbooru.com/index.php?page=post&s=view&id=${allowed.id}` },
    });
    expect(result.filename).toMatch(/^booru\/gelbooru\//);
  });

  it('refuses a rating the profile excludes when enforcement is on', async () => {
    const explicit = MOCK_POSTS.find((post) => post.rating === 'explicit')!;
    const error = await fail(harness, {
      type: 'posts/download',
      payload: { serverId: e621Id, postId: String(explicit.id) },
    });
    expect(error.kind).toBe('incomplete-config');
    expect(error.message).toMatch(/rated "explicit"/i);
    expect(error.hint).toMatch(/rating filter|Settings/i);
    expect(harness.downloader.log).toHaveLength(0);
  });

  it('allows the same post when enforcement is disabled in settings', async () => {
    await harness.settings.save({ enforceRatingFilterOnDownload: false });
    const explicit = MOCK_POSTS.find((post) => post.rating === 'explicit')!;
    const result = await ok<any>(harness, {
      type: 'posts/download',
      payload: { serverId: e621Id, postId: String(explicit.id) },
    });
    expect(result.filename).toBeTruthy();
  });
});

describe('router - queue and settings surface', () => {
  let harness: Harness;
  let serverId: string;

  beforeEach(async () => {
    harness = createHarness();
    const server = e621Server();
    serverId = server.id;
    await harness.seed({ seedServers: [server] });
  });

  it('drives the queue through the message protocol', async () => {
    const enqueued = await ok<any>(harness, {
      type: 'queue/enqueuePosts',
      payload: {
        serverId,
        posts: [
          { id: String(MOCK_POSTS[8]!.id), rating: 'safe' },
          { id: String(MOCK_POSTS[9]!.id), rating: 'explicit' },
        ],
      },
    });
    expect(enqueued.added).toBe(1);
    expect(enqueued.skipped).toBe(1);
    expect(enqueued.summary.pending).toBe(1);

    const started = await ok<any>(harness, { type: 'queue/run' });
    expect(started.started).toBe(true);
    const listed = await drain(harness);
    expect(listed.summary.done).toBe(1);
    expect(listed.maxConcurrency).toBeGreaterThan(0);

    expect(listed.items[0]!.status).toBe('done');
    const cleared = await ok<any>(harness, { type: 'queue/clear', payload: { scope: 'completed' } });
    expect(cleared.removed).toBe(1);
    expect(cleared.summary.total).toBe(0);
  });

  it('pauses, resumes and retries through the protocol', async () => {
    await ok(harness, { type: 'queue/enqueue', payload: { items: [{ serverId, postId: String(MOCK_POSTS[10]!.id) }] } });
    const paused = await ok<any>(harness, { type: 'queue/pause' });
    expect(paused.summary.paused).toBe(true);
    const resumed = await ok<any>(harness, { type: 'queue/resume' });
    expect(resumed.summary.paused).toBe(false);
    await drain(harness);
    const retried = await ok<any>(harness, { type: 'queue/retryFailed' });
    expect(retried.requeued).toBe(0);
  });

  it('reads, saves and resets settings', async () => {
    const initial = await ok<any>(harness, { type: 'settings/get' });
    expect(initial.filenameTemplate).toBeTruthy();

    const saved = await ok<any>(harness, {
      type: 'settings/save',
      payload: { filenameTemplate: '{id}_{ext}', folderTemplate: 'downloads/{serverLabel}' },
    });
    expect(saved.filenameTemplate).toBe('{id}_{ext}');

    const reset = await ok<any>(harness, { type: 'settings/reset' });
    expect(reset.filenameTemplate).toBe(initial.filenameTemplate);
  });

  it('calls the User-Agent sync hook on settings changes and on demand', async () => {
    const seen: unknown[] = [];
    const custom = createHarness();
    const server = e621Server();
    await custom.seed({ seedServers: [server] });
    const syncRouter = (await import('../../src/core/router.js')).createRouter({
      client: custom.client,
      queue: custom.queue,
      servers: custom.servers,
      settings: custom.settings,
      downloader: custom.downloader,
      environment: 'extension',
      version: 'test',
      syncUserAgentRules: async (servers, settings) => {
        seen.push({ rest: servers.length, ua: settings.rewriteUserAgent });
        return { ok: true, applied: servers.length };
      },
    });

    const synced = await syncRouter({ type: 'userAgent/sync' });
    expect(synced.ok).toBe(true);
    expect(synced.ok ? (synced.data as { applied: number }).applied : 0).toBe(1);
    await syncRouter({ type: 'settings/save', payload: { rewriteUserAgent: false } });
    expect(seen).toHaveLength(2);
    expect(seen[1]).toMatchObject({ rest: 1, ua: false });
  });

  it('reports diagnostics with adapter catalog and masked servers only', async () => {
    const info = await ok<any>(harness, { type: 'diagnostics/info' });
    expect(info.version).toBe('test');
    expect(info.environment).toBe('extension');
    expect(info.adapters.map((entry: any) => entry.siteType).sort()).toEqual(expect.arrayContaining(['danbooru', 'e621', 'gelbooru']));
    expect(info.servers[0].hasApiKey).toBe(true);
    const serialized = JSON.stringify(info);
    expect(serialized).not.toContain('e621-demo-key');
    expect(serialized).not.toContain('Authorization');
    expect(info.settings.filenameTemplate).toBeTruthy();
  });

  it('rejects an unknown request type with a safe error', async () => {
    const error = await fail(harness, { type: 'nope/unknown' } as unknown as UiRequest);
    expect(error.kind).toBe('unknown');
    expect(error.message).toMatch(/Unsupported request/i);
  });
});
