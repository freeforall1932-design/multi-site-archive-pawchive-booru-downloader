import { describe, expect, it } from 'vitest';
import { registerBuiltinAdapters } from '../../src/adapters/index.js';
import { createGelbooruLikeAdapter } from '../../src/adapters/gelbooru.js';
import { createAdapterContext, getAdapter, knownSiteTypes, listAdapters, requireAdapter } from '../../src/core/registry.js';
import { BooruError } from '../../src/shared/errors.js';
import { DEFAULT_SETTINGS } from '../../src/shared/types.js';
import { createServerConfig } from '../../src/core/servers.js';
import { redactUrl } from '../../src/shared/util.js';

/** Post ids are opaque per site; Pawchive uses service/creator/post composites. */
const SAMPLE_POST_ID: Record<string, string> = { pawchive: 'fanbox/1245946/12674481' };
const samplePostId = (siteType: string) => SAMPLE_POST_ID[siteType] ?? '123';

registerBuiltinAdapters();

const settings = DEFAULT_SETTINGS;

/**
 * Contract conformance: every registered adapter must implement the shared
 * surface in a way the UI can rely on, regardless of which site it talks to.
 * New adapters automatically inherit these guarantees.
 */
describe('adapter contract conformance', () => {
  const adapters = listAdapters();

  it('registers the three original site types plus the added families', () => {
    expect(knownSiteTypes()).toEqual(
      expect.arrayContaining(['e621', 'danbooru', 'gelbooru', 'rule34', 'safebooru-org', 'yandere', 'konachan', 'derpibooru', 'hydrus', 'pawchive']),
    );
  });

  it.each(adapters.map((adapter) => [adapter.siteType, adapter] as const))('%s declares complete capabilities', (_siteType, adapter) => {
    const capabilities = adapter.capabilities;
    expect(adapter.siteType).toMatch(/^[a-z0-9_-]+$/);
    expect(adapter.displayName.length).toBeGreaterThan(2);
    expect(adapter.hostPatterns.length).toBeGreaterThan(0);
    expect(capabilities.maxPostsPerRequest).toBeGreaterThan(0);
    expect(capabilities.minRequestIntervalMs).toBeGreaterThanOrEqual(0);
    expect(['basic', 'query', 'basic-or-query', 'query-with-userid', 'header']).toContain(capabilities.authStyle);
    expect(capabilities.apiDocsUrl).toMatch(/^https?:\/\//);
    expect(Array.isArray(capabilities.notes)).toBe(true);
    expect(adapter.defaults.baseUrl).toMatch(/^https?:\/\//);
    expect(adapter.defaults.ratings.length).toBeGreaterThan(0);
  });

  it.each(adapters.map((adapter) => [adapter.siteType, adapter] as const))('%s builds valid HTTP requests', (_siteType, adapter) => {
    const server = createServerConfig({
      siteType: adapter.siteType,
      baseUrl: adapter.defaults.baseUrl,
      username: 'user',
      apiKey: 'key',
      userId: '99',
      customUserAgent: 'BooruServerManager/test',
    });
    const ctx = createAdapterContext(adapter, server, settings);
    const search = adapter.buildSearchRequest(ctx, { tags: 'cat', limit: 5, page: 1 });
    const post = adapter.buildPostRequest(ctx, samplePostId(adapter.siteType));

    for (const spec of [search, post]) {
      expect(spec.url).toMatch(/^https?:\/\//);
      expect(new URL(spec.url).host.length).toBeGreaterThan(0);
      expect(spec.method ?? 'GET').toBe('GET');
    }
    expect(search.url).toMatch(/cat/);
  });

  it.each(adapters.map((adapter) => [adapter.siteType, adapter] as const))('%s produces credential-free display URLs', (_siteType, adapter) => {
    // Adapters may put secrets in the query (Gelbooru), but the shared redaction
    // helper must be able to strip them again.
    const server = createServerConfig({
      siteType: adapter.siteType,
      baseUrl: adapter.defaults.baseUrl,
      username: 'user',
      apiKey: 'super-secret-key',
      userId: '99',
    });
    const ctx = createAdapterContext(adapter, server, settings);
    const spec = adapter.buildSearchRequest(ctx, { tags: 'cat' });
    expect(redactUrl(spec.url)).not.toContain('super-secret-key');
    for (const probe of adapter.buildValidationProbes(ctx)) expect(redactUrl(probe.request.url)).not.toContain('super-secret-key');
  });

  it.each(adapters.map((adapter) => [adapter.siteType, adapter] as const))('%s declares validation probes', (_siteType, adapter) => {
    const server = createServerConfig({
      siteType: adapter.siteType,
      baseUrl: adapter.defaults.baseUrl,
      username: 'user',
      apiKey: 'key',
      userId: '99',
    });
    const probes = adapter.buildValidationProbes(createAdapterContext(adapter, server, settings));
    expect(probes.length).toBeGreaterThan(0);
    expect(probes.some((probe) => probe.purpose === 'endpoint')).toBe(true);
    for (const probe of probes) {
      expect(probe.id.length).toBeGreaterThan(0);
      expect(probe.request.url).toMatch(/^https?:\/\//);
      expect(typeof probe.interpret).toBe('function');
    }
  });

  it.each(adapters.map((adapter) => [adapter.siteType, adapter] as const))('%s maps every site rating token to a canonical rating', (_siteType, adapter) => {
    if (!adapter.capabilities.supportsRatingFilter) {
      // Sites without ratings (Hydrus, Pawchive) must say so and stay inert.
      expect(adapter.siteRatingTokens).toHaveLength(0);
      expect(adapter.ratingQueryTags([]).tags).toHaveLength(0);
      expect(adapter.normalizeRating('anything')).toBe('unknown');
      return;
    }
    expect(adapter.siteRatingTokens.length).toBeGreaterThan(0);
    for (const token of adapter.siteRatingTokens) {
      expect(adapter.canonicalRatingFor(token)).toBeTruthy();
      expect(adapter.normalizeRating(token)).toBe(adapter.canonicalRatingFor(token));
    }
    expect(adapter.normalizeRating('definitely-not-a-rating')).toBe('unknown');
  });

  it.each(adapters.map((adapter) => [adapter.siteType, adapter] as const))('%s keeps rating filter semantics deterministic', (_siteType, adapter) => {
    const none = adapter.ratingQueryTags([]);
    expect(none.tags).toHaveLength(adapter.siteRatingTokens.length);

    const all = adapter.ratingQueryTags(['general', 'safe', 'sensitive', 'questionable', 'explicit']);
    expect(all.tags).toHaveLength(0);

    // Exclusions are `-rating:x` on most sites; Philomena ratings are plain tags (`-explicit`).
    for (const tag of none.tags) expect(tag.startsWith('-')).toBe(true);
  });

  it.each(adapters.map((adapter) => [adapter.siteType, adapter] as const))('%s exposes credential fields covering the UI schema', (_siteType, adapter) => {
    const fields = adapter.credentialFields();
    expect(fields.length).toBeGreaterThan(0);
    for (const field of fields) {
      expect(['username', 'apiKey', 'userId', 'customUserAgent']).toContain(field.key);
      expect(field.label.length).toBeGreaterThan(0);
      expect(typeof field.required).toBe('boolean');
      expect(typeof field.secret).toBe('boolean');
    }
    if (adapter.capabilities.requiresApiKey) {
      expect(fields.some((field) => field.key === 'apiKey')).toBe(true);
    }
  });

  it.each(adapters.map((adapter) => [adapter.siteType, adapter] as const))('%s suggests a descriptive (non-browser) User-Agent', (_siteType, adapter) => {
    const suggestion = adapter.suggestUserAgent({
      server: { username: 'demo', userId: '1', customUserAgent: '' },
      baseUrl: adapter.defaults.baseUrl,
    });
    expect(suggestion.length).toBeGreaterThan(5);
    expect(suggestion).not.toMatch(/mozilla|chrome|safari|firefox/i);
  });

  it('rethrows a typed error for unsupported site types', () => {
    try {
      requireAdapter('nonexistent-site');
      throw new Error('expected requireAdapter to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(BooruError);
      expect((error as BooruError).kind).toBe('unsupported-site');
    }
    expect(getAdapter('nonexistent-site')).toBeNull();
  });

  it('registering a new adapter needs no other code changes', async () => {
    const custom = createGelbooruLikeAdapter({
      siteType: 'contract-fork',
      displayName: 'Contract Fork',
      baseUrl: 'https://fork.example',
      label: 'Contract fork',
      hostPatterns: ['fork.example'],
      apiDocsUrl: 'https://fork.example/wiki',
    });
    const before = knownSiteTypes().length;
    const { registerAdapter, unregisterAdapter } = await import('../../src/core/registry.js');
    registerAdapter(custom);
    expect(knownSiteTypes().length).toBe(before + 1);
    unregisterAdapter('contract-fork');
    expect(knownSiteTypes().length).toBe(before);
  });
});
