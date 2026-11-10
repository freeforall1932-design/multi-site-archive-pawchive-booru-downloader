import type { ServerConfig } from '../shared/types.js';

/** Pawchive's metadata request budget is shared across all saved profiles. */
export function requestRateKey(server: Pick<ServerConfig, 'id' | 'siteType'>): string {
  return server.siteType === 'pawchive' ? 'site:pawchive' : `server:${server.id}`;
}
