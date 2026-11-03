/**
 * Shared domain types for the Booru Server Manager extension.
 *
 * Design note: everything the UI talks about lives here, and nothing here is
 * specific to a single booru site. Site-specific shapes (JSON field names,
 * rating tokens, auth query params) stay inside `src/adapters/*` and are never
 * leaked into the UI layer.
 */

/** Site types are plain strings so that new booru-like sites need no type churn. */
export type SiteType = string;

export const KNOWN_SITE_TYPES = [
  'e621',
  'danbooru',
  'gelbooru',
  // Gelbooru 0.1.11 forks
  'rule34',
  'safebooru-org',
  'xbooru',
  'tbib',
  'hypnohub',
  'realbooru',
  // Moebooru
  'yandere',
  'konachan',
  // Philomena
  'derpibooru',
  'furbooru',
  'ponybooru',
  // Local client
  'hydrus',
  // Creator archive
  'pawchive',
] as const;
export type KnownSiteType = (typeof KNOWN_SITE_TYPES)[number];

/** Site-agnostic rating vocabulary used by the shared layer. */
export type Rating = 'general' | 'safe' | 'sensitive' | 'questionable' | 'explicit' | 'unknown';

/** Ratings considered SFW-ish; used as the default allow-list when filtering. */
export const DEFAULT_SAFE_RATINGS: Rating[] = ['general', 'safe', 'sensitive'];

export const ALL_RATINGS: Rating[] = ['general', 'safe', 'sensitive', 'questionable', 'explicit'];

export type ValidationStatus = 'unknown' | 'valid' | 'invalid' | 'unreachable' | 'partial';

/**
 * Failure taxonomy shared by validation, the HTTP layer and the UI.
 * The UI must be able to tell these apart (product policy: UX rule 4).
 */
export type FailureKind =
  /** Credentials were rejected (401 / site-specific auth error payload). */
  | 'auth-failure'
  /** Reached *something*, but it does not speak the expected API. */
  | 'endpoint-mismatch'
  /** DNS / TLS / offline / timeout. */
  | 'network-failure'
  /** 429 or 503 / "slow down" payloads. */
  | 'rate-limited'
  /** No adapter registered for the configured site type. */
  | 'unsupported-site'
  /** Missing required fields (e.g. Gelbooru userId without apiKey). */
  | 'incomplete-config'
  /** 5xx that is not rate limiting. */
  | 'server-error'
  /** Request was blocked by the site or an intermediary (403, CF challenge). */
  | 'blocked'
  /** Response could not be parsed into the adapter's expected shape. */
  | 'parse-failure'
  /** Anything else. */
  | 'unknown';

export type ValidationKind = 'ok' | FailureKind;

export interface ScoreResult {
  ok: boolean;
  kind: ValidationKind;
}

/** One step of a validation run, sanitized for display (never contains secrets). */
export interface ProbeTraceEntry {
  id: string;
  label: string;
  purpose: 'endpoint' | 'auth';
  /** Redacted URL - api_key/login/password params stripped. */
  requestUrl: string;
  method: string;
  status: number | null;
  ok: boolean;
  durationMs: number;
  message: string;
  kind?: ValidationKind;
}

export interface AccountInfo {
  username: string | null;
  userId: string | null;
  level: string | null;
}

export interface ValidationResult {
  kind: ValidationKind;
  ok: boolean;
  /** Did the endpoint look like the expected API? `null` = not probed. */
  endpointOk: boolean | null;
  /** Did credentials verify? `null` = no credentials supplied / not probed. */
  authOk: boolean | null;
  message: string;
  /** Extra human-readable notes (warnings that do not block success). */
  warnings: string[];
  account: AccountInfo | null;
  checkedAt: string;
  httpStatus: number | null;
  durationMs: number | null;
  trace: ProbeTraceEntry[];
}

export const UNKNOWN_VALIDATION: Pick<
  ValidationResult,
  'kind' | 'ok' | 'endpointOk' | 'authOk' | 'message' | 'warnings' | 'account' | 'checkedAt' | 'httpStatus' | 'durationMs' | 'trace'
> = {
  kind: 'ok',
  ok: false,
  endpointOk: null,
  authOk: null,
  message: '',
  warnings: [],
  account: null,
  checkedAt: '',
  httpStatus: null,
  durationMs: null,
  trace: [],
};

/**
 * A saved server / account profile - one site connection.
 * Field set is fixed by product policy (see README "Server entry schema").
 */
export interface ServerConfig {
  id: string;
  label: string;
  siteType: SiteType;
  baseUrl: string;
  ratingFilterEnabled: boolean;
  username: string;
  apiKey: string;
  userId: string;
  customUserAgent: string;
  isDefault: boolean;
  validationStatus: ValidationStatus;
  validationMessage: string;
  lastValidatedAt: string | null;
  /** Extension fields (safe defaults, optional everywhere). */
  allowedRatings?: Rating[];
  /** Redacted trace of the last validation run, for the diagnostics tab. */
  lastValidationTrace?: ProbeTraceEntry[];
  createdAt?: string;
  updatedAt?: string;
  notes?: string;
}

/** Server config with secrets removed - this is what crosses into the UI. */
export interface ServerConfigView extends Omit<ServerConfig, 'apiKey'> {
  /** Masked preview such as `•••••••4f2a`, or `''` when no key is stored. */
  apiKeyMask: string;
  hasApiKey: boolean;
}

/** Everything required to describe a post, independent of site. */
export interface BooruPost {
  serverId: string;
  siteType: SiteType;
  id: string;
  postUrl: string;
  fileUrl: string;
  previewUrl: string;
  sampleUrl: string | null;
  width: number | null;
  height: number | null;
  ext: string | null;
  sizeBytes: number | null;
  rating: Rating;
  /** Site's own rating token (e.g. `q`, `questionable`, `general`). */
  rawRating: string | null;
  tags: string[];
  tagCategories: Record<string, string[]>;
  artistTags: string[];
  characterTags: string[];
  score: number | null;
  md5: string | null;
  sources: string[];
  createdAt: string | null;
  isVideo: boolean;
  isAnimated: boolean;
  parentId: string | null;
  hasChildren: boolean;
  description: string | null;
  /** Pawchive can supply an expiring link or only a reduced preview. */
  fileAvailability?: 'full' | 'temporary' | 'preview';
}

export interface SearchSpec {
  tags?: string;
  limit?: number;
  page?: number;
  /**
   * The shared layer decides *whether* filtering happens (server config +
   * per-search toggle); the adapter decides *how* it is spelled for its site.
   */
  ratingFilter?: {
    enabled: boolean;
    allowed: Rating[];
  };
  order?: string | null;
  /** Site-native page token (`b12345` style pagination) when supported. */
  pageToken?: string | null;
}

export interface SearchResult {
  posts: BooruPost[];
  /** Original post references, including posts without downloadable files. */
  sourcePosts?: Array<{ id: string; label: string; postUrl: string }>;
  page: number;
  limit: number;
  hasMore: boolean;
  totalCount: number | null;
  /** Tags actually sent to the site (after rating filter injection). */
  appliedTags: string;
  requestUrl: string;
  siteType: SiteType;
  serverId: string;
}

export type RouteKind = 'post' | 'search' | 'tag' | 'pool' | 'index' | 'unknown';

export interface RouteMatch {
  siteType: SiteType;
  kind: RouteKind;
  /** Present for `kind === 'post'`. */
  postId: string | null;
  /** Present for search/tag routes. */
  tags: string | null;
  page: number | null;
  /** Normalized URL the route was read from. */
  canonicalUrl: string;
  /** Saved server that owns this route, when resolution ran against a server list. */
  serverId?: string;
}

export interface DownloadRecord {
  serverId: string;
  postId: string;
  filename: string;
  url: string;
  startedAt: string;
  finishedAt: string | null;
  ok: boolean;
  bytes: number | null;
  error: string | null;
  downloadId: number | null;
}

/** Where a toolbar click lands: the dockable side panel or the classic popup. */
export type UiMode = 'sidepanel' | 'popup';

/** How thorough the mirror-link filter is (the userscript's format/provider toggles). */
export type MirrorLinkFilter = 'downloads' | 'any';

/** Where a collected mirror link's file is put, relative to the download root. */
export const DEFAULT_MIRROR_FOLDER = 'mirrors/{host}';

export type MirrorLinkStatus = 'new' | 'queued' | 'done' | 'failed' | 'unverified';

/**
 * One off-site download link found inside a post (Google Drive, Mega, …).
 *
 * These are *not* booru posts: the file is not on the site's own host, so the
 * adapter cannot build a download request for it. The link is stored with the
 * post it came from, offered as a queue row, and can be exported/imported as a
 * plain `.txt` list so an external download manager can be fed the same work.
 */
export interface MirrorLink {
  /** Stable id derived from the normalised URL - re-scanning never duplicates. */
  id: string;
  url: string;
  host: string;
  /** Friendly provider name (`Mega`, `Google Drive`, …) or the bare host. */
  provider: string;
  /** Profile the link was collected with (provenance, not a download target). */
  serverId: string | null;
  siteType: SiteType | null;
  postId: string | null;
  postTitle: string | null;
  postUrl: string | null;
  creator: string | null;
  addedAt: string;
  status: MirrorLinkStatus;
  /** Only set when Chrome reported this transfer complete. */
  completion?: 'browser-complete';
  attempts: number;
  error: string | null;
  filename: string | null;
  bytes: number | null;
  updatedAt: string;
}

export interface MirrorLinkStats {
  total: number;
  new: number;
  queued: number;
  done: number;
  failed: number;
  unverified: number;
}

/**
 * What a task's files add up to - the "complete / partial / failed" answer.
 * `partial` is deliberately distinct from `failed`: a re-run should say
 * "3 of 10 still missing" rather than "it broke".
 */
export type TaskCompletion = 'empty' | 'idle' | 'in-progress' | 'complete' | 'partial' | 'failed';

/**
 * One recorded pass over a task - the traceability the user asked for.
 * A run is written when a task is started and updated as its rows settle, so
 * "what did the last run do, and when" is always answerable.
 */
export interface TaskRun {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  /** Posts the run looked at (a rescan only visits posts it has not seen). */
  scannedPosts: number;
  /** New files found by this run. */
  added: number;
  /** Rows handed to the download queue. */
  queued: number;
  done: number;
  failed: number;
  note: string | null;
  /** Older runs counted starts rather than browser-confirmed completions. */
  completionTracking?: 'browser-complete';
}

/**
 * A download task: one creator on one site, the files that belong to them.
 *
 * This is the extension's answer to a `.torrent` — a small, portable description
 * of a job that a second person can open with the same extension and run. The
 * files themselves are **not** stored here: a member is a mirror link id, and
 * its state (`new`/`queued`/`done`/`failed`, saved name, error) lives in
 * `bsm.links`. That is what keeps re-importing the same package, or collecting
 * the same creator twice, idempotent.
 */
export interface DownloadTask {
  /** `site:service:creator` (or `site:query`) - stable across exports/imports. */
  id: string;
  name: string;
  siteType: SiteType | null;
  serverId: string | null;
  /** Archive service, e.g. `fanbox`, `patreon` - null for a plain URL list. */
  service: string | null;
  /** Creator id/name as the site spells it. */
  creator: string | null;
  /** The query the panel used (or would use) to re-list the creator. */
  query: string;
  createdAt: string;
  updatedAt: string;
  lastScanAt: string | null;
  /** File ids, in discovery order. */
  memberIds: string[];
  /** Posts already scanned, so a rescan only visits what is new. */
  scannedPosts: string[];
  runs: TaskRun[];
}

export interface TaskStats {
  total: number;
  done: number;
  failed: number;
  queued: number;
  unverified: number;
  /** Files not confirmed complete (new, queued, failed or unverified). */
  pending: number;
  /** Bytes of the files that finished (null when none reported a size). */
  bytes: number | null;
}

/** One task plus how its files are doing - what the Links tab renders. */
export interface TaskView {
  task: DownloadTask;
  stats: TaskStats;
  completion: TaskCompletion;
  lastRun: TaskRun | null;
}

/** Section header written by `formatLinkExport` and read back by `parseLinkExport`. */
export interface MirrorLinkSection {
  /** `post` sections carry the post URL/title, `provider` sections the host. */
  kind: 'post' | 'provider';
  title: string;
  postUrl: string | null;
}

/** Panel screens, mirroring the tab strip at the top of the side panel. */
export type PanelTab = 'browse' | 'queue' | 'links' | 'servers' | 'settings';

/**
 * What a queue row is: a post on a saved server, or a collected mirror link.
 *
 * Both live in the same list on purpose - "the list is the queue" - so a run, a
 * resume after a worker restart and the row toolbars work the same for either.
 */
export type QueueItemKind = 'post' | 'link';

/** Coarse media kind used by the listing and queue filters. */
export type MediaFilter = 'all' | 'video' | 'image';

/** What to do when the browser reports an existing file with the same name. */
export type DuplicateBehaviour = 'uniquify' | 'overwrite';

/** `sample` is accepted only for legacy imports and migrates to `original`. */
export type FilePreference = 'original' | 'sample';

export interface ExtensionSettings {
  /** Directory template for saved files, e.g. `booru/{siteType}`. */
  folderTemplate: string;
  /** Filename template, e.g. `{id}_{md5}.{ext}`. */
  filenameTemplate: string;
  /** Simultaneous downloads across all servers. */
  maxConcurrency: number;
  /** Minimum gap between requests to the *same* server (ms). Adapters raise this. */
  minRequestIntervalMs: number;
  /** Extra tags appended to every search (shared safe-search extras). */
  globalTagSuffix: string;
  /** How many tags `{tags}` expands to in a filename. */
  maxTagsInFilename: number;
  /** Separator used when several tags are joined in a filename. */
  tagSeparator: string;
  /** Show a floating download button on post pages. */
  enableContentScriptButton: boolean;
  /** Send `_client=<user agent>` where a site documents that fallback. */
  sendClientParam: boolean;
  /** Ask the service worker to rewrite User-Agent via declarativeNetRequest. */
  rewriteUserAgent: boolean;
  /** Only download posts whose rating is in the server allow-list. */
  enforceRatingFilterOnDownload: boolean;
  /** Retry budget for transient failures. */
  maxRetries: number;
  /** Theme for the UI pages. */
  theme: 'system' | 'light' | 'dark';

  // ---------------------------------------------------------------- side panel
  /** What a toolbar click opens (same idea as NHentai Downloader's `uiMode`). */
  uiMode: UiMode;
  /** Tab the side panel shows when it opens. */
  panelDefaultTab: PanelTab;
  /** Default media filter in the listing card. */
  mediaFilter: MediaFilter;
  /** Hide posts that are already in the download history. */
  skipDownloaded: boolean;
  /** Hard cap on pages a single listing fetch may walk (rule34video: 150). */
  pageRangeLimit: number;
  /** Queue rows rendered at once; the rest is summarised as "n more". */
  queueRowLimit: number;
  /** Show post thumbnails in queue rows. */
  showThumbnails: boolean;
  /** Start the queue as soon as "Download selected" is pressed. */
  autoStartQueue: boolean;
  /** Existing file with the same name: keep both or overwrite. */
  duplicateBehaviour: DuplicateBehaviour;
  /** Legacy setting: always normalized to original for downloads. */
  filePreference: FilePreference;
  /** Space/comma separated tags excluded from every search (`-tag`). */
  tagBlacklist: string;
  /** Remember the searches you ran, per server. */
  searchHistoryEnabled: boolean;
  /** How many searches to keep per server. */
  searchHistoryLimit: number;

  // ------------------------------------------------------------ mirror links
  /**
   * Folder template for collected mirror links. Tokens: `{host}`, `{provider}`,
   * `{siteType}`, `{filename}`, `{ext}`, `{date}`.
   */
  mirrorFolderTemplate: string;
  /** Extra provider hosts the Links tab should treat as download links. */
  mirrorExtraHosts: string;
  /** `downloads` keeps known providers + download-looking URLs; `any` keeps every external link. */
  mirrorLinksFilter: MirrorLinkFilter;
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  folderTemplate: 'booru/{siteType}',
  filenameTemplate: '{id}_{md5}',
  maxConcurrency: 2,
  minRequestIntervalMs: 1000,
  globalTagSuffix: '',
  maxTagsInFilename: 5,
  tagSeparator: ' ',
  enableContentScriptButton: true,
  sendClientParam: true,
  rewriteUserAgent: true,
  enforceRatingFilterOnDownload: true,
  maxRetries: 3,
  theme: 'system',

  uiMode: 'sidepanel',
  panelDefaultTab: 'browse',
  mediaFilter: 'all',
  // Opt in to hiding browser-confirmed completions; files may later be moved or deleted.
  skipDownloaded: false,
  pageRangeLimit: 150,
  queueRowLimit: 60,
  showThumbnails: true,
  autoStartQueue: true,
  duplicateBehaviour: 'uniquify',
  filePreference: 'original',
  tagBlacklist: '',
  searchHistoryEnabled: true,
  searchHistoryLimit: 12,

  mirrorFolderTemplate: DEFAULT_MIRROR_FOLDER,
  mirrorExtraHosts: '',
  mirrorLinksFilter: 'downloads',
};

/** A browser download start, kept so listings can optionally skip it next time. */
export interface DownloadHistoryEntry {
  /** `${serverId}:${postId}` - the uniqueness key. */
  key: string;
  serverId: string;
  siteType: SiteType;
  postId: string;
  label: string;
  filename: string;
  postUrl: string;
  bytes: number | null;
  at: string;
  /** Absent on old entries that may have been samples. */
  quality?: 'original';
  /** Absent on old entries, which recorded a start rather than completion. */
  completion?: 'browser-complete';
}

/** One remembered search, per server (Anime Boxes keeps the same list). */
export interface SearchHistoryEntry {
  serverId: string;
  query: string;
  at: string;
}

export type QueueItemStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped' | 'canceled' | 'unverified';

export interface QueueItem {
  id: string;
  serverId: string;
  postId: string;
  label: string;
  postUrl: string;
  /**
   * `post` (default, rows queued before this existed too) or `link` for a mirror
   * URL collected by the Links tab. Link rows download `url` directly and skip
   * the post lookup, the adapter and the rating filter.
   */
  kind?: QueueItemKind;
  /** The mirror URL of a `link` row. */
  url?: string | null;
  /** Canonical rating known at enqueue time (null for items queued before v0.2). */
  rating: Rating | null;
  /** Distinguishes current Pawchive slot numbering from older ambiguous rows. */
  attachmentIndexVersion?: 2;
  /** Pawchive API path hash observed at listing time, when supplied. */
  expectedFileHash?: string | null;
  status: QueueItemStatus;
  attempts: number;
  error: string | null;
  errorKind: FailureKind | null;
  filename: string | null;
  bytes: number | null;
  /** Durable Chrome ID, absent while a request is still being prepared. */
  downloadId?: number | null;
  /** Browser-reported byte progress; null means Chrome did not report a value. */
  bytesReceived?: number | null;
  totalBytes?: number | null;
  cancelRequested?: boolean;
  /** Distinguishes confirmed completions from the old start-only `done` rows. */
  completion?: 'browser-complete';
  /** Details needed to write post history after the browser finishes. */
  historyEntry?: DownloadHistoryEntry | null;
  /** A bookkeeping write failed and should be retried without downloading again. */
  bookkeepingPending?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface QueueSummary {
  pending: number;
  running: number;
  done: number;
  failed: number;
  skipped: number;
  canceled: number;
  unverified: number;
  total: number;
  paused: boolean;
  active: boolean;
}
