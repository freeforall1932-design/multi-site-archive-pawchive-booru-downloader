# Security & privacy notes

This extension stores API credentials and may collect private share URLs. It has
no application backend or analytics, but it does contact the configured sites,
remote thumbnail hosts and any file hosts you explicitly download from. Use a
trusted browser profile and review the limitations below before handling secrets.

## Important: Hydrus authentication and remaining risks

New Hydrus post, original-file and thumbnail URLs are constructed **without** an
access key. Authenticated metadata, validation and thumbnail requests use the
`Hydrus-Client-API-Access-Key` header and reject redirects. A thumbnail request
accepts only a saved profile ID and numeric file ID, not an arbitrary URL; the
worker caps its image response. These paths have offline tests but have **not**
been verified against a live Hydrus client or an installed MV3 extension.

Original downloads pass the key as a transient custom header to
`chrome.downloads.download` only after checking the exact configured file endpoint
and file ID. **Chrome Downloads' treatment of custom headers on redirects and in
browser storage has not been verified.** A local ordinary-page fetch experiment
showed a custom header can be forwarded to another origin when redirects are
followed; it did not test Chrome Downloads. Use a trusted direct endpoint that does
not redirect, avoid untrusted proxies, and use a narrowly restricted key. Do not
assume the browser never retains the header. See [WORKLIST.md](WORKLIST.md) and
[MANUAL_TESTS.md](MANUAL_TESTS.md) for the pending real-browser checks.

Older versions placed the key in URLs. On worker startup/reading, known Hydrus
key parameters are removed from non-link queue post URLs and download-history
post URLs. Mirror-link URLs are intentionally left intact. This migration does
not clean Chrome Downloads, browsing history, exports, logs, backups, or arbitrary
other stored text. Revoke/rotate any previously exposed key and manually inspect
and remove old browser download/history records and exports as appropriate.

## 1. Data at rest

| Data | Location | Notes |
| --- | --- | --- |
| Server API keys, usernames, user IDs, custom User-Agents | `chrome.storage.local` → `bsm.servers` | Not `chrome.storage.sync`; profiles are not encrypted by the extension. |
| Settings | `bsm.settings` | Templates and other user-entered values can themselves be sensitive. |
| Queue and download history | `bsm.queue`, `bsm.history` | Include post URLs; link rows retain full off-site URLs. Legacy Hydrus key parameters in post URLs are migrated on read, not in external records or exports. |
| Search history | `bsm.searches` | Stores searches, which may reveal user interests or private data. |
| Collected links and tasks | `bsm.links`, `bsm.tasks` | Link URLs and exports may contain bearer tokens or Mega decryption fragments. |

Browser extensions cannot normally read another extension's storage, but anyone
with access to the browser profile files or a compromised profile may recover
these values. Internal worker memory and caches may hold raw credentials and API
responses while needed; no fixed in-memory retention time is guaranteed.

New server URLs containing `user:password@` are rejected. Legacy profiles with
embedded URL credentials remain stored for recovery/export, but are not usable
for requests or as defaults until edited. Server views and default server exports
redact those embedded credentials; the explicit secret-inclusive export preserves
them. Deleting keys from credential fields does not automatically scrub old
URLs, queue/history rows, share URLs or browser history.

## 2. Network and permissions

- API requests use the configured server and site-specific authentication.
  Some sites put credentials in query parameters; configured HTTP endpoints
  transmit them without TLS. Redirects, proxies, the remote server and browser
  histories are outside the extension's confidentiality guarantee.
- Built-in `host_permissions` cover the listed booru and Pawchive HTTPS hosts.
  Custom HTTPS access can be requested through `optional_host_permissions:
  https://*/*`. The manifest also permits optional `http://127.0.0.1/*` and
  `http://localhost/*` for local clients such as Hydrus; it does **not** grant
  arbitrary non-loopback HTTP host permissions. Plain HTTP validation warns about
  exposure and may also fail for lack of an allowed permission.
- Chrome performs requested file downloads, including off-site direct links.
  The extension does not resolve provider share pages or verify file contents.
- UI `<img>` elements for non-Hydrus sites can request preview URLs supplied by
  sites, including CDN or other hosts. Hydrus thumbnails use an authenticated
  worker fetch and an in-memory image cache. Disabling queue thumbnails reduces
  some requests but is not a universal thumbnail-off switch for every surface.
- `storage`, `downloads`, `declarativeNetRequest`, `activeTab` and `sidePanel`
  support local state, browser transfers, User-Agent rules, active-page detection
  and the panel. Review the actual host patterns in `src/manifest.json`.

## 3. Views, exports and diagnostics

- Server profile views omit `apiKey`, exposing a mask and `hasApiKey` instead.
  The editor holds typed credentials in its draft state. Generated Hydrus URLs
  no longer include the access key, but full mirror-link URLs and other returned
  site data can contain secrets and are **not** guaranteed credential-free.
- Server exports omit API keys and redact embedded URL credentials by default.
  The explicitly opted-in secret-inclusive export is plaintext. Collected-link
  and task exports intentionally retain complete share URLs and their fragments;
  only share them with people you trust.
- `redactUrl()` masks known sensitive query parameter names case-insensitively,
  URL userinfo, Pawchive signed `s` values and fragments. Unknown credential names
  or secrets outside URL-shaped text can still escape generic redaction. The
  validation trace uses redacted request URLs; diagnostic server URLs are also
  redacted. Review reports before sharing.
- `HttpClient` emits redacted diagnostic events and supplies `redactedUrl`, but
  its internal `HttpResponseSnapshot.url`, response headers and body are **raw**.
  They are not safe to render, log or persist without appropriate sanitization.
  `redactHeaders()` is available for request descriptions. Adapter errors and
  user-generated labels also require care; do not assume arbitrary text is safe.

## 4. User-Agent rules and page scripts

Dynamic `declarativeNetRequest` rules rewrite `User-Agent` for
`xmlhttprequest` requests to configured `requestDomains`. Chrome's domain match
includes subdomains; the current rules do **not** restrict the request initiator,
so matching requests outside the extension may be affected as well. Disable
*User-Agent rewriting* if that scope is unacceptable. Restricting initiators
without breaking extension fetches is an open item requiring real-browser tests.
The configured User-Agent appears in the browser's dynamic rules: never put API
keys in that field.

The manifest injects the content script on its listed post URL patterns. It reads
the page URL and communicates with the worker during detection and on button
clicks. Shadow DOM isolates styling; it is not a security boundary and does not
prevent a content script from accessing page DOM.

## 5. Removing data and using preview safely

- Clear a profile's credential fields or delete the profile; revoke the key at the
  service if exposure is suspected. Also inspect/clear queue, download history,
  saved exports and browser history where credential-bearing URLs could remain.
- Remove site permissions in the browser's extension settings and uninstall or
  clear extension data if you want to remove local extension storage.
- The offline preview uses in-page mocks and `localStorage`. Use demo credentials
  only. Clicking an external link can still open a real site.
- `npm run preview` listens on `0.0.0.0` without authentication and serves the
  built extension, harness and mock media. It does not serve arbitrary repository
  files, but should still be run only on a trusted network and stopped when done.

## 6. Reporting a problem

Treat any unexpected secret in a UI response, log, error, export or diagnostics
payload as a security defect. Include a minimal reproduction with fake credentials;
never publish real keys, signed URLs or private share links. Add regression tests
near the relevant router, adapter, HTTP or storage code and document any residual
risk rather than assuming redaction is complete.
