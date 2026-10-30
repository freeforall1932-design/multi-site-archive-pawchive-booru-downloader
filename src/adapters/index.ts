/**
 * Adapter registration point.
 *
 * Adding a booru-like site is a single line here plus a new adapter module.
 * Nothing else in the codebase branches on site type - see
 * docs/ADAPTER_CONTRACT.md.
 *
 * Families shipped (mirroring what mature clients such as Droidbooru support,
 * see reference/README.md, minus dead or scrape-only sites):
 *
 *   e621            e621.net / e926.net
 *   danbooru        danbooru.donmai.us and Danbooru 2 forks
 *   gelbooru        gelbooru.com (Gelbooru 0.2 DAPI)
 *   gelbooru forks  rule34.xxx, safebooru.org, xbooru, tbib, hypnohub, realbooru (Gelbooru 0.1.11 DAPI)
 *   moebooru        yande.re, konachan
 *   philomena       derpibooru, furbooru, ponybooru
 *   hydrus          your local Hydrus client (Client API)
 *   pawchive        pawchive.pw (creator archive; separate from boorus)
 */
import { registerAdapter } from '../core/registry.js';
import { danbooruAdapter } from './danbooru.js';
import { e621Adapter } from './e621.js';
import { createGelbooruLikeAdapter, gelbooruAdapter } from './gelbooru.js';
import { GELBOORU_FORK_ADAPTERS } from './gelbooru-forks.js';
import { createMoebooruAdapter, MOEBOORU_ADAPTERS } from './moebooru.js';
import { createPhilomenaAdapter, PHILOMENA_ADAPTERS } from './philomena.js';
import { hydrusAdapter } from './hydrus.js';
import { pawchiveAdapter } from './pawchive.js';

let registered = false;

/** Idempotent: safe to call from the service worker, popup, options page and tests. */
export function registerBuiltinAdapters(): void {
  if (registered) return;
  registerAdapter(e621Adapter);
  registerAdapter(danbooruAdapter);
  registerAdapter(gelbooruAdapter);
  for (const adapter of GELBOORU_FORK_ADAPTERS) registerAdapter(adapter);
  for (const adapter of MOEBOORU_ADAPTERS) registerAdapter(adapter);
  for (const adapter of PHILOMENA_ADAPTERS) registerAdapter(adapter);
  registerAdapter(hydrusAdapter);
  registerAdapter(pawchiveAdapter);
  registered = true;
}

/**
 * Attaching another instance of a known family takes a few lines and no
 * changes to shared code, e.g.
 *
 *   registerAdapter(createGelbooruLikeAdapter({
 *     siteType: 'mybooru',
 *     displayName: 'My Booru',
 *     baseUrl: 'https://booru.example',
 *     label: 'My Booru',
 *     hostPatterns: ['booru.example'],
 *     apiDocsUrl: 'https://booru.example/index.php?page=help&topic=dapi',
 *   }));
 *
 * Users can also just pick the family in the server form and type any base
 * URL - host matching for saved servers does not depend on this list.
 */
export {
  e621Adapter,
  danbooruAdapter,
  gelbooruAdapter,
  createGelbooruLikeAdapter,
  createMoebooruAdapter,
  createPhilomenaAdapter,
  pawchiveAdapter,
  hydrusAdapter,
  GELBOORU_FORK_ADAPTERS,
  MOEBOORU_ADAPTERS,
  PHILOMENA_ADAPTERS,
};
