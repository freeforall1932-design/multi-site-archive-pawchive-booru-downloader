import { describe, expect, it, vi } from 'vitest';
import {
  HttpClient,
  RateLimiter,
  describeRequest,
  parseJsonBody,
  type FetchLike,
  type HttpClientOptions,
} from '../../src/shared/http.js';
import { BooruError, failureLabel, toBooruError } from '../../src/shared/errors.js';
import { redactUrl } from '../../src/shared/util.js';
import { classifyStatus, detectAuthWordsInBody } from '../../src/adapters/base.js';
import { httpSnapshot, htmlSnapshot, jsonResponse } from '../helpers.js';

const FAST = { maxRetries: 2, retryBaseDelayMs: 1, sleepImpl: async () => undefined } as const;

function client(fetchImpl: FetchLike, options: Partial<HttpClientOptions> = {}) {
  return new HttpClient({ fetchImpl, ...FAST, ...options });
}

describe('RateLimiter', () => {
  it('runs tasks for one key strictly in order', async () => {
    const limiter = new RateLimiter(0);
    const order: number[] = [];
    await Promise.all([
      limiter.run('e621', async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push(1);
      }),
      limiter.run('e621', async () => {
        order.push(2);
      }),
      limiter.run('gelbooru', async () => {
        order.push(3);
      }),
    ]);
    expect(order.indexOf(1)).toBeLessThan(order.indexOf(2));
    expect(order).toContain(3);
  });

  it('waits only the remaining interval', async () => {
    let now = 0;
    const waits: number[] = [];
    const limiter = new RateLimiter(1000, () => now, async (ms) => {
      waits.push(ms);
      now += ms;
    });
    await limiter.run('e621', async () => undefined);
    now += 400;
    await limiter.run('e621', async () => undefined);
    expect(waits).toEqual([600]);
  });

  it('does not wait once the interval has elapsed', async () => {
    let now = 0;
    const waits: number[] = [];
    const limiter = new RateLimiter(500, () => now, async (ms) => {
      waits.push(ms);
      now += ms;
    });
    await limiter.run('e621', async () => undefined);
    now += 900;
    await limiter.run('e621', async () => undefined);
    expect(waits).toEqual([]);
  });

  it('keeps the queue alive after a rejected task', async () => {
    const limiter = new RateLimiter(0);
    await expect(limiter.run('a', async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(limiter.run('a', async () => 'ok')).resolves.toBe('ok');
  });

  it('honours a per-call interval override', () => {
    const limiter = new RateLimiter(0);
    expect(limiter.intervalFor('e621', 2000)).toBe(2000);
    expect(limiter.intervalFor('e621')).toBe(0);
  });
});

describe('HttpClient', () => {
  it('sends the adapter headers and returns a snapshot with timing', async () => {
    const seen: RequestInit[] = [];
    const http = client(async (_input: string, init?: RequestInit) => {
      seen.push(init ?? {});
      return jsonResponse([{ id: 1 }]);
    });
    const snapshot = await http.request({
      url: 'https://e621.net/posts.json?limit=1',
      headers: { 'User-Agent': 'BooruServerManager/0.1 (by demo_e621 on e621)' },
      tag: 'e621',
      label: 'Listing endpoint',
    });
    expect(snapshot.ok).toBe(true);
    expect(snapshot.status).toBe(200);
    expect(snapshot.tag).toBe('e621');
    expect(new Headers(seen[0]!.headers).get('user-agent')).toContain('BooruServerManager');
    expect(snapshot.durationMs).toBeGreaterThanOrEqual(0);
    expect(snapshot.bodyText).toContain('"id"');
  });

  it('retries transient statuses (429 then success)', async () => {
    let calls = 0;
    const http = client(
      async () => {
        calls += 1;
        return calls < 3 ? jsonResponse({ error: 'slow down' }, 429) : jsonResponse({ posts: [] });
      },
      { maxRetries: 3 },
    );
    const snapshot = await http.request({ url: 'https://e621.net/posts.json' });
    expect(calls).toBe(3);
    expect(snapshot.status).toBe(200);
  });

  it('gives up after the retry budget and returns the last snapshot', async () => {
    let calls = 0;
    const http = client(async () => {
      calls += 1;
      return jsonResponse({ error: 'unavailable' }, 503);
    }, { maxRetries: 2 });
    const snapshot = await http.request({ url: 'https://e621.net/posts.json' });
    expect(calls).toBe(2);
    expect(snapshot.status).toBe(503);
    expect(snapshot.ok).toBe(false);
  });

  it('does not retry a 401', async () => {
    let calls = 0;
    const http = client(async () => {
      calls += 1;
      return jsonResponse({ error: 'unauthorized' }, 401);
    }, { maxRetries: 3 });
    const snapshot = await http.request({ url: 'https://e621.net/dmail.json' });
    expect(calls).toBe(1);
    expect(snapshot.status).toBe(401);
  });

  it('throws a network BooruError after exhausting attempts', async () => {
    let calls = 0;
    const http = client(async () => {
      calls += 1;
      throw new TypeError('Failed to fetch');
    });
    await expect(http.request({ url: 'https://e621.net/posts.json' })).rejects.toMatchObject({
      kind: 'network-failure',
      name: 'BooruError',
    });
    expect(calls).toBe(2);
  });

  it('redacts credentials in every snapshot and event', async () => {
    const events: string[] = [];
    const http = client(async () => jsonResponse({ ok: true }), {
      onEvent: (event) => events.push(`${event.url} ${event.message ?? ''}`),
    });
    const snapshot = await http.request({
      url: 'https://gelbooru.com/index.php?page=dapi&s=post&q=index&json=1&api_key=super-secret&user_id=4242',
    });
    // Both halves of the Gelbooru credential pair are treated as secrets, while
    // the harmless query parameters survive for debugging.
    expect(snapshot.redactedUrl).not.toContain('super-secret');
    expect(snapshot.redactedUrl).not.toContain('user_id=4242');
    expect(snapshot.redactedUrl).toContain('user_id=***');
    expect(snapshot.redactedUrl).toContain('json=1');
    expect(events.join(' ')).not.toContain('super-secret');
  });

  it('redacts sensitive query names regardless of capitalization', () => {
    const url = 'https://test.example/file?API_KEY=upper-secret&hydrus-client-api-access-key=hydrus-secret&other=visible';
    const redacted = redactUrl(url);
    expect(redacted).not.toContain('upper-secret');
    expect(redacted).not.toContain('hydrus-secret');
    expect(redacted).toContain('other=visible');
  });

  it('redacts keys when a network error embeds a complete sensitive URL', async () => {
    const events: string[] = [];
    const url = 'https://t1.pawchive.pw/f/file?s=signed-secret#fragment-secret';
    const http = client(async () => { throw new TypeError(`Unable to fetch ${url}`); }, {
      maxRetries: 1,
      onEvent: (event) => events.push(`${event.url} ${event.message ?? ''}`),
    });
    const error = await http.request({ url }).catch((caught: Error) => caught);
    expect(String(error)).not.toContain('signed-secret');
    expect(String(error)).not.toContain('fragment-secret');
    expect(events.join(' ')).not.toContain('signed-secret');
    expect(events.join(' ')).not.toContain('fragment-secret');
  });

  it('surfaces request/response events for diagnostics', async () => {
    const events: string[] = [];
    const http = client(async () => jsonResponse({}), {
      onEvent: (event) => events.push(event.type),
    });
    await http.request({ url: 'https://danbooru.donmai.us/posts.json' });
    expect(events).toEqual(['request', 'response']);
  });

  it('aborts through the caller signal', async () => {
    const controller = new AbortController();
    const http = client(async () => {
      controller.abort();
      throw new DOMException('Aborted', 'AbortError');
    });
    await expect(
      http.request({ url: 'https://e621.net/posts.json' }, { signal: controller.signal }),
    ).rejects.toMatchObject({ kind: 'network-failure' });
  });

  it('applies per-key rate limiting', async () => {
    const sleeps = vi.fn(async () => undefined);
    const http = client(async () => jsonResponse({}), { minIntervalMs: 1000, sleepImpl: sleeps });
    await http.request({ url: 'https://e621.net/posts.json' }, { rateKey: 'server-a' });
    await http.request({ url: 'https://e621.net/posts.json?page=2' }, { rateKey: 'server-a' });
    expect(sleeps).toHaveBeenCalled();
  });
});

describe('parseJsonBody', () => {
  it('parses valid JSON', () => {
    expect(parseJsonBody<{ a: number }>(httpSnapshot({ a: 1 }), 'e621 posts')).toEqual({ a: 1 });
  });

  it('reports an HTML body as an endpoint mismatch', () => {
    let error: BooruError | null = null;
    try {
      parseJsonBody(htmlSnapshot(), 'e621 posts');
    } catch (caught) {
      error = caught as BooruError;
    }
    expect(error?.kind).toBe('endpoint-mismatch');
    expect(error?.hint).toMatch(/base URL/i);
  });

  it('reports an empty body with the site context', () => {
    let error: BooruError | null = null;
    try {
      parseJsonBody(httpSnapshot('', 204, 'application/json'), 'danbooru posts');
    } catch (caught) {
      error = caught as BooruError;
    }
    expect(error?.message).toBe('Empty response body from danbooru posts');
    expect(error?.kind).toBe('parse-failure');
    expect(error?.hint).toMatch(/base URL/i);
  });

  it('reports malformed JSON as a parse failure', () => {
    let error: BooruError | null = null;
    try {
      parseJsonBody(httpSnapshot('{"post": [', 200, 'application/json'), 'gelbooru posts');
    } catch (caught) {
      error = caught as BooruError;
    }
    expect(error?.kind).toBe('parse-failure');
  });
});

describe('classifyStatus', () => {
  it('maps statuses onto the documented failure taxonomy', () => {
    expect(classifyStatus(httpSnapshot({}, 401), 'e621')?.kind).toBe('auth-failure');
    expect(classifyStatus(httpSnapshot({}, 403), 'e621')?.kind).toBe('blocked');
    expect(classifyStatus(httpSnapshot({}, 404), 'e621')?.kind).toBe('endpoint-mismatch');
    expect(classifyStatus(httpSnapshot({}, 405), 'e621')?.kind).toBe('endpoint-mismatch');
    expect(classifyStatus(httpSnapshot({}, 429), 'e621')?.kind).toBe('rate-limited');
    expect(classifyStatus(httpSnapshot({}, 503), 'e621')?.kind).toBe('rate-limited');
    expect(classifyStatus(httpSnapshot({}, 500), 'e621')?.kind).toBe('server-error');
    expect(classifyStatus(httpSnapshot({}, 200), 'e621')).toBeNull();
  });

  it('prefers the HTML check over the status code', () => {
    const failure = classifyStatus(htmlSnapshot('<html>login</html>', 200), 'gelbooru');
    expect(failure?.kind).toBe('endpoint-mismatch');
    expect(failure?.message).toMatch(/HTML page/i);
  });

  it('explains the e621 503 burst limit', () => {
    expect(classifyStatus(httpSnapshot({}, 503), 'e621')?.hint).toMatch(/two-requests-per-second|503/i);
  });
});

describe('detectAuthWordsInBody', () => {
  it('extracts credential errors from plain-text bodies', () => {
    expect(detectAuthWordsInBody('Invalid API key or user id')?.kind).toBe('auth-failure');
    expect(detectAuthWordsInBody('user not found')?.kind).toBe('auth-failure');
    expect(detectAuthWordsInBody('You are blocked for abuse')?.kind).toBe('blocked');
    expect(detectAuthWordsInBody('Too many requests, slow down')?.kind).toBe('rate-limited');
    expect(detectAuthWordsInBody('{"@attributes":{"count":1}}')).toBeNull();
  });
});

describe('describeRequest', () => {
  it('produces a log-safe description', () => {
    const text = describeRequest({
      url: 'https://e621.net/posts.json',
      headers: { Authorization: 'Basic abcdef', 'User-Agent': 'BooruServerManager/0.1' },
    });
    expect(text).toContain('GET https://e621.net/posts.json');
    expect(text).toContain('Authorization: ***');
    expect(text).not.toContain('abcdef');
    expect(text).toContain('User-Agent: BooruServerManager/0.1');
  });
});

describe('BooruError helpers', () => {
  it('keeps kind, status, hint and retryability together', () => {
    const throttled = new BooruError('Throttled', { kind: 'rate-limited', status: 429, hint: 'Wait a moment.' });
    expect(throttled.kind).toBe('rate-limited');
    expect(throttled.status).toBe(429);
    expect(throttled.hint).toBe('Wait a moment.');
    expect(throttled.retryable).toBe(true);
    expect(new BooruError('Nope', { kind: 'auth-failure' }).retryable).toBe(false);
  });

  it('wraps unknown errors without losing the cause', () => {
    const cause = new TypeError('Failed to fetch');
    const wrapped = toBooruError(cause, { kind: 'network-failure' });
    expect(wrapped.kind).toBe('network-failure');
    expect(wrapped.cause).toBe(cause);
    expect(toBooruError(wrapped, { kind: 'unknown' })).toBe(wrapped);
  });

  it('has a human label for every failure kind', async () => {
    const { FAILURE_LABELS } = await import('../../src/shared/errors.js');
    for (const kind of Object.keys(FAILURE_LABELS) as (keyof typeof FAILURE_LABELS)[]) {
      expect(failureLabel(kind)).toBe(FAILURE_LABELS[kind]);
      expect(failureLabel(kind).length).toBeGreaterThan(2);
    }
  });
});
