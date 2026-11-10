import type { ExtensionSettings, ServerConfig } from '../shared/types.js';
import { effectiveUserAgent, getAdapter } from './registry.js';
import { isUsableServer } from './servers.js';
import { hostOf } from '../shared/util.js';

export interface UserAgentSyncResult {
  ok: boolean;
  applied: number;
  rules: number[];
  error?: string;
}

const RULE_ID_BASE = 10_000;

/**
 * e621 and several Gelbooru-family instances require (or strongly prefer) a
 * descriptive, non-browser User-Agent, but `fetch` cannot set that header from
 * an extension. declarativeNetRequest can, so we mirror the configured
 * User-Agent into dynamic rules - one rule per saved server host.
 */
export function buildUserAgentRules(servers: ServerConfig[], settings: ExtensionSettings) {
  if (!settings.rewriteUserAgent) return [];
  const rules: Array<{ id: number; domains: string[]; userAgent: string; serverId: string }> = [];
  const seen = new Set<string>();
  servers.forEach((server, index) => {
    const adapter = getAdapter(server.siteType);
    if (!adapter || !isUsableServer(server)) return;
    const host = hostOf(server.baseUrl);
    if (!host || seen.has(host)) return;
    const userAgent = effectiveUserAgent(adapter, server);
    if (!userAgent) return;
    seen.add(host);
    rules.push({ id: RULE_ID_BASE + index, domains: [host], userAgent, serverId: server.id });
  });
  return rules;
}

export function isDnrAvailable(): boolean {
  return typeof globalThis.chrome !== 'undefined' && !!globalThis.chrome?.declarativeNetRequest?.updateDynamicRules;
}

/** Push the current ruleset into the browser. Never throws. */
export async function syncUserAgentRules(servers: ServerConfig[], settings: ExtensionSettings): Promise<UserAgentSyncResult> {
  const rules = buildUserAgentRules(servers, settings);
  if (!isDnrAvailable()) {
    return { ok: false, applied: 0, rules: [], error: 'declarativeNetRequest is unavailable in this environment' };
  }
  const dnr = globalThis.chrome!.declarativeNetRequest!;
  try {
    const existing = await dnr.getDynamicRules();
    const removeRuleIds = existing.filter((rule) => rule.id >= RULE_ID_BASE).map((rule) => rule.id);
    const addRules: chrome.declarativeNetRequest.Rule[] = rules.map((rule) => ({
      id: rule.id,
      priority: 1,
      action: {
        type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
        requestHeaders: [
          {
            header: 'user-agent',
            operation: 'set' as chrome.declarativeNetRequest.HeaderOperation,
            value: rule.userAgent,
          },
        ],
      },
      condition: {
        requestDomains: rule.domains,
        resourceTypes: ['xmlhttprequest' as chrome.declarativeNetRequest.ResourceType],
      },
    }));
    await dnr.updateDynamicRules({
      removeRuleIds,
      ...(addRules.length ? { addRules } : {}),
    });
    return { ok: true, applied: addRules.length, rules: rules.map((rule) => rule.id) };
  } catch (error) {
    return { ok: false, applied: 0, rules: [], error: error instanceof Error ? error.message : String(error) };
  }
}
