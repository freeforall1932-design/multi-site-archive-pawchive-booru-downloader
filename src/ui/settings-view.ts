/**
 * The options page's view of the settings screen.
 *
 * The markup lives in `settings-sections.ts` (shared with the side panel, which
 * renders the very same sections into its Settings tab); this module is the thin
 * adapter that keeps the options page's state/callback shape.
 */
import type { AdapterCatalogEntry } from '../core/messages.js';
import { renderSettingsSections, type SettingsSectionsCallbacks } from './settings-sections.js';
import { toast } from './toast.js';
import type { ExtensionSettings, ServerConfigView } from '../shared/types.js';

export interface SettingsState {
  settings: ExtensionSettings;
  saving: boolean;
  hostAccess: { origin: string; granted: boolean } | null;
  /** Optional extras (the panel supplies them; the options page fills them too). */
  servers?: ServerConfigView[];
  adapters?: AdapterCatalogEntry[];
  historyCount?: number;
  searchCount?: number;
}

export interface SettingsCallbacks {
  onChange(patch: Partial<ExtensionSettings>): void;
  onSave(): void;
  onReset(): void;
  onRequestHostAccess(): void;
  onExport(includeSecrets: boolean): void;
  onImport(json: string, includeSecrets: boolean): void;
  onClearAllCredentials(): void;
  onSyncUserAgent(): void;
  /** Optional surfaces (the panel wires these; the options page may skip them). */
  onClearHistory?(): void;
  onClearSearches?(): void;
  onOpenServers?(): void;
}

export function renderSettings(container: HTMLElement, state: SettingsState, callbacks: SettingsCallbacks): void {
  const sections: SettingsSectionsCallbacks = {
    onChange: callbacks.onChange,
    onSave: callbacks.onSave,
    onReset: callbacks.onReset,
    onRequestHostAccess: callbacks.onRequestHostAccess,
    onExport: callbacks.onExport,
    onImport: callbacks.onImport,
    onClearAllCredentials: callbacks.onClearAllCredentials,
    onSyncUserAgent: callbacks.onSyncUserAgent,
    // The options page wires these too; the fallbacks keep the shared module
    // usable from any surface that only cares about the core settings.
    onClearHistory: callbacks.onClearHistory ?? (() => {}),
    onClearSearches: callbacks.onClearSearches ?? (() => {}),
    onOpenServers: callbacks.onOpenServers ?? (() => {}),
  };
  renderSettingsSections(
    container,
    {
      settings: state.settings,
      saving: state.saving,
      autoSave: false,
      hostAccess: state.hostAccess,
      servers: state.servers ?? [],
      adapters: state.adapters ?? [],
      historyCount: state.historyCount ?? 0,
      searchCount: state.searchCount ?? 0,
    },
    sections,
  );
}

/** Small confirmation used after a save from the options page. */
export function notifySaved(): void {
  toast('Settings saved', 'success');
}
