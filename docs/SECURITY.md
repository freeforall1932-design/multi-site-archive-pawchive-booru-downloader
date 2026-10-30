# Security & privacy notes

This extension handles booru API keys. This document is the contract for how those
keys are stored, transmitted, displayed, logged and removed. The short version:
**keys live in `chrome.storage.local`, are sent only to the host you configured
them for, are never rendered or logged in the clear, and can be deleted per
profile at any time.**

## 1. Where credentials are stored

| Data | Location | Notes |
| --- | --- | --- |
| API keys, usernames, user ids, custom User-Agents | `chrome.storage.local` → key `bsm.servers`, inside the `ServerConfig` records | Never `chrome.storage.sync`, so keys are not uploaded to a Google account and do not travel between devices |
| Settings (templates, toggles, intervals) | `chrome.storage.local` → `bsm.settings` | No secrets here |
| Queue state | `chrome.storage.local` → `bsm.queue` | Post ids and statuses; link rows also retain complete external URLs, potentially including share keys |
| Collected links and task membership | `chrome.storage.local` → `bsm.links`, `bsm.tasks` | Link URLs can contain bearer tokens or decryption keys, including Mega fragments |
| Schema/meta (version, first run) | `chrome.storage.local` → `bsm.meta` | No secrets |

`chrome.storage.local` is readable by this extension only (not by web pages), and
is protected by the browser profile — anyone who can read your browser profile
files can read the keys. Treat a machine with a shared or compromised browser
profile as unsuitable for storing API keys.

Keys are held in service-worker memory only for the duration of a request and are
never written to disk anywhere else (no IndexedDB, no cache, no remote service).

## 2. Where credentials are transmitted

Only to the host of the server profile that owns them, and only over HTTPS:

- `https://<baseUrl>/...` requests issued by the service worker (or, in the
  preview harness, by the mock booru in the page — no real traffic).
- Authentication style is the one the site documents:
  e621/Danbooru use `Authorization: Basic base64(username:apiKey)` (or
  `login`/`api_key` query parameters), Gelbooru uses `api_key` + `user_id`
  query parameters.
- Plain-HTTP base URLs validate with a warning; nothing prevents you from using
  one, but credentials would then travel unencrypted. Prefer the documented
  HTTPS URLs.

There is **no remote backend**: the extension never sends data to any server other
than the booru hosts you configure, and it contains no telemetry, analytics or
update pings.

## 3. What the UI may show

- All servers cross into the UI as `ServerConfigView`, which has **no `apiKey`
  field** — only `apiKeyMask` (e.g. `••••••••4f2a`, last four characters) and the
  boolean `hasApiKey`.
- Password fields keep their value only in the editor's local draft state while you
  are typing. Saving with a blank key keeps the stored key (masked edit semantics).
- Diagnostics show *booleans and statuses*, never key material, and the copied
  report contains no secrets.
- Export excludes secrets by default. `Export with secrets` requires an explicit
  checkbox and carries a warning in the UI, because the resulting file is a plain
  JSON file outside the extension's control.

## 4. Logging and diagnostics rules

These are hard rules for the codebase (any change that breaks them is a bug):

1. No credential value is ever passed to `console.*`. Errors are surfaced as
   `BooruError` messages that are built from redacted URLs.
2. `HttpClient` snapshots and events are redacted at the source:
   `redactUrl()` replaces the values of `api_key`, `apikey`, `key`, `login`,
   `password`, `password_hash`, `token`, `access_token`, `user_id` and `_client`
   with `***`, masks Pawchive signed `s` values and URL fragments, and strips any
   `user:password@` userinfo. `redactHeaders()` masks
   `Authorization`, `Cookie`, `X-API-Key`.
3. Validation results carry a redacted `trace` (`ProbeTraceEntry`) with the
   redacted request URL, status, duration and interpretation — that trace is what
   the diagnostics tab shows and what is persisted on the profile.
4. The queue records post ids, filenames and error kinds; error text comes from
   the adapter and never includes credentials.

## 5. Permissions and why they are needed

| Permission | Reason |
| --- | --- |
| `storage` | Persist server profiles, settings and the queue |
| `downloads` | Save post files through the browser's download manager |
| `declarativeNetRequest` | Rewrite the `User-Agent` header for API requests to saved hosts (e621/Danbooru policies require a descriptive, non-browser UA, which `fetch` cannot set) |
| `activeTab` | The popup reads the current tab's URL to detect the site/post |
| Host permissions (`e621.net`, `e926.net`, `*.e621.net`, `*.donmai.us`, `danbooru.donmai.us`, `gelbooru.com`, `www.gelbooru.com`, `*.gelbooru.com`) | Talk to the documented APIs of the supported sites |
| `optional_host_permissions: https://*/*` | Only requested when you add a custom/fork instance; requested on demand via `chrome.permissions.request` and revocable from `chrome://extensions` |

User-Agent rewriting rules are scoped to `resourceTypes: ['xmlhttprequest']` and
to the exact hosts of your saved servers. They are rebuilt from the saved profiles
on every settings/server change, and removed entirely when
*Settings → User-Agent rewriting* is switched off.

The content script only runs on post pages (`/posts/*` on e621/e926/donmai,
`index.php*` on Gelbooru) and only sends the page URL to the service worker when
you click its button. It renders inside a shadow root, so it cannot read or alter
the page's own DOM script state.

## 6. Removing stored credentials

| Goal | How |
| --- | --- |
| Remove one profile's keys, keep the profile | *Servers → Edit → Clear credentials* (or the same action from the list) |
| Remove a profile entirely | *Servers → Delete* (the profile, including its keys, is deleted from storage) |
| Remove everything | Uninstall the extension, or clear extension data in `chrome://extensions` → *Details → Site access / Clear data*; you can also delete the `bsm.*` keys from the extension's `chrome.storage.local` in a DevTools console |
| Remove a granted host permission | `chrome://extensions` → *Details → Site access* |
| Clear the preview harness | The harness page's **Reset preview data** button deletes the `bsm-preview:*` `localStorage` keys |

## 7. Threat model and known limitations

- **Trusted browser profile required.** Anything running with access to your
  profile (another extension with broad permissions, a person with your unlocked
  computer) can read `chrome.storage.local`. Use scoped keys where the site offers
  them, and delete profiles you no longer use.
- **Keys are bearer credentials.** A leaked key grants the account's API access but
  not your password. Revoke it on the site first if you suspect exposure.
- **No secret-sync.** Because storage is local-only, a fresh profile/device has no
  servers; use *Export* (without secrets) for layout and re-enter keys manually.
- **`declarativeNetRequest` rules are visible** to the browser as dynamic rules and
  echo the configured User-Agent strings. Those strings identify the account you
  configured, which is exactly what e621/Danbooru policy asks for; keep API keys out
  of the User-Agent field.
- **Exported files are outside our control.** A server export including credentials
  is plaintext. Collected-link text and task exports intentionally preserve full
  URLs, including Mega decryption keys and other bearer tokens, even when server
  credentials are excluded; share and store those packages carefully.
- **The preview harness is development-only.** It uses demo credentials and
  `localStorage`; never put real keys into it.
- **Site terms still apply.** The extension enforces documented request rates and a
  descriptive User-Agent, but you are responsible for how you use the content you
  download.

## 8. Reporting a problem

If you find a path where a key can leak into logs, the rendered UI, an export or a
diagnostics payload, treat it as a security bug: fix it at the source (redaction
helpers in `src/shared/util.ts` and the response shaping in `src/core/router.ts`)
and add a regression test alongside the existing masking tests in
`tests/core/router.test.ts` and `tests/core/http.test.ts`.

## Side panel

The panel is a full UI surface but no new trust: it is an extension page with the
same origin as the options page, so it uses the same message-only channel to the
worker as every other surface.

- It contains no credentials - server rows arrive already masked (`apiKeyMask`,
  `hasApiKey`) and export/import flows to the options page, which owns the reveal
  and export controls.
- It performs no network I/O: fetches go through `browse/search` (which applies the
  rating allow-list and the booru tag blacklist in the router (Pawchive has neither)) and downloads through the
  queue.
- The download notebook (`bsm.history`) stores labels, ids, filenames, byte counts
  and timestamps - never URLs with credentials, never API keys. `Reset download
  history` removes it without touching files on disk.
- `chrome.sidePanel.open` is only callable from a user gesture; the panel falls
  back to opening the options page when the API refuses, so a mis-configured
  profile can never dead-end the user.
- Post thumbnails are drawn from the sites' own preview URLs (no third-party
  host); *Settings → Interface → Post thumbnails* switches them off.
