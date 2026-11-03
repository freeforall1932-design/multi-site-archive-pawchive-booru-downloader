import { DEFAULT_SETTINGS, DEFAULT_MIRROR_FOLDER, type ExtensionSettings, type PanelTab } from '../shared/types.js';
import { clamp, toInt } from '../shared/util.js';
import { STORAGE_KEYS, type StorageArea } from './storage.js';

export type SettingsListener = (settings: ExtensionSettings) => void;

const MAX_TEMPLATE_LENGTH = 300;

/** Coerce whatever is in storage into a valid settings object. */
export function normalizeSettings(raw: unknown): ExtensionSettings {
  const input = (raw ?? {}) as Partial<ExtensionSettings>;
  const theme = input.theme === 'light' || input.theme === 'dark' ? input.theme : 'system';
  return {
    folderTemplate: sanitizeTemplate(input.folderTemplate, DEFAULT_SETTINGS.folderTemplate),
    filenameTemplate: sanitizeTemplate(input.filenameTemplate, DEFAULT_SETTINGS.filenameTemplate),
    maxConcurrency: clamp(toInt(input.maxConcurrency, DEFAULT_SETTINGS.maxConcurrency), 1, 8),
    minRequestIntervalMs: clamp(toInt(input.minRequestIntervalMs, DEFAULT_SETTINGS.minRequestIntervalMs), 0, 30_000),
    globalTagSuffix: sanitizeTagList(input.globalTagSuffix, 300),
    maxTagsInFilename: clamp(toInt(input.maxTagsInFilename, DEFAULT_SETTINGS.maxTagsInFilename), 1, 30),
    tagSeparator: typeof input.tagSeparator === 'string' ? input.tagSeparator.slice(0, 3) : DEFAULT_SETTINGS.tagSeparator,
    enableContentScriptButton: input.enableContentScriptButton ?? DEFAULT_SETTINGS.enableContentScriptButton,
    sendClientParam: input.sendClientParam ?? DEFAULT_SETTINGS.sendClientParam,
    rewriteUserAgent: input.rewriteUserAgent ?? DEFAULT_SETTINGS.rewriteUserAgent,
    enforceRatingFilterOnDownload: input.enforceRatingFilterOnDownload ?? DEFAULT_SETTINGS.enforceRatingFilterOnDownload,
    maxRetries: clamp(toInt(input.maxRetries, DEFAULT_SETTINGS.maxRetries), 1, 8),
    theme,

    uiMode: input.uiMode === 'popup' ? 'popup' : 'sidepanel',
    panelDefaultTab: isPanelTab(input.panelDefaultTab) ? input.panelDefaultTab : DEFAULT_SETTINGS.panelDefaultTab,
    mediaFilter: input.mediaFilter === 'video' || input.mediaFilter === 'image' ? input.mediaFilter : 'all',
    skipDownloaded: input.skipDownloaded ?? DEFAULT_SETTINGS.skipDownloaded,
    pageRangeLimit: clamp(toInt(input.pageRangeLimit, DEFAULT_SETTINGS.pageRangeLimit), 1, 500),
    queueRowLimit: clamp(toInt(input.queueRowLimit, DEFAULT_SETTINGS.queueRowLimit), 10, 500),
    showThumbnails: input.showThumbnails ?? DEFAULT_SETTINGS.showThumbnails,
    autoStartQueue: input.autoStartQueue ?? DEFAULT_SETTINGS.autoStartQueue,
    duplicateBehaviour: input.duplicateBehaviour === 'overwrite' ? 'overwrite' : 'uniquify',
    // Legacy profiles may contain `sample`; silently migrate them to the only
    // supported download quality. UI thumbnails are unaffected.
    filePreference: 'original',
    tagBlacklist: sanitizeTagList(input.tagBlacklist, 500),
    searchHistoryEnabled: input.searchHistoryEnabled ?? DEFAULT_SETTINGS.searchHistoryEnabled,
    searchHistoryLimit: clamp(toInt(input.searchHistoryLimit, DEFAULT_SETTINGS.searchHistoryLimit), 0, 50),

    mirrorFolderTemplate: sanitizeTemplate(input.mirrorFolderTemplate, DEFAULT_MIRROR_FOLDER),
    mirrorExtraHosts: sanitizeHostList(input.mirrorExtraHosts),
    mirrorLinksFilter: input.mirrorLinksFilter === 'any' ? 'any' : 'downloads',
  };
}

function isPanelTab(value: unknown): value is PanelTab {
  return value === 'browse' || value === 'queue' || value === 'links' || value === 'servers' || value === 'settings';
}

/**
 * Free-text host list (`mega.nz, mydrive.example`). Users paste whole URLs by
 * habit, so the scheme, path and a leading `www.` are stripped here.
 */
function sanitizeHostList(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .split(/[\s,]+/)
    .map((token) =>
      token
        .trim()
        .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
        .replace(/\/.*$/, '')
        .replace(/^www\./i, '')
        .toLowerCase(),
    )
    .filter((token) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(token))
    .join(' ')
    .slice(0, 500);
}

/**
 * Tag-ish free text (blacklist, global suffix): collapse whitespace, drop the
 * minus sign the user may have typed (`-gore` and `gore` are the same rule) and
 * cap the length. Multi-line input is accepted for readability.
 */
function sanitizeTagList(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  return value
    .split(/[\s,]+/)
    .map((token) => token.trim().replace(/^-+/, ''))
    .filter(Boolean)
    .join(' ')
    .slice(0, maxLength);
}

function sanitizeTemplate(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim().slice(0, MAX_TEMPLATE_LENGTH);
  return trimmed || fallback;
}

export class SettingsStore {
  private cache: ExtensionSettings | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<SettingsListener>();

  constructor(private readonly area: StorageArea) {}

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const next = this.chain.then(task, task);
    this.chain = next.then(() => undefined, () => undefined);
    return next;
  }

  async get(): Promise<ExtensionSettings> {
    if (this.cache) return { ...this.cache };
    const stored = await this.area.get<unknown>(STORAGE_KEYS.settings);
    this.cache = normalizeSettings(stored ?? DEFAULT_SETTINGS);
    return { ...this.cache };
  }

  async save(patch: Partial<ExtensionSettings>): Promise<ExtensionSettings> {
    return this.serialize(async () => {
      const current = await this.get();
      const next = normalizeSettings({ ...current, ...patch });
      await this.area.set(STORAGE_KEYS.settings, next);
      this.cache = next;
      this.listeners.forEach((listener) => listener({ ...next }));
      return { ...next };
    });
  }

  async reset(): Promise<ExtensionSettings> {
    return this.save(DEFAULT_SETTINGS);
  }

  onChange(listener: SettingsListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Storage writes from other contexts (options page vs service worker) invalidate the cache. */
  invalidate(): void {
    this.cache = null;
  }
}
