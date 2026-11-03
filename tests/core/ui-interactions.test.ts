import { afterEach, describe, expect, it, vi } from 'vitest';
import { preserveInputFocus } from '../../src/ui/dom.js';
import { OrderedUpdates } from '../../src/ui/ordered-updates.js';

afterEach(() => vi.unstubAllGlobals());

function focusFixture() {
  const listeners = new Map<string, (event: { target: unknown }) => void>();
  const document = {
    activeElement: null as ReturnType<typeof input> | null,
    addEventListener(type: string, listener: (event: { target: unknown }) => void) { listeners.set(type, listener); },
  };
  function input(id: string, name = '') {
    return {
      tagName: 'INPUT', id, type: 'text', value: 'typed value', disabled: false, isConnected: true,
      selectionStart: 2 as number | null, selectionEnd: 4 as number | null,
      selectionDirection: 'forward' as const, scrollLeft: 17,
      matches: () => true,
      getAttribute: (attribute: string) => attribute === 'name' ? name || null : attribute === 'type' ? 'text' : null,
      focus: vi.fn(() => { document.activeElement = current; }),
      addEventListener: vi.fn((_type: string, _listener: () => void, _options?: unknown) => {}),
      setSelectionRange: vi.fn(),
    };
  }
  let current = input('field');
  document.activeElement = current;
  const container = {
    ownerDocument: document,
    contains: (element: unknown) => element === current,
    querySelectorAll: () => [current],
  } as unknown as HTMLElement;
  vi.stubGlobal('document', document);
  return {
    document, container, listeners,
    get current() { return current; },
    replace(id = 'field', name = '') { current = input(id, name); return current; },
  };
}

describe('live editor focus', () => {
  it('restores a focused input and its selection after replacement', () => {
    const fixture = focusFixture();
    let next: ReturnType<typeof fixture.replace> | undefined;
    preserveInputFocus(fixture.container, () => { next = fixture.replace(); });
    expect(next?.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(next?.setSelectionRange).toHaveBeenCalledWith(2, 4, 'forward');
    expect(next?.scrollLeft).toBe(17);
  });

  it('keeps an incomplete value during editing and shows the confirmed value on blur', async () => {
    const fixture = focusFixture();
    fixture.current.value = 'mydrive.';
    let next: ReturnType<typeof fixture.replace> | undefined;
    preserveInputFocus(fixture.container, () => { next = fixture.replace(); next.value = ''; });
    expect(next?.value).toBe('mydrive.');
    const listener = next!.addEventListener.mock.calls[0]![1] as () => void;
    fixture.document.activeElement = null;
    listener();
    await Promise.resolve();
    expect(next?.value).toBe('');
  });

  it('does not steal focus if the field disappeared or focus was outside', () => {
    const fixture = focusFixture();
    let other: ReturnType<typeof fixture.replace> | undefined;
    preserveInputFocus(fixture.container, () => { other = fixture.replace('other'); });
    expect(other?.focus).not.toHaveBeenCalled();
    fixture.document.activeElement = null;
    preserveInputFocus(fixture.container, () => { other = fixture.replace('field'); });
    expect(other?.focus).not.toHaveBeenCalled();
  });

  it('defers replacement while composing and drops a stale deferred render', async () => {
    const fixture = focusFixture();
    preserveInputFocus(fixture.container, () => {}); // install composition listeners
    const old = fixture.current;
    fixture.listeners.get('compositionstart')!({ target: old });
    const stale = vi.fn();
    preserveInputFocus(fixture.container, stale);
    expect(stale).not.toHaveBeenCalled();
    fixture.listeners.get('compositionend')!({ target: old });
    const final = vi.fn(() => fixture.replace());
    preserveInputFocus(fixture.container, final); // final input after compositionend
    await Promise.resolve();
    expect(final).toHaveBeenCalledOnce();
    expect(stale).not.toHaveBeenCalled();
  });

  it('renders the most recent deferred edit when composition ends without another input', async () => {
    const fixture = focusFixture();
    preserveInputFocus(fixture.container, () => {});
    const old = fixture.current;
    fixture.listeners.get('compositionstart')!({ target: old });
    const first = vi.fn();
    const last = vi.fn(() => fixture.replace());
    preserveInputFocus(fixture.container, first);
    preserveInputFocus(fixture.container, last);
    fixture.listeners.get('compositionend')!({ target: old });
    await Promise.resolve();
    expect(first).not.toHaveBeenCalled();
    expect(last).toHaveBeenCalledOnce();
  });
});

describe('ordered settings edits', () => {
  it('serializes writes and does not apply an older result over a newer edit', async () => {
    const updates = new OrderedUpdates();
    let release!: (value: string) => void;
    const calls: string[] = [];
    const applied: string[] = [];
    const first = updates.run(() => {
      calls.push('first');
      return new Promise<string>((resolve) => { release = resolve; });
    }, (value, isLatest) => { if (isLatest()) applied.push(value); });
    const second = updates.run(async () => { calls.push('second'); return 'latest'; },
      (value, isLatest) => { if (isLatest()) applied.push(value); });
    await Promise.resolve();
    expect(calls).toEqual(['first']);
    release('stale');
    await Promise.all([first, second]);
    expect(calls).toEqual(['first', 'second']);
    expect(applied).toEqual(['latest']);
  });

  it('allows the next edit after a rejected write', async () => {
    const updates = new OrderedUpdates();
    const failed = updates.run(async () => { throw new Error('storage failed'); }, () => {});
    const applied: number[] = [];
    const next = updates.run(async () => 2, (value, isLatest) => { if (isLatest()) applied.push(value); });
    await expect(failed).rejects.toThrow('storage failed');
    await next;
    expect(applied).toEqual([2]);
  });
});
