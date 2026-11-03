import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ServerStore, createServerConfig, isUsableServer, toServerView } from '../../src/core/servers.js';
import { MemoryStorageArea } from '../../src/core/storage.js';
import { registerBuiltinAdapters } from '../../src/adapters/index.js';
import { BooruError } from '../../src/shared/errors.js';
import { maskSecret } from '../../src/shared/util.js';
import { createHarness } from '../helpers.js';

registerBuiltinAdapters();

describe('ServerStore - multi-server basics', () => {
  let store: ServerStore;

  beforeEach(() => {
    store = new ServerStore(new MemoryStorageArea());
  });

  it('makes the first saved server the default automatically', async () => {
    const first = await store.save({ siteType: 'e621', baseUrl: 'https://e621.net', label: 'Main e621' });
    const second = await store.save({ siteType: 'gelbooru', baseUrl: 'https://gelbooru.com', label: 'Gelbooru' });
    expect(first.isDefault).toBe(true);
    expect(second.isDefault).toBe(false);
    expect((await store.getDefault())?.id).toBe(first.id);
  });

  it('supports several profiles for the same site type', async () => {
    await store.save({ siteType: 'e621', baseUrl: 'https://e621.net', label: 'Furry' });
    await store.save({ siteType: 'e621', baseUrl: 'https://e926.net', label: 'Safe mirror' });
    const servers = await store.list();
    expect(servers.filter((server) => server.siteType === 'e621')).toHaveLength(2);
  });

  it('promotes exactly one default', async () => {
    const a = await store.save({ siteType: 'e621', baseUrl: 'https://e621.net', label: 'A' });
    const b = await store.save({ siteType: 'danbooru', baseUrl: 'https://danbooru.donmai.us', label: 'B' });
    const after = await store.setDefault(b.id);
    expect(after.filter((server) => server.isDefault)).toHaveLength(1);
    expect(after.find((server) => server.isDefault)?.id).toBe(b.id);
    void a;
  });

  it('normalizes base URLs through the adapter (trimming API suffixes)', async () => {
    const saved = await store.save({ siteType: 'gelbooru', baseUrl: 'https://gelbooru.com/index.php?page=dapi&s=post&q=index' });
    expect(saved.baseUrl).toBe('https://gelbooru.com');
  });

  it('fills defaults from the adapter for a new profile', async () => {
    const saved = await store.save({ siteType: 'danbooru', baseUrl: '' });
    expect(saved.baseUrl).toBe('https://danbooru.donmai.us');
    expect(saved.label).toContain('Danbooru');
    expect(saved.allowedRatings).toEqual(['general', 'sensitive']);
    expect(saved.ratingFilterEnabled).toBe(true);
  });

  it('rejects unsupported site types with a typed error', async () => {
    await expect(store.save({ siteType: 'not-a-booru', baseUrl: 'https://x.example' })).rejects.toBeInstanceOf(BooruError);
    await expect(store.save({ siteType: 'not-a-booru', baseUrl: 'https://x.example' })).rejects.toMatchObject({ kind: 'unsupported-site' });
  });

  it('sorts the default first, then alphabetically', async () => {
    const zeta = await store.save({ siteType: 'e621', baseUrl: 'https://e621.net', label: 'Zeta' });
    await store.save({ siteType: 'e621', baseUrl: 'https://e926.net', label: 'Alpha' });
    await store.setDefault(zeta.id);
    const labels = (await store.list()).map((server) => server.label);
    expect(labels[0]).toBe('Zeta');
    expect(labels.slice(1)).toEqual(['Alpha']);
  });
});

describe('ServerStore - secrets handling', () => {
  let store: ServerStore;
  beforeEach(() => {
    store = new ServerStore(new MemoryStorageArea());
  });

  it('keeps the stored key when the UI sends a blank one (masked-edit flow)', async () => {
    const saved = await store.save({ siteType: 'e621', baseUrl: 'https://e621.net', username: 'u', apiKey: 'real-key' });
    const updated = await store.save({ id: saved.id, siteType: 'e621', baseUrl: 'https://e621.net', username: 'u', apiKey: '', label: 'Renamed' });
    expect(updated.apiKey).toBe('real-key');
    expect(updated.label).toBe('Renamed');
  });

  it('does not carry a masked key to a changed server URL or site type', async () => {
    const saved = await store.save({ siteType: 'e621', baseUrl: 'https://e621.net', username: 'u', apiKey: 'old-secret' });
    await expect(store.save({ id: saved.id, baseUrl: 'https://other.example', apiKey: '' })).rejects.toMatchObject({ kind: 'incomplete-config' });
    await expect(store.save({ id: saved.id, siteType: 'danbooru', baseUrl: 'https://danbooru.donmai.us', apiKey: '' })).rejects.toMatchObject({ kind: 'incomplete-config' });
    expect(await store.get(saved.id)).toMatchObject({ baseUrl: 'https://e621.net', apiKey: 'old-secret' });
    await store.clearCredentials(saved.id);
    expect((await store.save({ id: saved.id, baseUrl: 'https://other.example', apiKey: '' })).apiKey).toBe('');
  });

  it('does not reuse a stored key to validate a changed URL', async () => {
    const harness = createHarness();
    const saved = await harness.servers.save({ siteType: 'e621', baseUrl: 'https://e621.net', username: 'u', apiKey: 'old-secret' });
    const request = vi.spyOn(harness.http, 'request');
    const result = await harness.router({ type: 'servers/validateDraft', payload: { server: { id: saved.id, siteType: 'e621', baseUrl: 'https://other.example', username: 'u', apiKey: '' } } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('incomplete-config');
    expect(request).not.toHaveBeenCalled();
    expect((await harness.servers.get(saved.id))?.apiKey).toBe('old-secret');
  });

  it('replaces the key when a new one is provided', async () => {
    const saved = await store.save({ siteType: 'e621', baseUrl: 'https://e621.net', apiKey: 'old' });
    const updated = await store.save({ ...saved, apiKey: 'new' });
    expect(updated.apiKey).toBe('new');
  });

  it('never exposes the raw key in views', async () => {
    const saved = await store.save({ siteType: 'e621', baseUrl: 'https://e621.net', apiKey: 'super-secret-key' });
    const view = toServerView(saved);
    expect(view.hasApiKey).toBe(true);
    expect(view.apiKeyMask).toBe(maskSecret('super-secret-key'));
    expect(JSON.stringify(view)).not.toContain('super-secret-key');
    expect('apiKey' in view).toBe(false);
  });

  it('rejects URL userinfo and masks it in legacy views and secret-free exports', async () => {
    await expect(store.save({ siteType: 'e621', baseUrl: 'https://user:private-pass@e621.net' })).rejects.toMatchObject({ kind: 'incomplete-config' });
    const legacy = createServerConfig({ siteType: 'e621', baseUrl: 'https://user:private-pass@e621.net', apiKey: 'api-secret' });
    const area = new MemoryStorageArea({ 'bsm.servers': [legacy] });
    const oldStore = new ServerStore(area);
    expect(isUsableServer(legacy)).toBe(false);
    const view = (await oldStore.listViews())[0]!;
    expect(view.baseUrl).not.toContain('private-pass');
    expect(JSON.stringify(view)).not.toContain('api-secret');
    const exported = await oldStore.exportServers();
    expect(exported).not.toContain('private-pass');
    expect(exported).not.toContain('api-secret');
    expect((await oldStore.exportServers({ includeSecrets: true }))).toContain('private-pass');
    const harness = createHarness();
    await harness.area.set('bsm.servers', [legacy]);
    await expect(harness.client.resolve(legacy.id)).rejects.toMatchObject({ kind: 'incomplete-config' });
    const diagnostics = await harness.router({ type: 'diagnostics/info' });
    expect(JSON.stringify(diagnostics)).not.toContain('private-pass');
  });

  it('can wipe credentials without losing the profile or retaining stale validation', async () => {
    const saved = await store.save({ siteType: 'e621', baseUrl: 'https://e621.net', apiKey: 'x' });
    await store.updateValidation(saved.id, {
      kind: 'ok', ok: true, endpointOk: true, authOk: true, message: 'authenticated', warnings: [], account: null,
      checkedAt: new Date().toISOString(), httpStatus: 200, durationMs: 1, trace: [],
    });
    const cleared = await store.clearCredentials(saved.id);
    expect(cleared?.apiKey).toBe('');
    expect(cleared?.baseUrl).toBe('https://e621.net');
    expect(cleared?.validationStatus).toBe('unknown');
    expect(cleared?.validationMessage).toBe('');
    expect(cleared?.lastValidatedAt).toBeNull();
  });

  it('does not lose simultaneous profile saves', async () => {
    const area = new MemoryStorageArea();
    const concurrent = new ServerStore(area);
    await Promise.all([
      concurrent.save({ siteType: 'e621', baseUrl: 'https://e621.net', label: 'First' }),
      concurrent.save({ siteType: 'danbooru', baseUrl: 'https://danbooru.donmai.us', label: 'Second' }),
    ]);
    const profiles = await new ServerStore(area).list();
    expect(profiles.map((entry) => entry.label).sort()).toEqual(['First', 'Second']);
    expect(profiles.filter((entry) => entry.isDefault)).toHaveLength(1);
  });
});

describe('ServerStore - stale validation', () => {
  it('does not mark a changed profile valid after an older probe finishes', async () => {
    const harness = createHarness();
    const profile = await harness.servers.save({ siteType: 'e621', baseUrl: 'https://e621.net', username: 'user', apiKey: 'old' });
    let finish!: (value: Awaited<ReturnType<typeof harness.validation.validate>>) => void;
    const probe = new Promise<Awaited<ReturnType<typeof harness.validation.validate>>>((resolve) => { finish = resolve; });
    const validate = vi.spyOn(harness.validation, 'validate').mockReturnValue(probe);
    const pending = harness.client.validateServer(profile.id);
    await vi.waitFor(() => expect(validate).toHaveBeenCalledTimes(1));
    await harness.servers.save({ id: profile.id, apiKey: 'new' });
    finish({ kind: 'ok', ok: true, endpointOk: true, authOk: true, message: 'old key accepted', warnings: [], account: null,
      checkedAt: new Date().toISOString(), httpStatus: 200, durationMs: 1, trace: [] });
    const result = await pending;
    expect(result).toMatchObject({ ok: false, kind: 'incomplete-config' });
    expect((await harness.servers.get(profile.id))?.validationStatus).toBe('unknown');
  });
});

describe('ServerStore - duplicate, delete, validation bookkeeping', () => {
  let store: ServerStore;
  beforeEach(() => {
    store = new ServerStore(new MemoryStorageArea());
  });

  it('duplicates a profile with a fresh id and cleared validation', async () => {
    const original = await store.save({ siteType: 'e621', baseUrl: 'https://e621.net', label: 'Original', apiKey: 'k' });
    await store.updateValidation(original.id, {
      kind: 'ok',
      ok: true,
      endpointOk: true,
      authOk: true,
      message: 'ok',
      warnings: [],
      account: null,
      checkedAt: new Date().toISOString(),
      httpStatus: 200,
      durationMs: 10,
      trace: [],
    });
    const copy = await store.duplicate(original.id);
    expect(copy.id).not.toBe(original.id);
    expect(copy.label).toBe('Original (copy)');
    expect(copy.apiKey).toBe('k');
    expect(copy.validationStatus).toBe('unknown');
    expect(copy.lastValidatedAt).toBeNull();
    expect(copy.isDefault).toBe(false);
  });

  it('requires an explicit key choice when duplicating to a different target', async () => {
    const original = await store.save({ siteType: 'e621', baseUrl: 'https://e621.net', apiKey: 'old-key' });
    await expect(store.duplicate(original.id, { baseUrl: 'https://other.example' }))
      .rejects.toMatchObject({ kind: 'incomplete-config' });
    const cleared = await store.duplicate(original.id, { baseUrl: 'https://other.example', apiKey: '' });
    expect(cleared.baseUrl).toBe('https://other.example');
    expect(cleared.apiKey).toBe('');
    const replaced = await store.duplicate(original.id, { baseUrl: 'https://other.example', apiKey: 'new-key' });
    expect(replaced.apiKey).toBe('new-key');
    expect((await store.get(original.id))?.apiKey).toBe('old-key');
  });

  it('promotes a new default when the default profile is deleted', async () => {
    const first = await store.save({ siteType: 'e621', baseUrl: 'https://e621.net', label: 'First' });
    const second = await store.save({ siteType: 'danbooru', baseUrl: 'https://danbooru.donmai.us', label: 'Second' });
    const remaining = await store.remove(first.id);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.id).toBe(second.id);
    expect(remaining[0]!.isDefault).toBe(true);
  });

  it('records the validation outcome and invalidates it when the connection changes', async () => {
    const saved = await store.save({ siteType: 'e621', baseUrl: 'https://e621.net', username: 'u', apiKey: 'k' });
    const validated = await store.updateValidation(saved.id, {
      kind: 'auth-failure',
      ok: false,
      endpointOk: true,
      authOk: false,
      message: 'bad key',
      warnings: [],
      account: null,
      checkedAt: '2025-01-01T00:00:00.000Z',
      httpStatus: 401,
      durationMs: 12,
      trace: [],
    });
    expect(validated?.validationStatus).toBe('invalid');
    expect(validated?.validationMessage).toBe('bad key');
    expect(validated?.lastValidatedAt).toBe('2025-01-01T00:00:00.000Z');

    const changed = await store.save({ ...validated!, apiKey: 'new-key' });
    expect(changed.validationStatus).toBe('unknown');
    expect(changed.lastValidatedAt).toBeNull();
  });

  it('marks network failures as unreachable rather than invalid credentials', async () => {
    const saved = await store.save({ siteType: 'e621', baseUrl: 'https://e621.net' });
    const updated = await store.updateValidation(saved.id, {
      kind: 'network-failure',
      ok: false,
      endpointOk: false,
      authOk: null,
      message: 'offline',
      warnings: [],
      account: null,
      checkedAt: '2025-01-01T00:00:00.000Z',
      httpStatus: null,
      durationMs: 3,
      trace: [],
    });
    expect(updated?.validationStatus).toBe('unreachable');
  });
});

describe('ServerStore - import and export', () => {
  it('exports without secrets by default and re-imports safely', async () => {
    const store = new ServerStore(new MemoryStorageArea());
    await store.save({ siteType: 'e621', baseUrl: 'https://e621.net', label: 'Exported', apiKey: 'secret-key' });

    const safe = await store.exportServers();
    expect(safe).not.toContain('secret-key');

    const target = new ServerStore(new MemoryStorageArea());
    const result = await target.importServers(safe);
    expect(result.imported).toBe(1);
    const imported = (await target.list())[0]!;
    expect(imported.label).toBe('Exported');
    expect(imported.apiKey).toBe('');
  });

  it('round-trips secrets when explicitly requested', async () => {
    const store = new ServerStore(new MemoryStorageArea());
    await store.save({ siteType: 'e621', baseUrl: 'https://e621.net', label: 'With key', apiKey: 'secret-key' });
    const withSecrets = await store.exportServers({ includeSecrets: true });
    const target = new ServerStore(new MemoryStorageArea());
    await target.importServers(withSecrets, { includeSecrets: true });
    expect((await target.list())[0]!.apiKey).toBe('secret-key');
  });

  it('skips unsupported site types instead of throwing', async () => {
    const store = new ServerStore(new MemoryStorageArea());
    const payload = JSON.stringify({
      servers: [
        { siteType: 'e621', baseUrl: 'https://e621.net', label: 'Good' },
        { siteType: 'unknown-booru', baseUrl: 'https://x.example', label: 'Bad' },
      ],
    });
    const result = await store.importServers(payload);
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.errors[0]).toContain('unknown-booru');
  });

  it('rejects malformed import payloads', async () => {
    const store = new ServerStore(new MemoryStorageArea());
    await expect(store.importServers('not json')).rejects.toMatchObject({ kind: 'incomplete-config' });
    await expect(store.importServers('{"foo":1}')).rejects.toMatchObject({ kind: 'incomplete-config' });
  });
});
