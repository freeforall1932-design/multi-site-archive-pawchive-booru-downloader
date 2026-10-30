# Reference: Droidbooru 2.0.9 (decompiled)

Read-only reference material. Nothing in here is compiled, imported or shipped by
the extension - it exists so we can study how a mature multi-server booru client
solved the same problems, and port the useful logic to TypeScript.

## Provenance

The repo originally carried `Droidbooru_2_0_9.zip.001-003` (a split zip holding
`Droidbooru_2_0_9.apk`, package `com.bisimplex.firebooru`). That archive was:

1. joined and unzipped to the APK;
2. the APK unzipped again (it is a plain zip);
3. the app's own classes (`com.bisimplex.firebooru.*`, 933 classes) decompiled
   from `classes*.dex` with androguard's DAD decompiler;
4. the string resources and the binary manifest decoded to text;
5. **everything non-code deleted**: the VLC / ObjectBox / gif native `.so`
   libraries (94 MB), the raw `.dex` files, `res/`, `resources.arsc`,
   `META-INF/`, bundled Kotlin metadata and the VLC Lua scripts.

The original split parts are still in Git history at commit `6cc6af0` if the
raw APK is ever needed again. `*.apk` and `*.zip.NNN` are git-ignored.

## Layout

```
Droidbooru_2_0_9_apk/
├── AndroidManifest.decoded.xml      permissions, activities, providers
├── res_strings.txt                  all string resources (labels, hints, URLs)
└── src_decompiled/com/bisimplex/firebooru/
    ├── network/     <- API layer: HttpClient, one Parser* per site family,
    │                   tag-autocomplete parsers, note parsers, HydrusClient
    ├── danbooru/    <- domain layer: ServerItem/ServerItemType (site registry),
    │                   DanbooruPost, DanbooruClient, UserConfiguration,
    │                   FavoriteClient, HistoryClient, TagClient, FileNameType
    ├── model/       <- persisted models: Server, Post, DownloadEntry,
    │                   BlacklistRule, TagHistory, FileNamePartType, ProxyConfiguration
    ├── services/    <- download service, progress, notifications
    ├── backup/      <- server-list export / import format
    ├── parser/      <- low-level JSON/XML helpers
    ├── activity/ fragment/ view/ dataadapter/ widget/ dialog/ skin/ custom/ lock/
    │                <- Android UI; low porting value, kept for completeness
    └── data/        <- SQLite / ObjectBox glue
```

## What is worth porting (and where it maps in our extension)

| Droidbooru | Ours | Notes |
|---|---|---|
| `network/ParserE621JSON` | `src/adapters/e621.ts` | field mapping, `md5FromFile`, tag-category concatenation, fav-sync |
| `network/ParserDanbooru2JSON`, `ParserDanbooru1JSON` | `src/adapters/danbooru.ts` | v1 vs v2 API differences, pool parsing (`ParserPoolDanbooru2JSON`) |
| `network/ParserGelbooruJSON/XML/HTML` | `src/adapters/gelbooru.ts` | three transport fallbacks (JSON -> XML -> HTML scrape); `Gelbooru 0.1.11` vs 0.2 split |
| `network/ParserTagAuto*JSON` | `src/core/search.ts` | per-site tag autocomplete endpoints and response shapes |
| `network/ParserNote*` | (not implemented) | translation notes on posts |
| `danbooru/ServerItemType`, `ServerItem` | `src/core/registry.ts`, `src/shared/types.ts` | their site-type enum and per-type defaults (auth fields, page-size caps, rating vocab) |
| `danbooru/UserConfiguration` | `src/core/settings.ts` | full settings surface of a mature client - good checklist |
| `model/FileNamePartType`, `danbooru/FileNameType` | `src/core/template.ts`, `src/core/naming.ts` | file-name token set |
| `model/BlacklistRule`, `BannedTag` | settings tag blacklist | rule syntax |
| `model/DownloadEntry`, `services/*` | `src/core/queue.ts`, `src/core/downloads.ts` | queue states, retry, resume, history |
| `backup/*` | server export/import JSON | backup schema incl. what they exclude |
| `network/HttpClient`, `CustomDNSSelector`, `model/ProxyConfiguration` | `src/shared/http.ts` | UA handling, retries, DNS-over-HTTPS option |

## Families ported from this reference (2026-09-28)

| Droidbooru type | Our adapter | Live shape re-checked |
|---|---|---|
| `ServerItemTypeGelbooru111` | `src/adapters/gelbooru-forks.ts` (rule34, safebooru.org, xbooru, tbib, hypnohub, realbooru) | safebooru.org bare array; rule34.xxx now requires auth |
| `ServerItemTypeDanbooru` (Danbooru 1 / Moebooru) | `src/adapters/moebooru.ts` (yande.re, konachan) | yande.re `/post.json` |
| `ServerItemTypeDerpibooru` | `src/adapters/philomena.ts` (derpibooru, furbooru, ponybooru) | derpibooru `/api/v1/json/search/images` |
| `ServerItemTypeHydrus` | `src/adapters/hydrus.ts` | per Client API docs (local only, not reachable from the sandbox) |
| `ServerItemTypeKemono` | Historical port removed; only the separate Pawchive creator-archive adapter remains | — |

Not ported, on purpose: `IBSearch` (site is gone), `Shimmie`, `ZeroChan`
(HTML scraping via Jsoup - no stable API), `BooruIO` (tiny, unverified),
`booru-on-rails` (superseded by Philomena), `RSS` (not a booru).

## Porting notes

- The decompiled Java is behaviourally faithful but not idiomatic: expect
  `v0_1`-style locals, `super.field` for `this.field`, and `return;` noise.
- Anything platform-specific (Android `Context`, SQLite, ObjectBox, Glide, VLC)
  has no browser equivalent - port the *logic*, not the classes.
- Everything here runs equally well in a browser extension, a Node/Deno CLI,
  or a desktop wrapper (Tauri/Electron) - the booru APIs are plain HTTPS+JSON.
