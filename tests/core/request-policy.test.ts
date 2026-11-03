import { describe, expect, it, vi } from 'vitest';
import { BooruClient } from '../../src/core/client.js';
import { ServerStore } from '../../src/core/servers.js';
import { SettingsStore } from '../../src/core/settings.js';
import { MemoryStorageArea } from '../../src/core/storage.js';
import { ValidationService } from '../../src/core/validation.js';
import { HttpClient } from '../../src/shared/http.js';
import { e621Server, jsonResponse } from '../helpers.js';

describe('shared API request policy', () => {
  it('uses the configured attempt count and the same spacing key for search, post and validation', async () => {
    let calls = 0;
    const area = new MemoryStorageArea();
    const servers = new ServerStore(area);
    const settings = new SettingsStore(area);
    const http = new HttpClient({
      fetchImpl: async () => { calls += 1; return jsonResponse({ error: 'unavailable' }, 503); },
      retryBaseDelayMs: 1,
      sleepImpl: async () => undefined,
    });
    const validation = new ValidationService(http);
    const client = new BooruClient({ servers, settings, http, validation });
    const server = await servers.save(e621Server({ username: '', apiKey: '' }));
    const spy = vi.spyOn(http, 'request');

    await settings.save({ maxRetries: 1, minRequestIntervalMs: 2000 });
    await expect(client.search(server.id, { tags: 'cat' })).rejects.toBeDefined();
    expect(calls).toBe(1);
    await expect(client.getPost(server.id, '1')).rejects.toBeDefined();
    expect(calls).toBe(2);
    await expect(client.getPostPayload(server.id, '1')).rejects.toBeDefined();
    expect(calls).toBe(3);

    await settings.save({ maxRetries: 2 });
    const result = await validation.validate(server, await settings.get());
    expect(result.ok).toBe(false);
    expect(calls).toBe(5); // two validation attempts, including the first
    for (const [, policy] of spy.mock.calls) {
      expect(policy).toMatchObject({ rateKey: `server:${server.id}`, minIntervalMs: 2000 });
    }
    expect(spy.mock.calls.map(([, policy]) => policy?.maxAttempts)).toEqual([1, 1, 1, 2]);
  });
});
