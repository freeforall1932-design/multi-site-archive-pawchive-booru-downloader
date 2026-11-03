import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHeadlessPlatform, installPlatform } from '../../src/platform/index.js';
import { postImage } from '../../src/ui/post-image.js';
import type { Platform } from '../../src/platform/types.js';

interface FakeImage {
  isConnected: boolean;
  src: string;
  title: string;
  attrs: Record<string, string>;
  setAttribute(name: string, value: string): void;
  addEventListener(): void;
  dispatchEvent(event: Event): boolean;
}

function fakeImage(): FakeImage {
  return {
    isConnected: true, src: '', title: '', attrs: {},
    setAttribute(name, value) { this.attrs[name] = value; },
    addEventListener() {}, dispatchEvent() { return true; },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  installPlatform(createHeadlessPlatform());
});

describe('Hydrus thumbnail UI', () => {
  it('loads only when visible and messages only server/file IDs, not a key or arbitrary URL', async () => {
    const image = fakeImage();
    vi.stubGlobal('document', { createElement: () => image });
    let observe: ((entries: Array<{ target: FakeImage; isIntersecting: boolean }>, observer: { unobserve(): void }) => void) | undefined;
    const unobserve = vi.fn();
    class FakeObserver {
      constructor(callback: typeof observe) { observe = callback; }
      observe() {}
      unobserve = unobserve;
    }
    vi.stubGlobal('IntersectionObserver', FakeObserver);
    const headless = createHeadlessPlatform();
    const send = vi.fn(async () => ({ ok: true as const, data: { dataUrl: 'data:image/png;base64,iVBORw==' } }));
    const platform: Platform = {
      environment: 'extension', storage: headless.storage, downloader: headless.downloader,
      permissions: headless.permissions, send, syncUserAgentRules: headless.syncUserAgentRules.bind(headless),
      activeTabUrl: headless.activeTabUrl.bind(headless), openOptions: headless.openOptions.bind(headless),
      openPanel: headless.openPanel.bind(headless), describeEnvironment: headless.describeEnvironment.bind(headless),
    };
    installPlatform(platform);
    postImage({ siteType: 'hydrus', serverId: 'ui-test-server', id: '42', previewUrl: 'http://localhost/key-must-not-be-used' }, { alt: 'preview' });
    await Promise.resolve();
    expect(image.attrs.src).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
    observe!([{ target: image, isIntersecting: true }], { unobserve });
    await vi.waitFor(() => expect(image.src).toBe('data:image/png;base64,iVBORw=='));
    expect(send).toHaveBeenCalledWith({ type: 'posts/thumbnail', payload: { serverId: 'ui-test-server', postId: '42' } });
    expect(JSON.stringify(send.mock.calls)).not.toContain('key-must-not-be-used');
    expect(unobserve).toHaveBeenCalled();
  });
});
