import { describe, expect, it, vi } from 'vitest';

describe('post-page content button', () => {
  it('recovers from a lost response without claiming failure or starting again', async () => {
    const elements: Array<{
      tag: string;
      style: { cssText: string };
      textContent: string;
      title: string;
      type: string;
      className: string;
      hidden: boolean;
      disabled: boolean;
      listener?: () => Promise<void>;
      addEventListener: (name: string, listener: () => Promise<void>) => void;
      attachShadow: () => { append: (...children: unknown[]) => void };
    }> = [];
    const createElement = (tag: string) => {
      const element = {
        tag, style: { cssText: '' }, textContent: '', title: '', type: '', className: '', hidden: false, disabled: false,
        listener: undefined as (() => Promise<void>) | undefined,
        addEventListener(_name: string, listener: () => Promise<void>) { this.listener = listener; },
        attachShadow: () => ({ append: (..._children: unknown[]) => undefined }),
      };
      elements.push(element);
      return element;
    };
    const sendMessage = vi.fn()
      .mockResolvedValueOnce({ ok: true, data: { enableContentScriptButton: true } })
      .mockResolvedValueOnce({ ok: true, data: { siteType: 'e621', kind: 'post', postId: '1', server: null } })
      .mockRejectedValueOnce(new Error('message port closed'));
    vi.stubGlobal('document', { getElementById: () => null, createElement, body: { appendChild: () => undefined } });
    vi.stubGlobal('location', { href: 'https://e621.net/posts/1' });
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    try {
      await import('../../src/content/post-button.js');
      await vi.waitFor(() => expect(elements.find((entry) => entry.tag === 'button')?.listener).toBeDefined());
      const button = elements.find((entry) => entry.tag === 'button')!;
      const status = elements.find((entry) => entry.className === 'status')!;
      await button.listener!();
      expect(button.disabled).toBe(false);
      expect(button.textContent).toMatch(/check download/i);
      expect(status.textContent).toMatch(/check.*queue.*Chrome Downloads/i);
      expect(sendMessage).toHaveBeenCalledTimes(3);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
