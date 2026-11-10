/**
 * Mirror-link rules: which off-site links count as downloads, and how a set of
 * collected links is exported to / imported from a plain `.txt` file.
 *
 * This is the extension's answer to a userscript such as *Pawchive Link
 * Collector*: Pawchive posts can link
 * downloads on Google Drive, Mega, MediaFire and friends, addressable only as
 * URLs inside the post body. Those URLs are not booru posts, so nothing in the
 * adapter contract can describe them - but they are still work the queue can do.
 *
 * Everything here is **pure** and environment-free: no DOM, no `fetch`, no
 * storage. The service worker has no `DOMParser`, so the HTML scan is done with
 * a small tag/entity-aware parser instead of one.
 *
 * Format/provider filtering mirrors the userscript's toggles:
 *   - `downloads` (default) keeps a link when its host is a known provider *or*
 *     the URL looks like a file (extension, `?download=`, `/download/…`);
 *   - `any` keeps every external link, which is what a loosely formatted post
 *     needs when the provider is unknown.
 * Links on the site's own host are always skipped - the extension already
 * downloads those as attachment rows.
 */
import { isPawchiveHost } from '../adapters/pawchive.js';
import type { MirrorLink, MirrorLinkFilter, MirrorLinkSection, ServerConfig } from '../shared/types.js';
import { isRecord, safeUrl, uniqueBy } from '../shared/util.js';

/** Providers that serve files, with the label the UI shows for them. */
export const MIRROR_PROVIDERS: ReadonlyArray<{ host: string; label: string }> = [
  { host: 'drive.google.com', label: 'Google Drive' },
  { host: 'docs.google.com', label: 'Google Docs' },
  { host: 'mega.nz', label: 'Mega' },
  { host: 'mega.co.nz', label: 'Mega' },
  { host: 'drive.proton.me', label: 'Proton Drive' },
  { host: 'mediafire.com', label: 'MediaFire' },
  { host: 'dropbox.com', label: 'Dropbox' },
  { host: 'pixeldrain.com', label: 'Pixeldrain' },
  { host: 'gofile.io', label: 'GoFile' },
  { host: 'workupload.com', label: 'WorkUpload' },
  { host: 'catbox.moe', label: 'Catbox' },
  { host: 'krakenfiles.com', label: 'KrakenFiles' },
  { host: '1fichier.com', label: '1fichier' },
  { host: 'pcloud.com', label: 'pCloud' },
  { host: 'mypikpak.com', label: 'PikPak' },
  { host: 'terabox.com', label: 'TeraBox' },
  { host: 'mixdrop.co', label: 'MixDrop' },
  { host: 'rapidgator.net', label: 'RapidGator' },
  { host: 'wetransfer.com', label: 'WeTransfer' },
  { host: '4shared.com', label: '4shared' },
  { host: 'sendspace.com', label: 'SendSpace' },
  { host: '1drv.ms', label: 'OneDrive' },
  { host: 'onedrive.live.com', label: 'OneDrive' },
  { host: 'disk.yandex.com', label: 'Yandex Disk' },
  { host: 'cyberdrop.me', label: 'CyberDrop' },
  { host: 'cyberdrop.to', label: 'CyberDrop' },
  { host: 'bunkr.si', label: 'Bunkr' },
  { host: 'bunkr.ci', label: 'Bunkr' },
  { host: 'gdriveplayer.co', label: 'GDrive Player' },
];

/** File extensions a download link commonly ends with (the userscript's list). */
export const MIRROR_FILE_EXTENSIONS: readonly string[] = [
  'zip', 'rar', '7z', '7zip', 'tar', 'gz', 'bz2', 'xz', 'zst',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'tif', 'tiff', 'psd', 'clip', 'sai', 'kra', 'procreate',
  'pdf', 'epub', 'mobi', 'cbz', 'cbr', 'txt', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'mp4', 'mkv', 'webm', 'mov', 'avi', 'm4v', 'wmv', 'flv', 'mp3', 'wav', 'flac', 'm4a', 'ogg', 'aac',
  'blend', 'blend1', 'obj', 'fbx', 'stl', 'dae', '3ds', 'gltf', 'glb', 'usdz',
  'unitypackage', 'uasset', 'spp', 'psb', 'abr', 'aseprite', 'ase',
  'apk', 'exe', 'msi', 'iso', 'img', 'dmg', 'pkg', 'deb', 'rpm',
];

const EXTENSION_RE = new RegExp(`\\.(${MIRROR_FILE_EXTENSIONS.join('|')})(?:$|[?#])`, 'i');
const DOWNLOAD_QUERY_RE = /[?&](?:download|attachment|file|filename|dl)=/i;
const DOWNLOAD_PATH_RE = /(?:\/download(?:\/|$)|\/attachments?(?:\/|$)|\/file(?:\/|$))/i;
const HASHED_FILE_RE = /\/[a-f0-9]{16,}(?:\.[a-z0-9]{1,5})?$/i;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;
const URL_IN_TEXT_RE = /https?:\/\/[^\s<>"'`)\]}\]]+/gi;
const TAG_RE = /<[^>]*>/g;

/** HTML entities that appear inside href attributes often enough to matter. */
const ENTITIES: ReadonlyArray<[RegExp, string]> = [
  [/&amp;/g, '&'],
  [/&#0?38;/g, '&'],
  [/&quot;/g, '"'],
  [/&#0?39;|&apos;/g, "'"],
  [/&lt;/g, '<'],
  [/&gt;/g, '>'],
  [/&nbsp;/g, ' '],
];

export function decodeEntities(value: string): string {
  let out = value;
  for (const [pattern, replacement] of ENTITIES) out = out.replace(pattern, replacement);
  return out;
}

/** Strip tags and decode entities, so text URLs survive an HTML payload. */
export function stripHtml(html: string): string {
  return decodeEntities(html.replace(TAG_RE, ' ')).replace(/\s+/g, ' ').trim();
}

/** Normalise a raw URL match: drop trailing punctuation and parse it. */
export function normalizeLinkUrl(raw: string, baseUrl?: string | null): string | null {
  const cleaned = decodeEntities(raw.trim()).replace(TRAILING_PUNCTUATION, '');
  if (!cleaned) return null;
  try {
    const url = new URL(cleaned, baseUrl ?? undefined);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname) return null;
    // Fragments can carry decryption keys (Mega, Proton and others). They are
    // part of the share link even though browsers do not send them in HTTP.
    return url.toString();
  } catch {
    return null;
  }
}

/** Match both modern and historical Mega share-link hosts. */
function isMegaHost(host: string): boolean {
  const name = host.toLowerCase();
  return name === 'mega.nz' || name.endsWith('.mega.nz') || name === 'mega.co.nz' || name.endsWith('.mega.co.nz');
}

/**
 * Only a modern, single-file/folder Mega URL has an unambiguous old keyless
 * identity. Old `/#...` shares lost the ID as well as the key, and folder
 * sub-selections may have collapsed together, so neither can be auto-matched.
 */
export function legacyMegaKeylessUrl(raw: string): string | null {
  const url = safeUrl(raw);
  if (!url || !isMegaHost(url.hostname) || !url.hash || url.hash.includes('/')) return null;
  if (!/^\/(?:file|folder)\/[^/]+\/?$/i.test(url.pathname)) return null;
  url.hash = '';
  return url.toString();
}

/**
 * Known share pages do not return raw files through a plain browser download.
 * Keep them for opening/exporting, but don't save HTML as a successful file.
 * Other hosts may also show interstitials, which cannot be detected here.
 */
export function manualMirrorProvider(raw: string): string | null {
  const url = safeUrl(raw);
  if (!url) return null;
  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();
  if (isMegaHost(host)) return 'Mega';
  if (host === 'drive.google.com' || host === 'docs.google.com') return 'Google Drive';
  if (host === 'drive.proton.me' || host === 'protondrive.com') return 'Proton Drive';
  if ((host === 'mediafire.com' || host === 'www.mediafire.com') && /^\/(?:file|folder)\//.test(path)) return 'MediaFire';
  if ((host === 'gofile.io' || host === 'www.gofile.io') && /^\/(?:d|folder)\//.test(path)) return 'GoFile';
  if ((host === 'pixeldrain.com' || host === 'www.pixeldrain.com') && /^\/(?:u|l)\//.test(path)) return 'Pixeldrain';
  if ((host === 'dropbox.com' || host === 'www.dropbox.com') && /^\/(?:s|scl|sh)\//.test(path)) return 'Dropbox';
  return null;
}

/** Hosts that belong to the profile itself (site host plus its subdomains). */
export function ownHostsOf(server: Pick<ServerConfig, 'baseUrl'> | null | undefined): string[] {
  if (!server) return [];
  const url = safeUrl(server.baseUrl);
  if (!url) return [];
  // Both official domains and their CDNs are Pawchive's own storage, even
  // when a post mentions the other domain from the selected profile.
  if (isPawchiveHost(url.hostname, true)) return ['pawchive.pw', 'pawchive.st'];
  return [url.hostname.toLowerCase()];
}

export function isOwnHost(host: string, ownHosts: readonly string[]): boolean {
  const normalized = host.toLowerCase();
  return ownHosts.some((own) => normalized === own || normalized.endsWith(`.${own}`));
}

function providerFor(host: string, extraHosts: readonly string[]): string | null {
  const normalized = host.toLowerCase();
  for (const provider of MIRROR_PROVIDERS) {
    if (normalized === provider.host || normalized.endsWith(`.${provider.host}`)) return provider.label;
  }
  for (const extra of extraHosts) {
    const host0 = extra.toLowerCase().replace(/^www\./, '');
    if (normalized === host0 || normalized.endsWith(`.${host0}`)) return host0;
  }
  return null;
}

export interface MirrorLinkRules {
  /** `downloads` (default) or `any` - see the module comment. */
  filter?: MirrorLinkFilter;
  /** Extra provider hosts from the settings. */
  extraHosts?: readonly string[];
  /** Hosts to skip (the profile's own site). */
  ownHosts?: readonly string[];
}

/** Why a link was kept - shown in the UI so the rule is never a black box. */
export type LinkReason = 'provider' | 'extension' | 'download-path' | 'external';

export interface MirrorLinkCandidate {
  url: string;
  host: string;
  provider: string;
  reason: LinkReason;
}

/**
 * Decide whether one URL is a mirror download link.
 * Returns `null` (with a reason the caller can log) instead of a boolean so the
 * UI can explain the filter in one place.
 */
export function classifyMirrorLink(
  rawUrl: string,
  rules: MirrorLinkRules = {},
): (MirrorLinkCandidate & { ok: true }) | { ok: false; reason: 'invalid' | 'own-host' | 'filtered' } {
  const url = normalizeLinkUrl(rawUrl);
  if (!url) return { ok: false, reason: 'invalid' };
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase();
  const filter: MirrorLinkFilter = rules.filter ?? 'downloads';
  if (isOwnHost(host, rules.ownHosts ?? [])) return { ok: false, reason: 'own-host' };

  const provider = providerFor(host, rules.extraHosts ?? []);
  const target = `${parsed.pathname}${parsed.search}`;

  if (provider) return { ok: true, url, host, provider, reason: 'provider' };
  if (EXTENSION_RE.test(parsed.pathname)) return { ok: true, url, host, provider: host, reason: 'extension' };
  if (DOWNLOAD_QUERY_RE.test(target)) return { ok: true, url, host, provider: host, reason: 'download-path' };
  if (DOWNLOAD_PATH_RE.test(parsed.pathname)) return { ok: true, url, host, provider: host, reason: 'download-path' };
  if (HASHED_FILE_RE.test(parsed.pathname)) return { ok: true, url, host, provider: host, reason: 'extension' };
  if (filter === 'any') return { ok: true, url, host, provider: host, reason: 'external' };
  return { ok: false, reason: 'filtered' };
}

/** True when the URL is a link the Links tab would collect. */
export function looksLikeMirrorLink(rawUrl: string, rules: MirrorLinkRules = {}): boolean {
  return classifyMirrorLink(rawUrl, rules).ok;
}

/**
 * Pull every `href` and every bare URL out of an HTML fragment.
 *
 * The post body of a creator-archive API is HTML with `<a href="…">` links and,
 * often, plain text URLs next to them; both must be seen. Entity decoding and
 * relative resolution happen here so callers only deal with absolute URLs.
 */
export function extractUrlsFromHtml(html: string, baseUrl?: string | null): string[] {
  const found: string[] = [];
  const push = (raw: string): void => {
    const url = normalizeLinkUrl(raw, baseUrl);
    if (url) found.push(url);
  };
  const hrefRe = /href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let match: RegExpExecArray | null;
  while ((match = hrefRe.exec(html)) !== null) {
    const raw = match[1] ?? match[2] ?? match[3];
    if (raw && !raw.startsWith('#')) push(raw);
  }
  for (const raw of stripHtml(html).match(URL_IN_TEXT_RE) ?? []) push(raw);
  return uniqueBy(found, (url) => url);
}

/** Plain text (no tags): just the bare URLs. */
export function extractUrlsFromText(text: string): string[] {
  const found: string[] = [];
  for (const raw of decodeEntities(text).match(URL_IN_TEXT_RE) ?? []) {
    const url = normalizeLinkUrl(raw);
    if (url) found.push(url);
  }
  return uniqueBy(found, (url) => url);
}

/**
 * Walk an API payload and collect every URL in it.
 *
 * Site-agnostic on purpose: the adapter contract stays untouched, and the same
 * scan works for a Pawchive `content` field, an e621 `source`, or any field a fork
 * adds later. Deep payloads are bounded so a pathological response cannot hang
 * the worker.
 */
export function extractUrlsFromPayload(payload: unknown, options: { maxDepth?: number; maxStrings?: number } = {}): string[] {
  const maxDepth = options.maxDepth ?? 12;
  const maxStrings = options.maxStrings ?? 5000;
  const found: string[] = [];
  let scanned = 0;
  const seen = new Set<string>();

  const visit = (value: unknown, depth: number): void => {
    if (depth > maxDepth || scanned > maxStrings) return;
    if (typeof value === 'string') {
      scanned += 1;
      if (!value.includes('http')) return;
      const urls = value.includes('<') ? extractUrlsFromHtml(value) : extractUrlsFromText(value);
      for (const url of urls) {
        if (seen.has(url)) continue;
        seen.add(url);
        found.push(url);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, depth + 1);
      return;
    }
    if (isRecord(value)) {
      for (const entry of Object.values(value)) visit(entry, depth + 1);
    }
  };

  visit(payload, 0);
  return found;
}

/** The provider's share of a URL, for the queue's filename fallback. */
export function fileNameFromUrl(rawUrl: string): string | null {
  const url = safeUrl(rawUrl);
  if (!url) return null;
  const segments = url.pathname.split('/').filter(Boolean);
  const last = segments[segments.length - 1];
  if (!last) return null;
  const decoded = (() => {
    try {
      return decodeURIComponent(last);
    } catch {
      return last;
    }
  })();
  return decoded.replace(/[?#].*$/, '') || null;
}

export function extensionFromUrl(rawUrl: string): string | null {
  const name = fileNameFromUrl(rawUrl);
  const match = name ? /\.([a-z0-9]{1,6})$/i.exec(name) : null;
  return match?.[1]?.toLowerCase() ?? null;
}

/**
 * Stable id for a link, so re-scanning a creator months later updates its row
 * instead of adding a second one. FNV-1a keeps it dependency-free and short.
 */
export function mirrorLinkId(url: string): string {
  let hash = 0x811c9dc5;
  const normalized = url.trim();
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `lnk_${(hash >>> 0).toString(36)}${normalized.length.toString(36)}`;
}

/** Everything the collector knows about the post a link came from. */
export interface LinkContext {
  serverId?: string | null;
  siteType?: string | null;
  postId?: string | null;
  postTitle?: string | null;
  postUrl?: string | null;
  creator?: string | null;
}

/** Build the stored record for one candidate URL. */
export function toMirrorLink(candidate: MirrorLinkCandidate, context: LinkContext, now = new Date()): MirrorLink {
  const timestamp = now.toISOString();
  return {
    id: mirrorLinkId(candidate.url),
    url: candidate.url,
    host: candidate.host,
    provider: candidate.provider,
    serverId: context.serverId ?? null,
    siteType: context.siteType ?? null,
    postId: context.postId ?? null,
    postTitle: context.postTitle ?? null,
    postUrl: context.postUrl ?? null,
    creator: context.creator ?? null,
    addedAt: timestamp,
    status: 'new',
    attempts: 0,
    error: null,
    filename: null,
    bytes: null,
    updatedAt: timestamp,
  };
}

/** Flatten one payload into mirror-link records (deduplicated, order preserved). */
export function collectMirrorLinks(
  payload: unknown,
  context: LinkContext,
  rules: MirrorLinkRules = {},
  now = new Date(),
): MirrorLink[] {
  const candidates: MirrorLinkCandidate[] = [];
  for (const url of extractUrlsFromPayload(payload)) {
    const verdict = classifyMirrorLink(url, rules);
    if (verdict.ok) candidates.push(verdict);
  }
  return uniqueBy(
    candidates.map((candidate) => toMirrorLink(candidate, context, now)),
    (link) => link.id,
  );
}

// ---------------------------------------------------------------- export/import

export type LinkExportGrouping = 'post' | 'provider' | 'plain';

export interface LinkExportOptions {
  grouping?: LinkExportGrouping;
  /** Creator / query label written into the header. */
  creator?: string | null;
  /** Server label written into the header. */
  server?: string | null;
  version?: string;
  now?: Date;
}

const EXPORT_HEADER_PREFIX = '#';

function sectionFor(link: MirrorLink, grouping: 'post' | 'provider'): MirrorLinkSection {
  if (grouping === 'provider') return { kind: 'provider', title: link.provider || link.host, postUrl: null };
  return {
    kind: 'post',
    title: link.postTitle || link.postId || link.host,
    postUrl: link.postUrl,
  };
}

function sectionKey(section: MirrorLinkSection): string {
  return `${section.kind}:${section.title}:${section.postUrl ?? ''}`;
}

function sectionHeader(section: MirrorLinkSection): string {
  const label = section.kind === 'post' ? 'Post' : 'Provider';
  return `${EXPORT_HEADER_PREFIX}# ${label}: ${section.title}${section.postUrl ? ` — ${section.postUrl}` : ''}`;
}

/**
 * Render links as a `.txt` file.
 *
 * The format is deliberately boring: `#` comment lines, `# #` section headers,
 * and one URL per line - optionally prefixed with `- ` when grouped. Anything
 * that can read a URL list (a download manager, a spreadsheet, a person) can use
 * it, and `parseLinkExport` reads the exact same shape back.
 */
export function formatLinkExport(links: readonly MirrorLink[], options: LinkExportOptions = {}): string {
  const grouping = options.grouping ?? 'post';
  const stamp = (options.now ?? new Date()).toISOString();
  const lines: string[] = [
    `${EXPORT_HEADER_PREFIX} Booru Server Manager — collected mirror links`,
    `${EXPORT_HEADER_PREFIX} Creator: ${options.creator || 'unknown'}`,
    `${EXPORT_HEADER_PREFIX} Server: ${options.server || 'unknown'}`,
    `${EXPORT_HEADER_PREFIX} Exported: ${stamp}`,
    `${EXPORT_HEADER_PREFIX} Total: ${links.length} link(s)${grouping === 'plain' ? '' : `, grouped by ${grouping}`}`,
    `${EXPORT_HEADER_PREFIX}`,
    `${EXPORT_HEADER_PREFIX} One URL per line. Feed this file back in with "Import .txt" to rebuild the list.`,
  ];

  if (grouping === 'plain') {
    lines.push('');
    const flat = [...links].sort((left, right) => left.url.localeCompare(right.url));
    for (const link of flat) lines.push(link.url);
    return `${lines.join('\n')}\n`;
  }

  const groups = new Map<string, { section: MirrorLinkSection; links: MirrorLink[] }>();
  const sorted = [...links].sort((left, right) => {
    const leftSection = sectionFor(left, grouping).title;
    const rightSection = sectionFor(right, grouping).title;
    const bySection = leftSection.localeCompare(rightSection);
    return bySection !== 0 ? bySection : left.url.localeCompare(right.url);
  });
  for (const link of sorted) {
    const section = sectionFor(link, grouping);
    const key = sectionKey(section);
    const bucket = groups.get(key) ?? { section, links: [] };
    bucket.links.push(link);
    groups.set(key, bucket);
  }

  for (const { section, links: bucket } of groups.values()) {
    lines.push('');
    lines.push(sectionHeader(section));
    for (const link of bucket) lines.push(`- ${link.url}`);
  }
  return `${lines.join('\n')}\n`;
}

export interface ParsedLinkExport {
  links: string[];
  /** Post/provider context from the section headers, keyed by URL. */
  contexts: Map<string, LinkContext>;
  sections: number;
}

/**
 * Read a file written by `formatLinkExport` (or by the userscript, or by hand).
 *
 * Tolerant by design: `#` lines are skipped, `## Section` (any form, including
 * the userscript's `Creator:`/`Collected:` preamble) starts a new context, and a
 * line is a link when it contains an `http(s)://` URL - with or without a bullet.
 */
export function parseLinkExport(text: string): ParsedLinkExport {
  const links: string[] = [];
  const contexts = new Map<string, LinkContext>();
  let current: LinkContext = {};
  let sections = 0;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith(EXPORT_HEADER_PREFIX)) {
      const header = line.replace(/^#+\s*/, '');
      const prefixed = /^(?:post|provider)\s*:\s*(.+)$/i.exec(header);
      if (prefixed) {
        sections += 1;
        const isProvider = /^provider\s*:/i.test(header);
        const [title, url] = splitTitleAndUrl(prefixed[1]!);
        // A provider section says nothing about the post it came from, and a
        // post section must not throw away the file-level `# Creator:` line.
        current = isProvider
          ? { creator: current.creator ?? null }
          : { creator: current.creator ?? null, postTitle: title, postUrl: url };
        continue;
      }
      const creator = /^creator\s*:\s*(.+)$/i.exec(header);
      if (creator) current = { ...current, creator: creator[1]!.trim() };
      // Every other `#` line is a comment (the userscript writes `Creator:` and
      // `Collected:` without the prefix, both end up here and are ignored).
      continue;
    }

    const url = normalizeLinkUrl(line.replace(/^[-*•+]\s*/, '').trim());
    if (!url) continue;
    links.push(url);
    contexts.set(url, { ...current });
  }

  return { links: uniqueBy(links, (url) => url), contexts, sections };
}

/** `Some title — https://…` → `['Some title', 'https://…']`. */
function splitTitleAndUrl(value: string): [string, string | null] {
  const parts = value.split(/\s+[—–-]\s+/);
  const title = (parts[0] ?? value).trim();
  const url = normalizeLinkUrl(parts[1]?.trim() ?? '');
  return [title || url || 'section', url];
}

/** Human label for a link row: the post title, else the provider, else the host. */
export function linkLabel(link: Pick<MirrorLink, 'postTitle' | 'provider' | 'host' | 'url'>): string {
  if (link.postTitle) return link.postTitle;
  if (link.provider && link.provider !== link.host) return `${link.provider} — ${fileNameFromUrl(link.url) ?? link.host}`;
  return fileNameFromUrl(link.url) ?? link.host;
}

/** Group a link list for the panel, keeping the export's section order. */
export function groupLinksByPost(links: readonly MirrorLink[]): Array<{ key: string; title: string; postUrl: string | null; links: MirrorLink[] }> {
  const groups = new Map<string, { key: string; title: string; postUrl: string | null; links: MirrorLink[] }>();
  for (const link of links) {
    const key = link.postUrl ?? `${link.siteType ?? 'link'}:${link.postId ?? link.host}`;
    const bucket = groups.get(key) ?? {
      key,
      title: link.postTitle || link.postId || link.provider,
      postUrl: link.postUrl,
      links: [],
    };
    bucket.links.push(link);
    groups.set(key, bucket);
  }
  return [...groups.values()];
}
