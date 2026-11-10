import { getPlatform } from '../platform/index.js';
import type { BooruPost } from '../shared/types.js';
import { h, type ElProps } from './dom.js';

type PostImageSource = Pick<BooruPost, 'serverId' | 'siteType' | 'id' | 'previewUrl'> & { cacheScope?: string };

// Small, per-page LRU. No credentials or image bytes are persisted to storage.
const cache = new Map<string, string>();
let cacheSize = 0;
const MAX_CACHE_CHARS = 8 * 1024 * 1024;
const MAX_IN_FLIGHT = 3;
let active = 0;
const pending = new Map<string, Promise<string | null>>();
const waiting: Array<{ image: HTMLImageElement; post: PostImageSource }> = [];
const watched = new WeakMap<HTMLImageElement, PostImageSource>();
let observer: IntersectionObserver | null = null;

function remember(key: string, data: string): void {
  const old = cache.get(key);
  if (old) cacheSize -= old.length;
  cache.delete(key);
  cache.set(key, data);
  cacheSize += data.length;
  while (cacheSize > MAX_CACHE_CHARS && cache.size) {
    const oldest = cache.keys().next().value as string;
    cacheSize -= cache.get(oldest)!.length;
    cache.delete(oldest);
  }
}

function cached(key: string): string | null {
  const value = cache.get(key);
  if (!value) return null;
  cache.delete(key);
  cache.set(key, value);
  return value;
}

function load(image: HTMLImageElement, post: PostImageSource): void {
  if (!image.isConnected) return;
  const key = JSON.stringify([post.serverId, post.id, post.cacheScope ?? post.previewUrl]);
  const existing = cached(key);
  if (existing) {
    image.src = existing;
    return;
  }
  let request = pending.get(key);
  if (!request) {
    request = getPlatform().send({ type: 'posts/thumbnail', payload: { serverId: post.serverId, postId: post.id } })
      .then((response) => {
        if (!response.ok) return null;
        const result = response.data as { dataUrl?: unknown };
        const data = typeof result?.dataUrl === 'string' && /^data:image\/(?:jpeg|png|gif|webp|avif);base64,/i.test(result.dataUrl)
          ? result.dataUrl : null;
        if (data && data.length <= MAX_CACHE_CHARS) remember(key, data);
        return data;
      }).catch(() => null).finally(() => { pending.delete(key); });
    pending.set(key, request);
  }
  active += 1;
  void request.then((data) => {
    if (!image.isConnected) return;
    if (data) image.src = data;
    else {
      image.title = 'Hydrus thumbnail unavailable; check the profile and key.';
      image.dispatchEvent(new Event('error'));
    }
  }).finally(() => {
    active -= 1;
    drain();
  });
}

function drain(): void {
  while (active < MAX_IN_FLIGHT && waiting.length) {
    const next = waiting.shift()!;
    if (next.image.isConnected) load(next.image, next.post);
  }
}

function queue(image: HTMLImageElement, post: PostImageSource): void {
  waiting.push({ image, post });
  drain();
}

/** Hydrus images load lazily via an authenticated worker request, never an URL with a key. */
export function postImage(post: PostImageSource, props: ElProps): HTMLImageElement {
  if (post.siteType !== 'hydrus' || getPlatform().environment === 'preview') {
    return h('img', { ...props, src: post.previewUrl || undefined });
  }
  const image = h('img', { ...props, src: undefined });
  // The caller appends synchronously after constructing the card.
  queueMicrotask(() => {
    if (!image.isConnected) return;
    if (typeof IntersectionObserver === 'undefined') {
      queue(image, post);
      return;
    }
    observer ??= new IntersectionObserver((entries, current) => {
      for (const entry of entries) {
        const target = entry.target as HTMLImageElement;
        if (!target.isConnected || entry.isIntersecting) {
          current.unobserve(target);
          const source = watched.get(target);
          watched.delete(target);
          if (target.isConnected && source) queue(target, source);
        }
      }
    }, { rootMargin: '150px' });
    watched.set(image, post);
    observer.observe(image);
  });
  return image;
}
