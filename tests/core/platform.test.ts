import { describe, expect, it, vi } from 'vitest';
import { ExtensionPlatform } from '../../src/platform/extension.js';

describe('extension message transport', () => {
  it('does not replay a download after its worker response is lost', async () => {
    const sendMessage = vi.fn()
      .mockRejectedValueOnce(new Error('The message port closed before a response was received'))
      .mockResolvedValue({ ok: true, data: {} });
    vi.stubGlobal('chrome', { runtime: { id: 'test-extension', sendMessage } });
    try {
      const response = await new ExtensionPlatform().send({ type: 'posts/download', payload: { postId: '123' } });
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(response.ok).toBe(false);
      if (!response.ok) expect(`${response.error.message} ${response.error.hint}`).toMatch(/check.*(queue|download)/i);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reports an uncertain outcome for any rejected mutation response', async () => {
    const sendMessage = vi.fn().mockRejectedValue(new Error('Unexpected transport error'));
    vi.stubGlobal('chrome', { runtime: { id: 'test-extension', sendMessage } });
    try {
      const response = await new ExtensionPlatform().send({ type: 'posts/download', payload: { postId: '123' } });
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(response.ok).toBe(false);
      if (!response.ok) expect(`${response.error.message} ${response.error.hint}`).toMatch(/check.*(queue|download)/i);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('opens the requested manager deep link without racing a new options tab', () => {
    const create = vi.fn().mockResolvedValue({});
    const openOptionsPage = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('chrome', {
      runtime: { id: 'test-extension', getURL: (path: string) => `chrome-extension://test-extension/${path}`, openOptionsPage },
      tabs: { create },
    });
    try {
      new ExtensionPlatform().openOptions('#queue');
      expect(create).toHaveBeenCalledWith({ url: 'chrome-extension://test-extension/options/options.html#queue' });
      expect(openOptionsPage).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('may retry a read-only request when a cold worker drops its first response', async () => {
    const sendMessage = vi.fn()
      .mockRejectedValueOnce(new Error('Could not establish connection. Receiving end does not exist.'))
      .mockResolvedValue({ ok: true, data: { uiMode: 'sidepanel' } });
    vi.stubGlobal('chrome', { runtime: { id: 'test-extension', sendMessage } });
    try {
      const response = await new ExtensionPlatform().send({ type: 'settings/get' });
      expect(sendMessage).toHaveBeenCalledTimes(2);
      expect(response.ok).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
