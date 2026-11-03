import { BooruError } from '../shared/errors.js';
import type { Rating, ServerConfig, ServerConfigView, ValidationResult } from '../shared/types.js';
import { ALL_RATINGS } from '../shared/types.js';
import { createId, deepClone, isValidHttpUrl, maskSecret, normalizeBaseUrl, redactUrl, safeUrl, unique } from '../shared/util.js';
import { getAdapter, requireAdapter } from './registry.js';
import { STORAGE_KEYS, type StorageArea } from './storage.js';

export type ServerListener = (servers: ServerConfig[]) => void;

/** Whether a stored profile can be used, without discarding unsupported data. */
export function isUsableServer(server: Pick<ServerConfig, 'siteType' | 'baseUrl'>): boolean {
  const adapter = getAdapter(server.siteType);
  if (!adapter) return false;
  try {
    const url = normalizeBaseUrl(adapter.normalizeBaseUrl ? adapter.normalizeBaseUrl(server.baseUrl) : server.baseUrl);
    const parsed = safeUrl(url);
    return isValidHttpUrl(url) && !parsed?.username && !parsed?.password;
  } catch {
    return false;
  }
}

/** Compare normalized connection targets before reusing an existing secret. */
export function sameServerConnection(
  left: Pick<ServerConfig, 'siteType' | 'baseUrl'>,
  right: Pick<ServerConfig, 'siteType' | 'baseUrl'>,
): boolean {
  if (left.siteType !== right.siteType) return false;
  const adapter = getAdapter(left.siteType);
  if (!adapter) return false;
  try {
    const normalize = (baseUrl: string) => normalizeBaseUrl(adapter.normalizeBaseUrl ? adapter.normalizeBaseUrl(baseUrl) : baseUrl);
    const first = normalize(left.baseUrl);
    const second = normalize(right.baseUrl);
    return !!first && first === second;
  } catch {
    return false;
  }
}

/** Fields whose change invalidates a previous validation run. */
const VALIDATION_INVALIDATING_FIELDS: Array<keyof ServerConfig> = [
  'siteType',
  'baseUrl',
  'username',
  'apiKey',
  'userId',
  'customUserAgent',
];

export interface SaveServerInput extends Partial<Omit<ServerConfig, 'id'>> {
  id?: string;
}

export interface SaveServerOptions {
  /**
   * When true (default) an empty `apiKey` on an existing profile means "keep the
   * stored secret" - the UI never round-trips secrets back to the browser.
   */
  keepSecretsWhenBlank?: boolean;
}

export interface ExportOptions {
  includeSecrets?: boolean;
}

export interface ImportResult {
  imported: number;
  skipped: number;
  errors: string[];
}

/**
 * Server/account store: the multi-server heart of the extension.
 * One saved entry == one site connection profile (site type + base URL + creds).
 */
export class ServerStore {
  private cache: ServerConfig[] | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<ServerListener>();

  constructor(private readonly area: StorageArea) {}

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const next = this.chain.then(task, task);
    this.chain = next.then(() => undefined, () => undefined);
    return next;
  }

  // ---------------------------------------------------------------- reads

  async list(): Promise<ServerConfig[]> {
    if (!this.cache) {
      const stored = await this.area.get<unknown>(STORAGE_KEYS.servers);
      const servers = Array.isArray(stored) ? stored.map((entry) => this.normalizeStored(entry)) : [];
      // Keep retired profiles available for export/deletion, but never let one
      // remain the default when a supported Pawchive or booru profile exists.
      this.cache = this.withSupportedDefault(servers);
    }
    return this.cache.map((entry) => deepClone(entry));
  }

  async listViews(): Promise<ServerConfigView[]> {
    const servers = await this.list();
    return servers.map((server) => toServerView(server));
  }

  async get(id: string): Promise<ServerConfig | null> {
    const servers = await this.list();
    return servers.find((server) => server.id === id) ?? null;
  }

  async getDefault(): Promise<ServerConfig | null> {
    const servers = await this.list();
    return servers.find((server) => server.isDefault && isUsableServer(server)) ?? servers.find(isUsableServer) ?? null;
  }

  async count(): Promise<number> {
    return (await this.list()).length;
  }

  // --------------------------------------------------------------- writes

  /**
   * Create or update a profile. Site type + base URL are normalized through the
   * adapter, so custom ports, trailing slashes and pasted API URLs behave.
   */
  async save(input: SaveServerInput, options: SaveServerOptions = {}): Promise<ServerConfig> {
    return this.serialize(async () => {
      const keepSecrets = options.keepSecretsWhenBlank !== false;
      const servers = await this.list();

      const existingIndex = input.id ? servers.findIndex((server) => server.id === input.id) : -1;
      const existing = existingIndex >= 0 ? servers[existingIndex]! : null;

      const siteType = (input.siteType ?? existing?.siteType ?? '').trim();
      if (!siteType) {
        throw new BooruError('A site type is required to save a server', { kind: 'incomplete-config' });
      }
      const adapter = requireAdapter(siteType);

      // An intentionally blank field falls back to the adapter's documented root.
      const rawBaseUrl = firstNonEmpty(input.baseUrl, existing?.baseUrl, adapter.defaults.baseUrl).trim();
      if (!rawBaseUrl) {
        throw new BooruError('A base URL is required to save a server', { kind: 'incomplete-config' });
      }
      const baseUrl = normalizeBaseUrl(adapter.normalizeBaseUrl ? adapter.normalizeBaseUrl(rawBaseUrl) : rawBaseUrl) || rawBaseUrl;
      const parsedBase = safeUrl(baseUrl);
      if (parsedBase?.username || parsedBase?.password) {
        throw new BooruError('Server URLs cannot contain embedded credentials.', {
          kind: 'incomplete-config', hint: 'Remove user information from the URL and use the profile credential fields instead.',
        });
      }

      const incomingApiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : undefined;
      const preserveKey = incomingApiKey === undefined || (keepSecrets && incomingApiKey === '');
      if (existing?.apiKey && preserveKey && !sameServerConnection(existing, { siteType, baseUrl })) {
        throw new BooruError('Changing the server URL or site type requires an explicit credential choice.', {
          kind: 'incomplete-config',
          hint: 'Re-enter the key for the new server, or clear the old profile credentials before changing it.',
        });
      }
      const apiKey = preserveKey ? existing?.apiKey ?? '' : incomingApiKey ?? '';

      const allowedRatings = this.normalizeRatings(input.allowedRatings ?? existing?.allowedRatings, adapter.defaults.ratings);

      const next: ServerConfig = {
        id: existing?.id ?? input.id ?? createId('srv'),
        label: firstNonEmpty(input.label, existing?.label, adapter.defaults.label).trim() || adapter.defaults.label,
        siteType,
        baseUrl,
        ratingFilterEnabled: input.ratingFilterEnabled ?? existing?.ratingFilterEnabled ?? true,
        username: (input.username ?? existing?.username ?? '').trim(),
        apiKey,
        userId: (input.userId ?? existing?.userId ?? '').trim(),
        customUserAgent: (input.customUserAgent ?? existing?.customUserAgent ?? '').trim(),
        // `true` promotes this profile; `false` never demotes an existing default,
        // and the very first saved profile becomes the default automatically.
        isDefault: input.isDefault === true ? true : existing?.isDefault ?? !servers.some((server) => server.isDefault),
        validationStatus: existing?.validationStatus ?? 'unknown',
        validationMessage: existing?.validationMessage ?? '',
        lastValidatedAt: existing?.lastValidatedAt ?? null,
        allowedRatings,
        lastValidationTrace: existing?.lastValidationTrace,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        notes: input.notes ?? existing?.notes,
      };

      if (this.validationInvalidated(existing, next)) {
        next.validationStatus = 'unknown';
        next.validationMessage = '';
        next.lastValidatedAt = null;
        next.lastValidationTrace = [];
      }

      if (existingIndex >= 0) servers[existingIndex] = next;
      else servers.push(next);

      const normalized = next.isDefault ? this.promoteDefault(servers, next.id) : servers;
      const saved = await this.persist(normalized);
      return saved.find((server) => server.id === next.id) ?? next;
    });
  }

  async remove(id: string): Promise<ServerConfig[]> {
    return this.serialize(async () => {
      const servers = await this.list();
      const remaining = servers.filter((server) => server.id !== id);
      return this.persist(remaining);
    });
  }

  /** Duplicate a profile (same connection + credentials, fresh id, not default). */
  async duplicate(id: string, overrides: SaveServerInput = {}): Promise<ServerConfig> {
    const source = await this.get(id);
    if (!source) {
      throw new BooruError(`Cannot duplicate unknown server ${id}`, { kind: 'unknown' });
    }
    const target = { siteType: overrides.siteType ?? source.siteType, baseUrl: overrides.baseUrl ?? source.baseUrl };
    if (source.apiKey && !sameServerConnection(source, target) && typeof overrides.apiKey !== 'string') {
      throw new BooruError('Changing the duplicate server target requires an explicit credential choice.', {
        kind: 'incomplete-config', hint: 'Provide a key for the new server or explicitly clear it.',
      });
    }
    const copy: SaveServerInput = {
      ...deepClone(source),
      ...overrides,
      id: undefined,
      label: overrides.label ?? `${source.label} (copy)`,
      isDefault: overrides.isDefault ?? false,
      validationStatus: 'unknown',
      validationMessage: '',
      lastValidatedAt: null,
      lastValidationTrace: [],
    };
    delete (copy as { id?: string }).id;
    return this.save(copy, { keepSecretsWhenBlank: false });
  }

  async setDefault(id: string): Promise<ServerConfig[]> {
    return this.serialize(async () => {
      const servers = await this.list();
      const target = servers.find((server) => server.id === id);
      if (!target) {
        throw new BooruError(`Cannot set unknown server ${id} as default`, { kind: 'unknown' });
      }
      const adapter = requireAdapter(target.siteType);
      if (!isUsableServer(target)) {
        // Preserve the adapter's more specific error, if it supplies one.
        adapter.normalizeBaseUrl?.(target.baseUrl);
        throw new BooruError('This server has an invalid base URL', { kind: 'incomplete-config' });
      }
      return this.persist(this.promoteDefault(servers, id));
    });
  }

  /** Store the outcome of a validation run carried out by the validation service. */
  async updateValidation(id: string, result: ValidationResult, expected?: ServerConfig): Promise<ServerConfig | null> {
    return this.serialize(async () => {
      const servers = await this.list();
      const index = servers.findIndex((server) => server.id === id);
      // A probe may finish after the user edits or removes the connection. Never
      // attach the old result to new credentials or a different endpoint.
      if (index < 0 || (expected && this.validationInvalidated(expected, servers[index]!))) return null;
      const status: ServerConfig['validationStatus'] = result.ok
        ? 'valid'
        : result.kind === 'network-failure' || result.kind === 'rate-limited' || result.kind === 'server-error'
          ? 'unreachable'
          : result.endpointOk === false
            ? 'invalid'
            : result.authOk === false
              ? 'invalid'
              : 'partial';
      const target = servers[index]!;
      servers[index] = {
        ...target,
        validationStatus: status,
        validationMessage: result.message.slice(0, 500),
        lastValidatedAt: result.checkedAt,
        lastValidationTrace: result.trace.slice(-8),
        updatedAt: new Date().toISOString(),
      };
      const saved = await this.persist(servers);
      return saved.find((server) => server.id === id) ?? null;
    });
  }

  /** Wipe stored credentials for one profile, keeping the rest of the config. */
  async clearCredentials(id: string): Promise<ServerConfig | null> {
    return this.update(id, { apiKey: '' });
  }

  async update(id: string, patch: Partial<ServerConfig>): Promise<ServerConfig | null> {
    return this.serialize(async () => {
      const servers = await this.list();
      const index = servers.findIndex((server) => server.id === id);
      if (index < 0) return null;
      const previous = servers[index]!;
      const next = { ...previous, ...patch, id, updatedAt: new Date().toISOString() };
      if (this.validationInvalidated(previous, next)) {
        next.validationStatus = 'unknown';
        next.validationMessage = '';
        next.lastValidatedAt = null;
        next.lastValidationTrace = [];
      }
      servers[index] = next;
      const saved = await this.persist(servers);
      return saved.find((server) => server.id === id) ?? null;
    });
  }

  /** Remove every stored profile (and therefore every stored credential). */
  async removeAll(): Promise<void> {
    return this.serialize(async () => {
      await this.area.set(STORAGE_KEYS.servers, []);
      this.cache = [];
      this.listeners.forEach((listener) => listener([]));
    });
  }

  // ------------------------------------------------------- import / export

  /** Export profiles for backup. Secrets are excluded unless explicitly asked for. */
  async exportServers(options: ExportOptions = {}): Promise<string> {
    const servers = await this.list();
    const includeSecrets = options.includeSecrets === true;
    const payload = {
      kind: 'booru-server-manager.servers',
      version: 1,
      exportedAt: new Date().toISOString(),
      includesSecrets: includeSecrets,
      servers: servers.map((server) => (includeSecrets ? deepClone(server) : { ...deepClone(server), apiKey: '', baseUrl: redactUrl(server.baseUrl) })),
    };
    return JSON.stringify(payload, null, 2);
  }

  async importServers(json: string, options: ExportOptions = {}): Promise<ImportResult> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new BooruError('Import file is not valid JSON', { kind: 'incomplete-config' });
    }
    const container = parsed as { servers?: unknown };
    const list = Array.isArray(parsed) ? parsed : Array.isArray(container?.servers) ? container.servers : null;
    if (!list) {
      throw new BooruError('Import file does not contain a server list', { kind: 'incomplete-config' });
    }

    const result: ImportResult = { imported: 0, skipped: 0, errors: [] };
    let hasDefault = (await this.list()).some((server) => server.isDefault);
    for (const entry of list) {
      const candidate = entry as SaveServerInput;
      if (!candidate?.siteType || !candidate?.baseUrl) {
        result.skipped += 1;
        continue;
      }
      if (!getAdapter(candidate.siteType)) {
        result.skipped += 1;
        result.errors.push(`Unsupported site type "${candidate.siteType}" was skipped`);
        continue;
      }
      try {
        const saved = await this.save(
          {
            ...candidate,
            isDefault: !hasDefault && (candidate.isDefault ?? false),
            validationStatus: candidate.validationStatus ?? 'unknown',
          },
          { keepSecretsWhenBlank: options.includeSecrets !== true },
        );
        hasDefault = hasDefault || saved.isDefault;
        result.imported += 1;
      } catch (error) {
        result.skipped += 1;
        result.errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    return result;
  }

  // -------------------------------------------------------------- helpers

  onChange(listener: ServerListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Drops the in-memory cache; used when another context wrote to storage. */
  invalidate(): void {
    this.cache = null;
  }

  private normalizeRatings(input: Rating[] | undefined, fallback: Rating[]): Rating[] {
    if (!input || input.length === 0) return unique(fallback);
    const valid = input.filter((rating): rating is Rating => ALL_RATINGS.includes(rating));
    return valid.length ? unique(valid) : unique(fallback);
  }

  private validationInvalidated(previous: ServerConfig | null, next: ServerConfig): boolean {
    if (!previous) return false;
    return VALIDATION_INVALIDATING_FIELDS.some((field) => previous[field] !== next[field]);
  }

  private promoteDefault(servers: ServerConfig[], id: string): ServerConfig[] {
    return servers.map((server) => ({ ...server, isDefault: server.id === id }));
  }

  private normalizeStored(entry: unknown): ServerConfig {
    const raw = (entry ?? {}) as Partial<ServerConfig>;
    const siteType = typeof raw.siteType === 'string' ? raw.siteType : '';
    const adapter = getAdapter(siteType);
    const baseUrl = typeof raw.baseUrl === 'string' ? raw.baseUrl : '';
    let normalizedBaseUrl = baseUrl;
    try {
      if (adapter) normalizedBaseUrl = normalizeBaseUrl(adapter.normalizeBaseUrl ? adapter.normalizeBaseUrl(baseUrl) : baseUrl) || baseUrl;
    } catch {
      // A retired/invalid profile must not prevent the rest from loading. It
      // remains visible for export or removal, and requests still reject it.
    }
    return {
      id: typeof raw.id === 'string' && raw.id ? raw.id : createId('srv'),
      label: typeof raw.label === 'string' && raw.label ? raw.label : (adapter?.displayName ?? siteType) || 'Server',
      siteType,
      baseUrl: normalizedBaseUrl,
      ratingFilterEnabled: raw.ratingFilterEnabled ?? true,
      username: raw.username ?? '',
      apiKey: raw.apiKey ?? '',
      userId: raw.userId ?? '',
      customUserAgent: raw.customUserAgent ?? '',
      isDefault: raw.isDefault ?? false,
      validationStatus: raw.validationStatus ?? 'unknown',
      validationMessage: raw.validationMessage ?? '',
      lastValidatedAt: raw.lastValidatedAt ?? null,
      allowedRatings: raw.allowedRatings?.length ? raw.allowedRatings : adapter ? [...adapter.defaults.ratings] : ['safe'],
      lastValidationTrace: raw.lastValidationTrace ?? [],
      createdAt: raw.createdAt ?? new Date().toISOString(),
      updatedAt: raw.updatedAt ?? new Date().toISOString(),
      notes: raw.notes,
    };
  }

  private withSupportedDefault(servers: ServerConfig[]): ServerConfig[] {
    const supported = servers.filter(isUsableServer);
    const chosen = supported.find((server) => server.isDefault) ?? supported[0];
    return servers.map((server) => ({ ...server, isDefault: server.id === chosen?.id }));
  }

  private async persist(servers: ServerConfig[]): Promise<ServerConfig[]> {
    const sorted = sortServers(this.withSupportedDefault(servers));
    await this.area.set(STORAGE_KEYS.servers, sorted);
    this.cache = sorted;
    this.listeners.forEach((listener) => listener(sorted.map((server) => deepClone(server))));
    return sorted.map((server) => deepClone(server));
  }
}

function firstNonEmpty(...values: Array<string | undefined | null>): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

/** Default first, then alphabetical - matches the "server list" product model. */
export function sortServers(servers: ServerConfig[]): ServerConfig[] {
  return [...servers].sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    return a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });
  });
}

/** Shape a profile view: mask its API key and redact known URL credentials. */
export function toServerView(server: ServerConfig): ServerConfigView {
  const { apiKey, ...rest } = server;
  const parsedBase = safeUrl(server.baseUrl);
  const embeddedCredentials = !!(parsedBase?.username || parsedBase?.password);
  return {
    ...rest,
    baseUrl: redactUrl(rest.baseUrl),
    ...(embeddedCredentials ? { validationStatus: 'invalid' as const, validationMessage: 'Remove embedded credentials from the server URL.' } : {}),
    apiKeyMask: maskSecret(apiKey),
    hasApiKey: !!apiKey,
  };
}

/** Convenience factory used by tests and the preview harness. */
export function createServerConfig(partial: Partial<ServerConfig> & { siteType: string; baseUrl: string }): ServerConfig {
  const adapter = getAdapter(partial.siteType);
  return {
    id: partial.id ?? createId('srv'),
    label: partial.label ?? adapter?.defaults.label ?? partial.siteType,
    siteType: partial.siteType,
    baseUrl: partial.baseUrl,
    ratingFilterEnabled: partial.ratingFilterEnabled ?? true,
    username: partial.username ?? '',
    apiKey: partial.apiKey ?? '',
    userId: partial.userId ?? '',
    customUserAgent: partial.customUserAgent ?? '',
    isDefault: partial.isDefault ?? false,
    validationStatus: partial.validationStatus ?? 'unknown',
    validationMessage: partial.validationMessage ?? '',
    lastValidatedAt: partial.lastValidatedAt ?? null,
    allowedRatings: partial.allowedRatings ?? (adapter ? [...adapter.defaults.ratings] : ['safe']),
    lastValidationTrace: partial.lastValidationTrace ?? [],
    createdAt: partial.createdAt ?? new Date().toISOString(),
    updatedAt: partial.updatedAt ?? new Date().toISOString(),
    notes: partial.notes,
  };
}
