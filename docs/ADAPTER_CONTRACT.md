# The booru adapter contract

Every supported site is one implementation of `BooruAdapter`
(`src/core/adapter.ts`). The rest of the extension — UI, server manager,
validation, queue, naming and downloads — uses the registry for common site API
mappings. The shared layer is not completely site-agnostic: Pawchive has explicit
attachment, pacing and task policies, and new sites may need manifest permissions
or dedicated behavior.

A new adapter starts with an implementation and registration, must pass
`tests/adapters/contract.test.ts`, and needs site-specific fixtures, permission
review and original-only download tests. The snippets below are illustrative,
not a copy-paste-complete adapter.

---

## 1. Types an adapter works with

```ts
interface AdapterContext {          // built by createAdapterContext()
  server: ServerConfig;             // full profile incl. credentials
  settings: ExtensionSettings;
  userAgent: string;                // effective UA (custom or generated)
  baseUrl: string;                  // normalized, no trailing slash
}

interface AdapterCapabilities {     // what the site can do — drives the UI
  supportsAnonymousAccess: boolean;
  supportsRatingFilter: boolean;
  requiresUsername: boolean;
  requiresUserId: boolean;
  requiresApiKey: boolean;
  requiresUserAgent: boolean;
  authStyle: 'basic' | 'query' | 'basic-or-query' | 'query-with-userid' | 'header';
  supportsBasicAuthHeader: boolean;
  maxPostsPerRequest: number;       // e621 320, Danbooru 200, Gelbooru 100
  maxPage: number | null;           // e621 listing stops at page 750
  minRequestIntervalMs: number;     // site-documented minimum gap
  supportsPostLookup: boolean;
  supportsTagSearch: boolean;
  supportsIdPagination: boolean;    // e621 `b<id>` style paging
  apiDocsUrl: string;               // shown in Diagnostics
  notes: string[];                  // short, user-visible caveats
}

interface AdapterDefaults {
  baseUrl: string;
  label: string;
  ratings: Rating[];                // pre-selected allow-list when filtering is on
  userAgentHint: string;            // fallback descriptive UA
}

interface CredentialField {
  key: 'username' | 'apiKey' | 'userId' | 'customUserAgent';
  label: string;
  type: 'text' | 'password' | 'textarea';
  required: boolean;                // profile is unusable without it
  requiredForAuth: boolean;         // needed only when signing in
  secret: boolean;                  // profile field should be masked; audit all generated URLs too
  placeholder?: string;
  help?: string;
}
```

## 2. The contract

```ts
interface BooruAdapter {
  readonly siteType: SiteType;
  readonly displayName: string;
  readonly capabilities: AdapterCapabilities;
  readonly hostPatterns: string[];          // e.g. ['*.gelbooru.com']
  readonly defaults: AdapterDefaults;

  normalizeBaseUrl?(raw: string): string;   // optional clean-up of user input
  matchesHost(host: string): boolean;

  matchRoute(url: string): RouteMatch | null;          // pure; no server needed
  postUrl(baseUrl: string, postId: string): string;

  buildSearchRequest(ctx: AdapterContext, spec: SearchSpec): HttpRequestSpec;
  buildPostRequest(ctx: AdapterContext, postId: string): HttpRequestSpec;
  buildValidationProbes(ctx: AdapterContext): ValidationProbe[];

  parseSearchResponse(snapshot, spec, ctx): SearchResult;
  parsePostResponse(snapshot, postId, ctx): BooruPost;
  normalizePost(raw: unknown, ctx: AdapterContext): BooruPost;

  normalizeRating(raw: unknown): Rating;
  readonly siteRatingTokens: readonly string[];
  canonicalRatingFor(siteToken: string): Rating | null;
  ratingQueryTags(allowed: Rating[]): { tags: string[]; warnings: string[] };

  classifyFailure?(snapshot: HttpResponseSnapshot): AdapterFailure | null;
  credentialFields(server?: Partial<ServerConfig>): CredentialField[];
  suggestUserAgent(ctx: UserAgentHintContext): string;
  decorateRequest?(ctx: AdapterContext, spec: HttpRequestSpec): HttpRequestSpec;
}
```

### Invariants the conformance suite enforces

| Invariant | Why |
| --- | --- |
| `capabilities.authStyle` is one of the five documented values | The server form and diagnostics render it verbatim |
| `credentialFields().key` ⊆ `{username, apiKey, userId, customUserAgent}` | The profile schema is fixed by product policy |
| At least one probe has `purpose: 'endpoint'` | Endpoint mismatch must be diagnosable before credentials |
| Every auth probe is `enabled: false` when no credentials are saved | Anonymous read-only validation must work |
| Every entry of `siteRatingTokens` maps through `canonicalRatingFor` | Rating filters must be exact |
| `normalizeRating(unknownValue)` returns `'unknown'`, never throws | Parsers must survive new site tokens |
| `ratingQueryTags([])` excludes every canonical rating | Empty allow-list must never mean “everything” |
| `suggestUserAgent()` output is never browser-like (`Mozilla/…`) | Site policies forbid impersonating a browser |
| `matchRoute()` is pure and returns `null` for foreign URLs | The popup asks before any server is saved |
| Adapter registration exposes it to the common contract | Additional permissions or site-specific policies may still require shared changes |

## 3. Writing an adapter

This is a sketch: implement the omitted parsing and interpretation methods,
handle malformed/foreign URLs, and review permissions before registering it.

```ts
// src/adapters/example.ts
import { classifyStatus, readJson, ratingExclusions, composeTags } from './base.js';
import type { BooruAdapter } from '../core/adapter.js';

export const exampleAdapter: BooruAdapter = {
  siteType: 'example',
  displayName: 'Example Booru',
  capabilities: {
    supportsAnonymousAccess: true,
    supportsRatingFilter: true,
    requiresUsername: false,
    requiresUserId: false,
    requiresApiKey: true,
    requiresUserAgent: true,
    authStyle: 'header',
    supportsBasicAuthHeader: false,
    maxPostsPerRequest: 100,
    maxPage: null,
    minRequestIntervalMs: 1000,
    supportsPostLookup: true,
    supportsTagSearch: true,
    supportsIdPagination: false,
    apiDocsUrl: 'https://example.invalid/api',
    notes: ['Reads are public; writes need an API key.'],
  },
  hostPatterns: ['example.invalid', '*.example.invalid'],
  defaults: {
    baseUrl: 'https://example.invalid',
    label: 'Example Booru',
    ratings: ['safe', 'general'],
    userAgentHint: 'BooruServerManager/0.2.0 (by example_user on example.invalid)',
  },

  matchesHost(host) {
    return host === 'example.invalid' || host.endsWith('.example.invalid');
  },

  matchRoute(url) {
    const parsed = new URL(url);
    const post = /^\/post\/(\d+)$/.exec(parsed.pathname);
    if (post) return { siteType: 'example', kind: 'post', postId: post[1]!, tags: null, page: null, canonicalUrl: parsed.toString() };
    return null;
  },

  postUrl(baseUrl, postId) {
    return `${baseUrl}/post/${postId}`;
  },

  buildSearchRequest(ctx, spec) {
    const params = new URLSearchParams({ limit: String(Math.min(spec.limit ?? 50, 100)) });
    const filter = spec.ratingFilter?.enabled ? ratingExclusions(this, spec.ratingFilter.allowed) : { tags: [], warnings: [] };
    params.set('tags', composeTags(spec.tags, filter.tags, ctx.settings.globalTagSuffix));
    return {
      url: `${ctx.baseUrl}/api/posts?${params}`,
      headers: ctx.server.apiKey ? { 'X-API-Key': ctx.server.apiKey } : {},
      redirect: 'error', tag: 'example', label: 'Listing',
    };
  },

  buildPostRequest(ctx, postId) {
    return { url: `${ctx.baseUrl}/api/posts/${encodeURIComponent(postId)}`, tag: 'example', label: 'Post lookup' };
  },

  buildValidationProbes(ctx) {
    const hasCredentials = Boolean(ctx.server.apiKey);
    return [
      {
        id: 'example-endpoint',
        label: 'Listing endpoint (anonymous)',
        purpose: 'endpoint',
        request: { url: `${ctx.baseUrl}/api/posts?limit=1`, tag: 'example', label: 'Endpoint check' },
        interpret: (snapshot) => {
          const failure = classifyStatus(snapshot, 'Example Booru');
          if (failure) return { ok: false, kind: failure.kind, message: failure.message, warnings: failure.hint ? [failure.hint] : [] };
          return { ok: true, kind: 'ok', message: 'Listing endpoint responds with JSON' };
        },
      },
      {
        id: 'example-auth',
        label: 'Authenticated request',
        purpose: 'auth',
        enabled: hasCredentials,
        request: { url: `${ctx.baseUrl}/api/profile`, headers: { 'X-API-Key': ctx.server.apiKey }, redirect: 'error', tag: 'example', label: 'Credential check' },
        interpret: (snapshot) => { /* map 401 / 403 / payload → ProbeInterpretation */ },
      },
    ];
  },

  parseSearchResponse(snapshot, spec, ctx) { /* readJson → normalizePost[] → SearchResult */ },
  parsePostResponse(snapshot, postId, ctx) { /* readJson → normalizePost */ },
  normalizePost(raw, ctx) { /* → BooruPost, every field explicit */ },
  normalizeRating(raw) { /* site token → Rating | 'unknown' */ },
  siteRatingTokens: ['safe', 'questionable', 'explicit'],
  canonicalRatingFor(token) { /* → Rating | null */ },
  ratingQueryTags(allowed) { const { tags, warnings } = ratingExclusions(this, allowed); return { tags, warnings }; },

  credentialFields() {
    return [{ key: 'apiKey', label: 'API key', type: 'password', required: false, requiredForAuth: true, secret: true }];
  },

  suggestUserAgent(ctx) {
    return `BooruServerManager/0.2.0 (by ${ctx.server.username || 'anonymous'} on example.invalid)`;
  },
};
```

Then import it and add `registerAdapter(exampleAdapter)` to
`registerBuiltinAdapters()` in `src/adapters/index.ts`; do not replace the
existing registration list. Review `src/manifest.json` and any required
site-specific policies or UI behavior as well.

Run `npm test` — the conformance suite picks the new adapter up automatically, and
the server editor renders its credential fields with no UI change.

## 4. Validation probes

Validation is a *pipeline*, not a single request:

1. **Preflight (no network)** — adapter registered? base URL parseable?
   credential pair complete (`apiKey` + `userId` for query-with-userid, etc.)?
   Produces `unsupported-site` / `incomplete-config`.
2. **Endpoint probe(s)** — proves the host speaks the expected API. An HTML body,
   a 404 or an unrelated JSON shape is an **endpoint mismatch**, never a credential
   error. Reads must work without credentials where the site allows it.
3. **Auth probe(s)** — only when credentials are stored, only `purpose: 'auth'`.
   `401`, or a site-specific “invalid API key / unknown user” payload, is
   `auth-failure`; `403` is `blocked` (UA policy, disabled API access, Cloudflare);
   `429`/`500`-style responses are `rate-limited`/`server-error`.
4. **Interpretation** — `interpret(snapshot)` returns
   `{ ok, kind, message, warnings?, account? }`, so the message the user sees is
   written by the adapter that knows the site.
5. **Result** — `ValidationResult { ok, kind, endpointOk, authOk, message,
   warnings, account, checkedAt, httpStatus, durationMs, trace }` is stored on the
   profile (`valid` / `invalid` / `unreachable` / `partial`) and displayed in the
   diagnostics tab.

Use `optional: true` for probe endpoints that only exist on some instances
(a 404/405 then means “not available here”, and validation moves to the next
candidate). The e621 adapter demonstrates this: it probes `/dmail.json` first and
falls back to `/favorites.json`.

`ValidationService` is the only caller; adapters never decide *when* to validate.

## 5. Failure taxonomy

`FailureKind` (`src/shared/types.ts`) is shared by the HTTP layer, adapters,
validation, the queue and the UI:

| Kind | Meaning | Typical cause |
| --- | --- | --- |
| `auth-failure` | Credentials rejected | Wrong/expired key, key for another account |
| `endpoint-mismatch` | Reached something that is not this API | Base URL wrong, HTML page returned, fork with a different API |
| `blocked` | Request denied without being an auth error | Missing/blocked User-Agent, disabled API access, Cloudflare |
| `rate-limited` | Throttled | 429, e621 503 burst limit |
| `server-error` | 5xx that is not throttling | Site outage |
| `network-failure` | No usable response | Offline, DNS, TLS, timeout |
| `unsupported-site` | No adapter for the configured site type | Typo in a profile, unregistered fork |
| `incomplete-config` | Missing fields / policy refusal | Gelbooru without user id, rating enforcement |
| `parse-failure` | Response was not the documented shape | Fork drifted from the documented JSON |

Adapters should implement `classifyFailure(snapshot)` only for *extra*
site-specific phrasing (for example Gelbooru returning a credential error with
HTTP 200); generic HTTP mapping is available through `classifyStatus()` and
`detectAuthWordsInBody()` from `base.ts`.

## 6. Ratings

Canonical ratings: `safe`, `general`, `sensitive`, `questionable`, `explicit`,
plus `unknown` for anything a site reports that we do not recognise.

- `normalizeRating(raw)` maps a site token to a canonical rating (`unknown` if the
  site invents a new one — never throw).
- `canonicalRatingFor(token)` is the inverse for the site's own token table.
- `ratingQueryTags(allowed)` returns the **exclusion form** (`-rating:explicit`),
  which all three target sites understand and which stays correct when a site's
  OR-syntax differs. Emit a warning when a site cannot express a filter exactly.

The allow-list lives on the profile (`ServerConfig.allowedRatings`); the shared
layer decides *whether* to filter, the adapter decides *how*.

## 7. User-Agent

- `capabilities.requiresUserAgent` marks policies that mandate a descriptive UA.
- `suggestUserAgent(ctx)` builds `BooruServerManager/<version> (by <account> on
  <host>)` from *non-secret* context (`username`, `userId`, `baseUrl`) — never from
  an API key.
- `decorateRequest(ctx, spec)` is for browser limitations: e621 documents
  `_client=<ua>` for clients that cannot set the header, which the extension uses as
  a fallback beside `declarativeNetRequest` rewriting.

## 8. Gelbooru-family forks

`src/adapters/gelbooru.ts` exports `createGelbooruLikeAdapter({ siteType,
displayName, baseUrl, hostPatterns, apiDocsUrl, notes? })` for DAPI-compatible
instances. Register it the same way as a first-class adapter; it inherits
Gelbooru's query-with-userid auth, `@attributes` envelope parsing and credential
error detection.

## 9. Checklist for a new adapter

- [ ] Capabilities match the site's documented limits (rate, page size, pagination).
- [ ] `matchRoute` handles post, tag/search and index URLs, and returns `null` for
      anything else (including look-alike hosts).
- [ ] `parseSearchResponse` / `parsePostResponse` never throw on unexpected fields;
      they degrade to `null`/`unknown` and rely on `shapeError()` only when the
      response cannot be the documented shape at all.
- [ ] `normalizePost` fills **every** `BooruPost` field, using the canonical rating.
- [ ] At least one endpoint probe and one auth probe, with `enabled` flags.
- [ ] `credentialFields` marks secrets and explains what is required when.
- [ ] No credential is embedded in post, file or thumbnail URLs exposed to UI,
      queue/history or Chrome Downloads; review redirects, header persistence and
      errors too. Hydrus now uses headers and key-free URLs, but Chrome Downloads
      header/redirect behavior and real-client compatibility still need testing.
- [ ] Downloads select only the original and reject known reduced renditions.
- [ ] `suggestUserAgent` never returns a browser-looking string.
- [ ] Tests: response fixtures for happy path, empty result, HTML body, 401, 429,
      malformed JSON, plus the conformance suite.
- [ ] `docs/ARCHITECTURE.md` supported-site notes and README table updated.
