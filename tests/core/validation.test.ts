import { describe, expect, it } from 'vitest';
import { ValidationService } from '../../src/core/validation.js';
import { HttpClient, type FetchLike } from '../../src/shared/http.js';
import { registerBuiltinAdapters } from '../../src/adapters/index.js';
import { DEFAULT_SETTINGS } from '../../src/shared/types.js';
import { createServerConfig } from '../../src/core/servers.js';
import { danbooruServer, e621Server, gelbooruServer, htmlSnapshot, jsonResponse } from '../helpers.js';

registerBuiltinAdapters();

function service(fetchImpl: FetchLike) {
  const http = new HttpClient({ fetchImpl, maxRetries: 1, retryBaseDelayMs: 1, sleepImpl: async () => undefined });
  return new ValidationService(http, { probeTimeoutMs: 5000 });
}

const failing: FetchLike = async () => {
  throw new TypeError('fetch failed');
};

describe('validation - preflight (no network)', () => {
  it('reports an unsupported site type without touching the network', async () => {
    let called = false;
    const validator = service(async () => {
      called = true;
      return jsonResponse([]);
    });
    const result = await validator.validate(
      createServerConfig({ siteType: 'unknown-booru', baseUrl: 'https://x.example' }),
      DEFAULT_SETTINGS,
    );
    expect(result.kind).toBe('unsupported-site');
    expect(result.ok).toBe(false);
    expect(called).toBe(false);
  });

  it('reports incomplete configuration for a bad base URL', async () => {
    const validator = service(failing);
    const result = await validator.validate(createServerConfig({ siteType: 'e621', baseUrl: 'not a url' }), DEFAULT_SETTINGS);
    expect(result.kind).toBe('incomplete-config');
    expect(result.endpointOk).toBeNull();
  });

  it('rejects embedded URL credentials before making a request', async () => {
    let called = false;
    const validator = service(async () => { called = true; return jsonResponse([]); });
    const result = await validator.validate(e621Server({ baseUrl: 'https://user:secret-pass@e621.net' }), DEFAULT_SETTINGS);
    expect(result.kind).toBe('incomplete-config');
    expect(result.message).toMatch(/credential/i);
    expect(JSON.stringify(result)).not.toContain('secret-pass');
    expect(called).toBe(false);
  });

  it('requires the missing credential fields for Gelbooru (user id without key)', async () => {
    const validator = service(failing);
    const result = await validator.validate(gelbooruServer({ apiKey: '', userId: '4242' }), DEFAULT_SETTINGS);
    expect(result.kind).toBe('incomplete-config');
    expect(result.message).toMatch(/API key/i);
  });
});

describe('validation - endpoint layer', () => {
  it('passes the endpoint probe and skips auth when no credentials exist', async () => {
    const validator = service(async (input) => {
      if (input.includes('e621.net')) return jsonResponse([]);
      return jsonResponse({}, 404);
    });
    const server = e621Server({ username: '', apiKey: '' });
    const result = await validator.validate(server, DEFAULT_SETTINGS);
    expect(result.ok).toBe(true);
    expect(result.endpointOk).toBe(true);
    expect(result.authOk).toBeNull();
    expect(result.warnings.join(' ')).toMatch(/read-only/i);
  });

  it('classifies an HTML page as endpoint mismatch and never probes auth', async () => {
    let authCalls = 0;
    const validator = service(async (input) => {
      if (new URL(input).pathname === '/dmail.json') authCalls += 1;
      return new Response('<!doctype html><html><body>login</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    });
    const result = await validator.validate(e621Server(), DEFAULT_SETTINGS);
    expect(result.kind).toBe('endpoint-mismatch');
    expect(result.endpointOk).toBe(false);
    expect(authCalls).toBe(0);
    expect(result.trace).toHaveLength(1);
  });

  it('classifies a network failure', async () => {
    const validator = service(failing);
    const result = await validator.validate(danbooruServer(), DEFAULT_SETTINGS);
    expect(result.kind).toBe('network-failure');
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Network request failed/i);
  });

  it('classifies rate limiting distinctly', async () => {
    const validator = service(async () => jsonResponse({ error: 'rate limited' }, 429));
    const result = await validator.validate(e621Server(), DEFAULT_SETTINGS);
    expect(result.kind).toBe('rate-limited');
  });
});

describe('validation - auth layer', () => {
  it('reports success with the account name for Danbooru', async () => {
    const validator = service(async (input) => {
      const path = new URL(input).pathname;
      if (path === '/profile.json') return jsonResponse({ id: 778_899, name: 'demo_danbooru', level_string: 'Member' });
      return jsonResponse([{ id: 1 }]);
    });
    const result = await validator.validate(danbooruServer(), DEFAULT_SETTINGS);
    expect(result.ok).toBe(true);
    expect(result.authOk).toBe(true);
    expect(result.account?.username).toBe('demo_danbooru');
    expect(result.trace.map((entry) => entry.purpose)).toEqual(['endpoint', 'auth']);
  });

  it('separates a bad key (401) from a blocked request (403)', async () => {
    const unauthorized = service(async (input) => (new URL(input).pathname === '/profile.json' ? jsonResponse({ error: 'unauthorized' }, 401) : jsonResponse([])));
    const forbidden = service(async (input) => (new URL(input).pathname === '/profile.json' ? jsonResponse({ error: 'forbidden' }, 403) : jsonResponse([])));

    const badKey = await unauthorized.validate(danbooruServer(), DEFAULT_SETTINGS);
    expect(badKey.kind).toBe('auth-failure');
    expect(badKey.authOk).toBe(false);
    expect(badKey.endpointOk).toBe(true);

    const blocked = await forbidden.validate(danbooruServer(), DEFAULT_SETTINGS);
    expect(blocked.kind).toBe('blocked');
  });

  it('falls through optional probes when a fork lacks the endpoint', async () => {
    const calls: string[] = [];
    const validator = service(async (input) => {
      const path = new URL(input).pathname;
      calls.push(path);
      if (path === '/dmail.json') return jsonResponse({ error: 'not found' }, 404);
      if (path === '/favorites.json') return jsonResponse([{ id: 1 }]);
      return jsonResponse([]);
    });
    const result = await validator.validate(e621Server(), DEFAULT_SETTINGS);
    expect(calls).toEqual(['/posts.json', '/dmail.json', '/favorites.json']);
    expect(result.ok).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/not available/i);
  });

  it('treats Gelbooru credential errors reported as 200 bodies as auth failures', async () => {
    const validator = service(async (input) => {
      const url = new URL(input);
      if (url.searchParams.has('api_key')) {
        return new Response('Invalid API key or user id', { status: 200, headers: { 'content-type': 'text/plain' } });
      }
      return jsonResponse({ '@attributes': { limit: 1, offset: 0, count: 1 }, post: [{ id: 1 }] });
    });
    const result = await validator.validate(gelbooruServer(), DEFAULT_SETTINGS);
    expect(result.kind).toBe('auth-failure');
    expect(result.endpointOk).toBe(true);
  });

  it('warns about the generated User-Agent when e621 policy needs one', async () => {
    const validator = service(async (input) => jsonResponse(new URL(input).pathname === '/posts.json' ? [] : []));
    const result = await validator.validate(e621Server({ customUserAgent: '' }), DEFAULT_SETTINGS);
    expect(result.warnings.join(' ')).toMatch(/generated User-Agent/i);
  });

  it('warns when the configured User-Agent looks like a browser', async () => {
    const validator = service(async (input) => jsonResponse(new URL(input).pathname === '/posts.json' ? [] : []));
    const result = await validator.validate(
      e621Server({ customUserAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120' }),
      DEFAULT_SETTINGS,
    );
    expect(result.warnings.join(' ')).toMatch(/browser UA/i);
  });

  it('warns about plain HTTP base URLs', async () => {
    const validator = service(async (input) => jsonResponse(new URL(input).pathname === '/posts.json' ? [] : []));
    const result = await validator.validate(e621Server({ baseUrl: 'http://e621.net' }), DEFAULT_SETTINGS);
    expect(result.warnings.join(' ')).toMatch(/plain HTTP/i);
  });

  it('records a sanitized trace that never contains the api key', async () => {
    const validator = service(async (input) => {
      const path = new URL(input).pathname;
      if (path === '/profile.json') return jsonResponse({ id: 1, name: 'demo_danbooru' });
      return jsonResponse([]);
    });
    const result = await validator.validate(danbooruServer({ apiKey: 'super-secret-key' }), DEFAULT_SETTINGS);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('super-secret-key');
    expect(result.trace.every((entry) => !!entry.requestUrl)).toBe(true);
  });

  it('redacts credentials for query-auth sites (Gelbooru)', async () => {
    const validator = service(async () =>
      jsonResponse({ '@attributes': { limit: 1, offset: 0, count: 0 } }),
    );
    const result = await validator.validate(gelbooruServer({ apiKey: 'gelbooru-demo-key' }), DEFAULT_SETTINGS);
    const serialized = JSON.stringify(result.trace);
    expect(serialized).not.toContain('gelbooru-demo-key');
    expect(serialized).toContain('***');
  });

  it('reports progress through the optional callback', async () => {
    const events: string[] = [];
    const validator = service(async (input) => jsonResponse(new URL(input).pathname === '/posts.json' ? [] : []));
    await validator.validate(e621Server(), DEFAULT_SETTINGS, (event) => events.push(`${event.probeId}:${event.ok}`));
    expect(events[0]).toMatch(/e621-endpoint:true/);
  });
});

describe('validation - trace shape', () => {
  it('captures status codes, timing and labels for diagnostics', async () => {
    const validator = service(async (input) => jsonResponse(new URL(input).pathname === '/posts.json' ? [] : [], 200));
    const result = await validator.validate(e621Server(), DEFAULT_SETTINGS);
    const endpoint = result.trace[0]!;
    expect(endpoint.status).toBe(200);
    expect(endpoint.label).toContain('Listing endpoint');
    expect(endpoint.method).toBe('GET');
    expect(endpoint.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.checkedAt).toMatch(/T/);
  });

  it('provides a helpful hint for HTML endpoint mismatches', async () => {
    const validator = service(async () => new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    const result = await validator.validate(danbooruServer(), DEFAULT_SETTINGS);
    expect(result.warnings.join(' ')).toMatch(/base URL/i);
    void htmlSnapshot;
  });
});
