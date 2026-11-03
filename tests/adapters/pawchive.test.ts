import { describe, expect, it } from 'vitest';
import { registerBuiltinAdapters } from '../../src/adapters/index.js';
import {
  expandPawchivePost,
  normalizePawchiveBaseUrl,
  parsePawchivePostId,
  parsePawchiveQuery,
  pawchiveAdapter,
} from '../../src/adapters/pawchive.js';
import { createAdapterContext, detectRoute, getAdapter, knownSiteTypes } from '../../src/core/registry.js';
import { createServerConfig } from '../../src/core/servers.js';
import { DEFAULT_SETTINGS } from '../../src/shared/types.js';
import { httpSnapshot } from '../helpers.js';

registerBuiltinAdapters();
const server = createServerConfig({ siteType: 'pawchive', baseUrl: 'https://pawchive.pw' });
const ctx = createAdapterContext(pawchiveAdapter, server, DEFAULT_SETTINGS);
const path = `/ab/cd/${'a'.repeat(64)}.png`;
const otherPath = `/12/34/${'b'.repeat(64)}.jpg`;
const post = {
  id: '42', user: '123', service: 'fanbox', title: 'Art pack',
  published: '2026-10-01T00:00:00Z',
  file: { name: 'cover.png', path, node: 2 },
  attachments: [
    { name: 'cover.png', path, node: 2 },
    { name: 'page.jpg', path: otherPath },
  ],
};

function parseSingle(value: unknown, id = 'fanbox/123/42/0') {
  return pawchiveAdapter.parsePostResponse(httpSnapshot(value), id, ctx);
}

describe('Pawchive is the only built-in creator archive', () => {
  it('keeps all booru families and Hydrus registered, but not the removed archives', () => {
    expect(knownSiteTypes()).toEqual(expect.arrayContaining([
      'e621', 'danbooru', 'gelbooru', 'rule34', 'safebooru-org', 'xbooru', 'tbib', 'hypnohub', 'realbooru',
      'yandere', 'konachan', 'derpibooru', 'furbooru', 'ponybooru', 'hydrus', 'pawchive',
    ]));
    expect(getAdapter('kemono')).toBeNull();
    expect(getAdapter('coomer')).toBeNull();
    expect(detectRoute('https://kemono.cr/fanbox/user/1/post/2')).toBeNull();
    expect(detectRoute('https://coomer.st/onlyfans/user/1/post/2')).toBeNull();
    expect(detectRoute('https://gelbooru.com/index.php?page=post&s=view&id=123')).toMatchObject({ siteType: 'gelbooru', kind: 'post' });
    expect(detectRoute('https://pawchive.pw/fanbox/user/123/post/42')).toMatchObject({ siteType: 'pawchive', kind: 'post' });
    expect(detectRoute('https://pawchive.st/fanbox/user/123')).toMatchObject({ siteType: 'pawchive', kind: 'search' });
  });

  it('accepts only Pawchive URLs for Pawchive profiles and creator queries', () => {
    expect(normalizePawchiveBaseUrl('https://www.pawchive.pw/fanbox/user/123')).toBe('https://pawchive.pw');
    expect(normalizePawchiveBaseUrl('pawchive.st/api/v1/posts')).toBe('https://pawchive.st');
    for (const url of ['https://kemono.cr', 'https://coomer.st', 'http://pawchive.pw', 'https://pawchive.pw.example.com', 'https://pawchive.pw:444']) {
      expect(() => normalizePawchiveBaseUrl(url)).toThrow(/official Pawchive/);
    }
    expect(parsePawchiveQuery('https://pawchive.pw/fanbox/user/123?o=50')).toEqual({ kind: 'creator', service: 'fanbox', user: '123' });
    expect(parsePawchiveQuery('patreon/99')).toEqual({ kind: 'creator', service: 'patreon', user: '99' });
    expect(parsePawchiveQuery('tag:furry')).toEqual({ kind: 'tag', tag: 'furry' });
    expect(parsePawchiveQuery('winter art')).toEqual({ kind: 'text', q: 'winter art' });
    expect(() => parsePawchiveQuery('https://kemono.cr/fanbox/user/123')).toThrow(/Only Pawchive/);
    expect(() => parsePawchiveQuery('https://pawchive.pw.example.com/fanbox/user/123')).toThrow(/Only Pawchive/);
  });

  it('parses composite ids and builds creator, title and tag API requests', () => {
    expect(parsePawchivePostId('fanbox/123/42/1')).toEqual({ service: 'fanbox', user: '123', post: '42', index: 1 });
    expect(parsePawchivePostId('123')).toBeNull();
    expect(pawchiveAdapter.buildSearchRequest(ctx, { tags: 'fanbox/123', page: 2 }).url).toBe('https://pawchive.pw/api/v1/fanbox/user/123/posts?o=50');
    expect(pawchiveAdapter.buildSearchRequest(ctx, { tags: 'winter art', page: 3 }).url).toBe('https://pawchive.pw/api/v1/posts?q=winter+art&o=100');
    expect(new URL(pawchiveAdapter.buildSearchRequest(ctx, { tags: 'tag:furry' }).url).searchParams.get('tag')).toBe('furry');
    expect(pawchiveAdapter.buildPostRequest(ctx, 'fanbox/123/42/1').url).toBe('https://pawchive.pw/api/v1/fanbox/user/123/post/42');
  });
});

describe('Pawchive file models', () => {
  it('expands and deduplicates classic files via the current file host', () => {
    const rows = expandPawchivePost(post, ctx);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: 'fanbox/123/42/0', ext: 'png', fileAvailability: 'full', md5: 'a'.repeat(64) });
    expect(rows[0]!.fileUrl).toBe(`https://file.pawchive.pw/data${path}?f=cover.png`);
    expect(rows[0]!.previewUrl).toBe(`https://img.pawchive.pw/thumbnail/data${path}`);
    expect(rows[1]!.id).toBe('fanbox/123/42/1');
    expect(parseSingle(post, 'fanbox/123/42/1').fileUrl).toContain('file.pawchive.pw');
  });

  it('supports bare arrays and wrapped listings while retaining text-only post references', () => {
    const textOnly = { ...post, id: '43', file: {}, attachments: [], content: '<a href="https://mega.nz/file/abc">link</a>' };
    const result = pawchiveAdapter.parseSearchResponse(httpSnapshot([post, textOnly]), { page: 1 }, ctx);
    expect(result.posts).toHaveLength(2);
    expect(result.sourcePosts).toHaveLength(2);
    expect(result.sourcePosts![1]).toMatchObject({ id: 'fanbox/123/43', postUrl: 'https://pawchive.pw/fanbox/user/123/post/43' });
    const wrapped = pawchiveAdapter.parseSearchResponse(httpSnapshot({ count: 51, data: [post] }), { page: 1 }, ctx);
    expect(wrapped.hasMore).toBe(true);
    expect(wrapped.totalCount).toBe(51);
    expect(pawchiveAdapter.buildValidationProbes(ctx)[0]!.interpret(httpSnapshot({ results: [post] })).ok).toBe(true);
  });

  it('uses a valid signed temp URL unchanged and supports a temp-only file', () => {
    const signed = 'https://t1.pawchive.pw/f/xyz/cover.png?e=9999999999&s=secret';
    const signedFile = { name: 'cover.png', path, preview_only: true, temp_url: signed, temp_expires: '2099-01-01T00:00:00Z' };
    const result = parseSingle({ ...post, file: signedFile, attachments: [] });
    expect(result.fileUrl).toBe('');
    expect(result.fileAvailability).toBe('preview');
    expect(result.description).toContain('[preview only]');
    const tempOnly = parseSingle({ ...post, file: { name: 'cover.png', temp_url: signed }, attachments: [] });
    expect(tempOnly.fileUrl).toBe(signed);
    expect(tempOnly.fileAvailability).toBe('temporary');
  });

  it('never uses a full archive or a signed-only file as an automatic thumbnail', () => {
    const archive = parseSingle({ ...post, file: { path: '/ab/cd/pack.zip', name: 'pack.zip' }, attachments: [] });
    const signed = parseSingle({ ...post, file: { name: 'art.png', temp_url: 'https://t1.pawchive.pw/f/art.png?s=secret' }, attachments: [] });
    expect(archive.previewUrl).toBe('');
    expect(archive.fileUrl).toContain('file.pawchive.pw/data/');
    expect(signed.previewUrl).toBe('');
    expect(signed.fileUrl).toContain('t1.pawchive.pw/f/');
  });

  it('keeps thumbnails for display only when the original is unavailable', () => {
    const preview = parseSingle({ ...post, file: { name: 'cover.png', path, preview_only: true }, attachments: [] });
    expect(preview.fileUrl).toBe('');
    expect(preview.previewUrl).toBe(`https://img.pawchive.pw/thumbnail/data${path}`);
    expect(preview.fileAvailability).toBe('preview');
    expect(preview.description).toContain('[preview only]');
    const notImported = parseSingle({ ...post, has_full: false, attachments: [] });
    expect(notImported.fileUrl).toBe('');
    expect(notImported.previewUrl).toBe(`https://img.pawchive.pw/thumbnail/data${path}`);
    expect(notImported.fileAvailability).toBe('preview');
  });

  it('falls back when a temporary link has expired, but retains the full file when available', () => {
    const expired = { name: 'cover.png', path, temp_url: 'https://t1.pawchive.pw/f/1/x?s=old', temp_expires: '2000-01-01T00:00:00' };
    const preview = parseSingle({ ...post, file: { ...expired, preview_only: true }, attachments: [] });
    expect(preview.fileUrl).toBe('');
    expect(preview.previewUrl).toContain('img.pawchive.pw/thumbnail/');
    expect(parseSingle({ ...post, file: expired, attachments: [] }).fileUrl).toContain('file.pawchive.pw/data/');
    expect(() => parseSingle({ ...post, file: { name: 'x.png', temp_url: expired.temp_url, temp_expires: expired.temp_expires }, attachments: [] })).toThrow(/not available yet/);
  });

  it('does not trust foreign, spoofed, insecure or credential-bearing temporary URLs', () => {
    for (const temp of [
      'https://example.com/file.png', 'https://pawchive.pw.example.com/file.png', 'http://t1.pawchive.pw/file.png',
      'https://user:pass@t1.pawchive.pw/file.png', 'https://t1.pawchive.pw:8443/file.png',
    ]) {
      const result = parseSingle({ ...post, file: { name: 'cover.png', path, preview_only: true, temp_url: temp }, attachments: [] });
      expect(result.fileUrl).toBe('');
      expect(result.previewUrl).toBe(`https://img.pawchive.pw/thumbnail/data${path}`);
    }
  });

  it('keeps deferred slots stable, skips unavailable files and reports them on lookup', () => {
    const deferred = { name: 'waiting.mp4', deferred: true };
    const later = { name: 'page.jpg', path: otherPath };
    const fixture = { ...post, file: deferred, attachments: [later] };
    const rows = expandPawchivePost(fixture, ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe('fanbox/123/42/1');
    expect(parseSingle(fixture, rows[0]!.id).fileUrl).toBe(rows[0]!.fileUrl);
    expect(() => parseSingle(fixture, 'fanbox/123/42/0')).toThrow(/not available yet/);
    expect(expandPawchivePost({ ...post, file: { ...deferred, path }, attachments: [] }, ctx)).toEqual([]);
  });

  it('merges duplicate file entries without losing their newer signed URL', () => {
    const signed = 'https://t1.pawchive.pw/f/1/cover.png?s=fresh';
    const fixture = {
      ...post,
      file: { name: 'cover.png', path, temp_url: 'https://t1.pawchive.pw/f/1/old?s=old', temp_expires: '2000-01-01T00:00:00Z' },
      attachments: [{ name: 'cover.png', path, temp_url: signed, temp_expires: '2099-01-01T00:00:00Z' }],
    };
    expect(parseSingle(fixture).fileUrl).toBe(signed);
    expect(expandPawchivePost(fixture, ctx)).toHaveLength(1);
  });
});
