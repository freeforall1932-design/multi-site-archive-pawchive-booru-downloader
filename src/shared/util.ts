/** Small dependency-free helpers shared across the extension. */

export function createId(prefix = 'srv'): string {
  const rand =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 12)
      : Math.random().toString(36).slice(2, 14);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function toInt(value: unknown, fallback: number): number {
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

export function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

export function uniqueBy<T, K>(values: T[], keyOf: (value: T) => K): T[] {
  const seen = new Set<K>();
  const out: T[] = [];
  for (const value of values) {
    const key = keyOf(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

/** Normalize whitespace and drop empty entries. */
export function splitTags(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .trim()
    .split(/\s+/)
    .filter((tag) => tag.length > 0);
}

export function joinTags(tags: string[]): string {
  return tags.filter(Boolean).join(' ');
}

/** Ensure a base URL is a clean absolute origin(+path) with no trailing slash. */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return '';
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    url.hash = '';
    url.search = '';
    let pathname = url.pathname.replace(/\/+$/, '');
    // Trim common "paste the API URL" mistakes down to the site root.
    pathname = pathname.replace(/\/(index\.php|posts\.json|posts|post)\/?$/i, '');
    url.pathname = pathname;
    return url.toString().replace(/\/+$/, '');
  } catch {
    return trimmed;
  }
}

export function safeUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

export function isValidHttpUrl(raw: string): boolean {
  const url = safeUrl(raw);
  return !!url && (url.protocol === 'http:' || url.protocol === 'https:') && !!url.hostname;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 'never';
  const seconds = Math.round((now - then) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

/** Mask a secret for display: at most an 4-character tail, never the whole value. */
export function maskSecret(secret: string | null | undefined): string {
  const value = (secret ?? '').trim();
  if (!value) return '';
  if (value.length <= 4) return '•'.repeat(value.length);
  return `${'•'.repeat(Math.min(8, value.length - 4))}${value.slice(-4)}`;
}

/**
 * Redact credential-bearing query parameters / headers from a URL so it can be
 * logged or rendered in a diagnostics trace.
 */
const SECRET_KEYS = [
  'api_key',
  'apikey',
  'key',
  'login',
  'password',
  'password_hash',
  'user_id',
  'access_token',
  'token',
  '_client',
  // Hydrus Client API accepts the access key as a query parameter of this name.
  'Hydrus-Client-API-Access-Key',
];

export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    let touched = false;
    const secretNames = new Set(SECRET_KEYS.map((key) => key.toLowerCase()));
    for (const key of [...url.searchParams.keys()]) {
      if (secretNames.has(key.toLowerCase())) {
        url.searchParams.set(key, '***');
        touched = true;
      }
    }
    // Pawchive temporary downloads use `s` as a bearer signature. Do not
    // redact generic `s` parameters globally: booru DAPI uses `s=post`.
    if (/(?:^|\.)pawchive\.(?:pw|st)$/i.test(url.hostname) && url.searchParams.has('s')) {
      url.searchParams.set('s', '***');
      touched = true;
    }
    if (url.username || url.password) {
      url.username = '';
      url.password = '';
      touched = true;
    }
    // Share-link fragments can be bearer/decryption keys. Exported links keep
    // them, but diagnostics and logs must never expose them.
    if (url.hash) {
      url.hash = '#***';
      touched = true;
    }
    return touched ? url.toString() : raw;
  } catch {
    return raw.replace(/([?&](?:api_key|apikey|login|password_hash|token)=)[^&#]*/gi, '$1***').replace(/#.*/, '#***');
  }
}

/** Remove old Hydrus bearer parameters while retaining other URL data and fragments. */
export function stripHydrusCredentials(raw: string): string {
  try {
    const url = new URL(raw);
    let changed = false;
    for (const name of [...url.searchParams.keys()]) {
      if (/^hydrus-client-api-(?:access|session)-key$/i.test(name)) {
        url.searchParams.delete(name);
        changed = true;
      }
    }
    return changed ? url.toString() : raw;
  } catch {
    return raw;
  }
}

/** Redact URL secrets when a browser/network error embeds a URL in free text. */
export function redactUrlsInText(text: string): string {
  return text.replace(/https?:\/\/[^\s<>"'`]+/gi, (url) => redactUrl(url));
}

/** Redact any credential-looking header values. */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = /^(authorization|cookie|x-api-key|api-key|hydrus-client-api-access-key|hydrus-client-api-session-key)$/i.test(key) ? '***' : value;
  }
  return out;
}

/** Escape text for safe interpolation into HTML strings. */
export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ms <= 0) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function hostOf(rawUrl: string): string {
  return safeUrl(rawUrl)?.host ?? '';
}

export function originOf(rawUrl: string): string {
  return safeUrl(rawUrl)?.origin ?? '';
}

/**
 * Match a hostname against shell-ish wildcard patterns (`*.gelbooru.com`).
 * Used for route detection and host permission checks.
 */
export function hostMatchesPattern(host: string, pattern: string): boolean {
  const cleanPattern = pattern.trim().toLowerCase();
  if (!cleanPattern) return false;
  const hostname = host.toLowerCase().split(':')[0] ?? '';
  if (cleanPattern === hostname) return true;
  if (cleanPattern.startsWith('*.')) {
    const suffix = cleanPattern.slice(1); // '.gelbooru.com'
    return hostname.endsWith(suffix) || hostname === cleanPattern.slice(2);
  }
  return false;
}

export function fileExtensionFromUrl(rawUrl: string): string | null {
  const url = safeUrl(rawUrl);
  if (!url) return null;
  const match = /\.([a-z0-9]{1,5})$/i.exec(url.pathname);
  return match?.[1]?.toLowerCase() ?? null;
}

export function deepClone<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch {
      /* fall through */
    }
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
