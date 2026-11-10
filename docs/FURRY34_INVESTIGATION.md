# Furry34 investigation

## Status

**Furry34 is not currently supported by the extension.** It is a separate
booru-like site, not another Pawchive creator archive. The retained Gelbooru
`rule34` profile is for rule34.xxx, not furry34.com.

The site exposes a distinct interface, but the observed responses do not
establish that its unsuffixed image or video renditions are the exact uploaded
originals. The user chose to keep the original-only rule: do not enable Furry34
downloads until an actual original can be identified reliably, and do not treat
these renditions as verified originals. There is no Furry34 adapter, host
registration, on-page button or download support in the current build.

## Observed interfaces and evidence

- Public post pages use `/post/{id}`. Anonymous `GET
  /api/v2/post/{id}` returned JSON for sampled [image](https://furry34.com/api/v2/post/541946)
  and [video](https://furry34.com/api/v2/post/605309) posts. The response includes
  an id, type, dimensions, tags, a `files` map and sometimes source links. The
  sampled responses did not include an original filename or an original-file
  checksum. Successful anonymous lookup of these examples does not establish
  access to deleted, restricted, premium or other posts.
- The site's [app configuration](https://furry34.com/app.json) lists storage id
  `0` as the site and id `2` as the `furry34com` CDN. The sampled `files` entries
  contained arrays such as `[2]`; these appear to correspond to storage
  identifiers, not a documented promise about image or video quality.
- The independent [gallery-dl Furry34 extractor](https://github.com/mikf/gallery-dl/blob/811d917b4973ae4f556a760e289784fd4714e2f1/gallery_dl/extractor/furry34.py)
  interprets format `10` as an unsuffixed `pic.jpg` image and `100` as
  `mov.mp4`. It also lists other video renditions. The separate
  [rule34.world/xyz implementation](https://github.com/freeforall1932-design/rule34video/blob/47513fb13adf4e22eb91082bde5ce0b10a6a283a/extension/background-enhanced.js)
  in the owner's other project identifies formats `101`/`102` as previews for
  that related engine, whereas gallery-dl's Furry34 mapping names them 720p and
  480p. Do not assume those fallback formats are originals, or assume the
  sister site's exact format semantics apply to Furry34.
- For example, [post 541946](https://furry34.com/api/v2/post/541946) lists a
  `.png` source and advertises format `10`, which the extractor maps to JPEG.
  A source link is not proof of which bytes were uploaded, but the mismatch
  demonstrates why an unsuffixed JPEG cannot be assumed to preserve the source
  file. Likewise, the MP4 rendition may have been transcoded. Dimensions in
  metadata alone do not prove byte identity or rule out quality loss.
- The site lists source links where available. Those URLs can refer to external
  pages or files, can be missing or stale, and are not an original-file identity
  guarantee. Automatically substituting one would not satisfy the policy.
- Direct CDN requests through the research page-fetching tool produced a 403
  page for sampled media. A site-origin URL returned no parseable page content.
  This is not a browser-extension download test and does not establish whether
  either media host will work for a user in Chrome; no media bytes, MIME type,
  dimensions or hashes were verified.

## Search and pagination

The gallery-dl extractor describes a `POST /api/v2/post/search/root` request
with tag filters, `take`, sort order and a continuation cursor, returning `items`
and a cursor. It describes playlist searches separately. **These POST requests,
pagination, rate limits and authentication have not been live-tested here.**
They should not be inferred as proven from individual GET requests or from a
related site's implementation.

A real adapter needs cursor-aware integration, not just a new site name:
current panel page-range requests use numeric pages and `SearchResult` has no
continuation-cursor field. Deep page ranges would need a bounded sequential
cursor walk (or another verified site-supported approach), correct end-of-feed
handling, cancellation and a clear error for unsupported jumps. Search tag
semantics, blacklisting, rating capabilities and result shape also need tests.
The current adapter conformance test assumes search requests use GET and put
tags in the URL; a POST-based adapter requires updating that test to validate
its JSON body instead of weakening request checks.

## Terms and next steps

[Furry34's terms](https://furry34.com/terms) say access is permitted solely via
its website interface and restrict downloading content not permitted by the
terms. Third-party automated access or downloading may conflict with those
terms; review the site's permissions before use. Nothing in this investigation
establishes authorization to access restricted content or bypass a control.

Before claiming original-only support:

1. Obtain authoritative format documentation or otherwise establish how the
   site exposes the uploaded original for images and video, including formats,
   storage ids and missing/processed originals. Fail closed when unavailable;
   never fall back to a sample, thumbnail or reduced/transcoded version.
2. Validate anonymous and permitted authenticated post/search requests,
   cursor pagination, host permissions and rate limits. Implement a dedicated
   adapter and explicit route/manifest support; do not relabel an existing
   Gelbooru profile.
3. Test representative permitted image/video examples in an installed MV3
   extension, including the CDN/origin response, Chrome download completion,
   missing originals and access failures. Compare actual content and hashes
   where an authoritative original is available. Offline fixtures alone are
   not live verification.

The gallery-dl source is GPL-licensed; it is evidence of a protocol, not code
vendored into this repository. Review licenses before reusing implementation
text from any external project.
