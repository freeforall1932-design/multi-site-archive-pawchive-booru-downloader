import { BooruError } from '../shared/errors.js';
import type { HttpClient, HttpResponseSnapshot, HttpRequestSpec } from '../shared/http.js';
import type {
  AccountInfo,
  ExtensionSettings,
  ProbeTraceEntry,
  ServerConfig,
  ValidationKind,
  ValidationResult,
} from '../shared/types.js';
import { isValidHttpUrl, safeUrl } from '../shared/util.js';
import type { CredentialField, ProbeInterpretation, ValidationProbe } from './adapter.js';
import { createAdapterContext, getAdapter } from './registry.js';
import { requestRateKey } from './request-policy.js';

const BROWSER_UA = /mozilla|chrome\/|safari\/|firefox\/|edge\//i;

export interface ValidationServiceOptions {
  probeTimeoutMs?: number;
}

export interface ValidationProgress {
  (event: { probeId: string; label: string; ok: boolean; message: string }): void;
}

/**
 * Shared validation service.
 *
 * Layers, in order:
 *  1. Local preflight (site type registered, URL parseable, required credential
 *     fields present, User-Agent policy) - no network traffic.
 *  2. Endpoint probes: "does this URL speak the expected API?"
 *  3. Auth probes: "are these credentials accepted?"
 *
 * Each layer reports the shared failure taxonomy (auth / endpoint / rate-limit &
 * network / unsupported site) so the UI can render them differently.
 */
export class ValidationService {
  private readonly probeTimeoutMs: number;

  constructor(private readonly http: HttpClient, options: ValidationServiceOptions = {}) {
    this.probeTimeoutMs = options.probeTimeoutMs ?? 20_000;
  }

  /** Validate a saved profile by id-less config (works for unsaved drafts too). */
  async validate(
    server: ServerConfig,
    settings: ExtensionSettings,
    onProgress?: ValidationProgress,
  ): Promise<ValidationResult> {
    const startedAt = Date.now();
    const checkedAt = new Date().toISOString();
    const trace: ProbeTraceEntry[] = [];
    const warnings: string[] = [];

    const finish = (partial: Partial<ValidationResult> & { kind: ValidationKind; ok: boolean; message: string }): ValidationResult => {
      const result: ValidationResult = {
        kind: partial.kind,
        ok: partial.ok,
        endpointOk: partial.endpointOk ?? null,
        authOk: partial.authOk ?? null,
        message: partial.message,
        warnings: [...warnings, ...(partial.warnings ?? [])],
        account: partial.account ?? null,
        checkedAt,
        httpStatus: partial.httpStatus ?? null,
        durationMs: Date.now() - startedAt,
        trace,
      };
      return result;
    };

    // ------------------------------------------------------------ preflight
    const adapter = getAdapter(server.siteType);
    if (!adapter) {
      return finish({
        kind: 'unsupported-site',
        ok: false,
        message: `No adapter is registered for site type "${server.siteType}"`,
        warnings: ['Register an adapter for this site type, or choose one of the supported types.'],
      });
    }
    if (!isValidHttpUrl(server.baseUrl)) {
      return finish({
        kind: 'incomplete-config',
        ok: false,
        message: 'The base URL is empty or not a valid http(s) URL',
        warnings: ['Enter something like https://e621.net.'],
      });
    }
    const parsedBase = safeUrl(server.baseUrl);
    if (parsedBase?.username || parsedBase?.password) {
      return finish({
        kind: 'incomplete-config', ok: false,
        message: 'The server URL contains embedded credentials.',
        warnings: ['Remove user information from the URL and use the profile credential fields instead.'],
      });
    }
    const loopback = parsedBase ? ['127.0.0.1', 'localhost', '[::1]'].includes(parsedBase.hostname) : false;
    if (parsedBase?.protocol === 'http:' && !loopback) {
      warnings.push('The base URL uses plain HTTP; credentials would travel unencrypted.');
    }

    const missing = this.missingCredentialFields(server, adapter.credentialFields(server));
    if (missing.length) {
      return finish({
        kind: 'incomplete-config',
        ok: false,
        message: `Missing required field(s): ${missing.join(', ')}`,
        warnings: ['Fill in the required fields, then validate again.'],
      });
    }

    const hasCredentials = this.hasCredentials(server, adapter.capabilities.authStyle);
    if (!hasCredentials) {
      warnings.push('No credentials saved - validating read-only access only.');
    }

    let ctx: ReturnType<typeof createAdapterContext>;
    try {
      ctx = createAdapterContext(adapter, server, settings);
    } catch (error) {
      const failure = error instanceof BooruError ? error : null;
      return finish({
        kind: failure?.kind ?? 'incomplete-config',
        ok: false,
        message: failure?.message ?? 'The server URL could not be normalized',
        warnings: failure?.hint ? [failure.hint] : [],
      });
    }
    if (adapter.capabilities.requiresUserAgent && !server.customUserAgent.trim()) {
      warnings.push(`Using the generated User-Agent "${ctx.userAgent}" - add your own for the site's policy.`);
    }
    if (adapter.capabilities.requiresUserAgent && BROWSER_UA.test(ctx.userAgent)) {
      warnings.push('The configured User-Agent looks like a browser UA, which these sites block. Use a descriptive one.');
    }

    let probes: ValidationProbe[];
    try {
      probes = adapter.buildValidationProbes(ctx);
    } catch (error) {
      const booruError = error instanceof BooruError ? error : null;
      return finish({
        kind: booruError?.kind ?? 'unknown',
        ok: false,
        message: booruError?.message ?? 'Could not build validation requests for this site type',
      });
    }

    // Validation shares the same site/server budget and attempt setting as
    // searches and post lookups. Otherwise probing can bypass rate limits.
    const policy = {
      rateKey: requestRateKey(server),
      minIntervalMs: Math.max(settings.minRequestIntervalMs, adapter.capabilities.minRequestIntervalMs),
      maxAttempts: settings.maxRetries,
    };

    // -------------------------------------------------------- endpoint probes
    const endpointProbes = probes.filter((probe) => probe.purpose === 'endpoint' && probe.enabled !== false);
    if (!endpointProbes.length) {
      warnings.push('This adapter declares no endpoint probe.');
    }
    let endpointOk: boolean | null = endpointProbes.length ? false : null;
    let endpointFailure: ProbeInterpretation | null = null;
    let lastStatus: number | null = null;

    for (const probe of endpointProbes) {
      const outcome = await this.runProbe(probe, trace, policy);
      lastStatus = outcome.snapshot?.status ?? null;
      onProgress?.({ probeId: probe.id, label: probe.label, ok: outcome.interpretation.ok, message: outcome.interpretation.message });
      if (outcome.interpretation.ok) {
        endpointOk = true;
        break;
      }
      endpointFailure = outcome.interpretation;
      if (probe.optional) continue;
      break;
    }

    if (endpointOk === false && endpointFailure) {
      return finish({
        kind: endpointFailure.kind,
        ok: false,
        endpointOk: false,
        authOk: null,
        message: endpointFailure.message,
        warnings: endpointFailure.warnings ?? [],
        httpStatus: lastStatus,
      });
    }

    // ------------------------------------------------------------ auth probes
    const authProbes = probes.filter((probe) => probe.purpose === 'auth' && probe.enabled !== false);
    let authOk: boolean | null = null;
    let account: AccountInfo | null = null;
    let authFailure: ProbeInterpretation | null = null;

    for (const probe of authProbes) {
      const outcome = await this.runProbe(probe, trace, policy);
      lastStatus = outcome.snapshot?.status ?? lastStatus;
      onProgress?.({ probeId: probe.id, label: probe.label, ok: outcome.interpretation.ok, message: outcome.interpretation.message });
      if (outcome.interpretation.ok) {
        authOk = true;
        account = outcome.interpretation.account ?? null;
        authFailure = null;
        break;
      }
      const interpretation = outcome.interpretation;
      const unavailableProbe = probe.optional && (outcome.snapshot?.status === 404 || outcome.snapshot?.status === 405);
      if (!unavailableProbe) {
        // Authentication failures and blocks stop the chain; other problems try
        // the next candidate probe before giving up.
        authFailure = interpretation;
        if (interpretation.kind === 'auth-failure' || interpretation.kind === 'blocked' || interpretation.kind === 'rate-limited') break;
        authOk = false;
        break;
      }
      warnings.push(`${probe.label}: not available on this instance (HTTP ${outcome.snapshot?.status ?? '—'}), trying the next check.`);
    }

    if (authProbes.length === 0) {
      return finish({
        kind: 'ok',
        ok: true,
        endpointOk,
        authOk: null,
        message: 'Endpoint verified. No credentials were supplied, so read-only access was checked.',
        httpStatus: lastStatus,
      });
    }

    if (authFailure) {
      return finish({
        kind: authFailure.kind,
        ok: false,
        endpointOk,
        authOk: false,
        message: authFailure.message,
        warnings: authFailure.warnings ?? [],
        httpStatus: lastStatus,
      });
    }

    return finish({
      kind: 'ok',
      ok: true,
      endpointOk,
      authOk,
      message: account?.username ? `Endpoint and credentials OK - signed in as ${account.username}` : 'Endpoint and credentials OK',
      account,
      httpStatus: lastStatus,
    });
  }

  private async runProbe(
    probe: ValidationProbe,
    trace: ProbeTraceEntry[],
    policy: { rateKey: string; minIntervalMs: number; maxAttempts: number },
  ): Promise<{ snapshot: HttpResponseSnapshot | null; interpretation: ProbeInterpretation }> {
    const request: HttpRequestSpec = { ...probe.request, timeoutMs: this.probeTimeoutMs };
    let snapshot: HttpResponseSnapshot | null = null;
    let interpretation: ProbeInterpretation;
    try {
      snapshot = await this.http.request(request, policy);
      interpretation = probe.interpret(snapshot);
    } catch (error) {
      const booruError = error instanceof BooruError ? error : null;
      interpretation = {
        ok: false,
        kind: booruError?.kind ?? 'network-failure',
        message: booruError?.message ?? 'Network request failed',
        warnings: booruError?.hint ? [booruError.hint] : [],
      };
    }
    trace.push({
      id: probe.id,
      label: probe.label,
      purpose: probe.purpose,
      requestUrl: snapshot?.redactedUrl ?? redactFallback(probe.request.url),
      method: probe.request.method ?? 'GET',
      status: snapshot?.status ?? null,
      ok: interpretation.ok,
      durationMs: snapshot?.durationMs ?? 0,
      message: interpretation.message,
      kind: interpretation.kind,
    });
    return { snapshot, interpretation };
  }

  private hasCredentials(server: ServerConfig, authStyle: string): boolean {
    if (authStyle === 'query-with-userid') return !!(server.apiKey || server.userId);
    if (authStyle === 'header' || authStyle === 'query') return !!server.apiKey;
    return !!(server.apiKey && (server.username || server.userId));
  }

  /**
   * Static field requirements: a field marked `required` must always be present,
   * while `requiredForAuth` only matters once the profile collects credentials.
   */
  private missingCredentialFields(server: ServerConfig, fields: CredentialField[]): string[] {
    const collectsCredentials = !!(server.apiKey || server.userId || server.username);
    const missing: string[] = [];
    for (const field of fields ?? []) {
      const value = String(server[field.key as keyof ServerConfig] ?? '').trim();
      if (field.required && !value) missing.push(field.label);
      else if (field.requiredForAuth && collectsCredentials && !value) missing.push(field.label);
    }
    return missing;
  }
}

function redactFallback(url: string): string {
  try {
    const parsed = new URL(url);
    for (const key of ['api_key', 'login', 'password_hash', 'user_id']) {
      if (parsed.searchParams.has(key)) parsed.searchParams.set(key, '***');
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

/** Convenience helper for callers that only need a boolean. */
export function isValidationOk(result: ValidationResult): boolean {
  return result.ok && result.kind === 'ok';
}
