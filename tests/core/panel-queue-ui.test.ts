import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHeadlessPlatform, installPlatform } from '../../src/platform/index.js';
import type { Platform } from '../../src/platform/types.js';
import type { QueueItem, QueueSummary, ServerConfigView } from '../../src/shared/types.js';
import { renderQueueList, type QueueListCallbacks, type QueueRowView } from '../../src/ui/panel-queue.js';

class Element {
  children: Element[] = [];
  attrs: Record<string, string> = {};
  dataset: Record<string, string> = {};
  className = '';
  textContent = '';
  src = '';
  title = '';
  isConnected = true;
  classList = { add: vi.fn() };
  constructor(readonly tagName: string) {}
  appendChild(child: Element) { this.children.push(child); return child; }
  replaceChildren(...children: Element[]) { this.children = children; }
  setAttribute(key: string, value: string) { this.attrs[key] = value; }
  addEventListener() {}
  dispatchEvent() { return true; }
}

const callbacks: QueueListCallbacks = {
  onToggleRow() {}, onSelectAll() {}, onInvert() {}, onRemoveSelected() {}, onRemoveRow() {},
  onCancelRow() {}, onRetryFailed() {}, onClearFinished() {}, onResetHistory() {}, onClearList() {}, onOpenPost() {},
};
const summary: QueueSummary = { pending: 1, running: 0, done: 0, failed: 0, skipped: 0, canceled: 0, unverified: 0, total: 1, paused: false, active: false };
const item: QueueItem = {
  id: 'queue-1', serverId: 'hydrus-server', postId: '42', label: 'post 42', postUrl: 'http://localhost:45869/get_files/file?file_id=42',
  status: 'pending', rating: null, attempts: 0, error: null, errorKind: null, filename: null, bytes: null, createdAt: '', updatedAt: '',
};
const hydrus = { id: 'hydrus-server', siteType: 'hydrus', baseUrl: 'http://localhost:45869' } as ServerConfigView;
function row(overrides: Partial<QueueRowView> = {}): QueueRowView {
  return { item, server: hydrus, selected: true, savedFilename: null, thumbnail: '', media: 'image', rating: null, ...overrides };
}
function descendants(element: Element): Element[] {
  return [element, ...element.children.flatMap(descendants)];
}
function setup() {
  vi.stubGlobal('document', {
    createElement: (tag: string) => new Element(tag),
    createTextNode: (text: string) => Object.assign(new Element('#text'), { textContent: text }),
  });
  vi.stubGlobal('IntersectionObserver', undefined);
  const headless = createHeadlessPlatform();
  const send = vi.fn(async () => ({ ok: true as const, data: { dataUrl: 'data:image/png;base64,iVBORw==' } }));
  const platform: Platform = {
    environment: 'extension', storage: headless.storage, downloader: headless.downloader,
    permissions: headless.permissions, send, syncUserAgentRules: headless.syncUserAgentRules.bind(headless),
    activeTabUrl: headless.activeTabUrl.bind(headless), openOptions: headless.openOptions.bind(headless),
    openPanel: headless.openPanel.bind(headless), describeEnvironment: headless.describeEnvironment.bind(headless),
  };
  installPlatform(platform);
  return { send, container: new Element('div') };
}
function render(container: Element, rows: QueueRowView[], showThumbnails: boolean) {
  renderQueueList(container as unknown as HTMLElement, { summary, rows, hiddenRows: 0, filteredRows: 0, showThumbnails, busy: false }, callbacks);
}

afterEach(() => { vi.unstubAllGlobals(); installPlatform(createHeadlessPlatform()); });

describe('queue thumbnails and missing profiles', () => {
  it('does not create or request a Hydrus thumbnail when thumbnails are disabled', async () => {
    const { send, container } = setup();
    render(container, [row()], false);
    await Promise.resolve();
    expect(descendants(container).filter((element) => element.tagName === 'img')).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('requests a Hydrus thumbnail only for a post row, using IDs', async () => {
    const { send, container } = setup();
    render(container, [row()], true);
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    expect(send).toHaveBeenCalledWith({ type: 'posts/thumbnail', payload: { serverId: 'hydrus-server', postId: '42' } });
    expect(descendants(container).some((element) => element.tagName === 'a')).toBe(false);
  });

  it('does not treat mirror-link rows as Hydrus images or post links', async () => {
    const { send, container } = setup();
    render(container, [row({ item: { ...item, kind: 'link', url: 'https://example.org/file.zip' }, thumbnail: 'https://example.org/thumb.png', linkHeadline: 'file.zip' })], true);
    await Promise.resolve();
    expect(send).not.toHaveBeenCalled();
    expect(descendants(container).some((element) => element.tagName === 'img' || element.tagName === 'a')).toBe(false);
  });

  it('shows a placeholder and warning instead of loading/opening a post whose profile is missing', async () => {
    const { send, container } = setup();
    render(container, [row({ server: null, thumbnail: 'http://localhost:45869/get_files/thumbnail?file_id=42' })], true);
    await Promise.resolve();
    const all = descendants(container);
    expect(all.some((element) => element.textContent === 'profile missing')).toBe(true);
    expect(all.some((element) => element.className.includes('psThumbEmpty'))).toBe(true);
    expect(all.some((element) => element.tagName === 'img' || element.tagName === 'a')).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
});
