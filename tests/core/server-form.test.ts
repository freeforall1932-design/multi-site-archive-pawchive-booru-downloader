import { describe, expect, it } from 'vitest';
import { createHarness } from '../helpers.js';
import type { DiagnosticsInfo } from '../../src/core/messages.js';
import { draftForSiteType, draftSaveDecision, draftValidationSignature, withSiteDefaults } from '../../src/ui/server-form.js';

describe('server form connection snapshots', () => {
  it('invalidates the signature for connection edits but not labels or ratings', async () => {
    const harness = createHarness();
    const response = await harness.router({ type: 'diagnostics/info' });
    if (!response.ok) throw new Error(response.error.message);
    const adapters = (response.data as DiagnosticsInfo).adapters;
    const draft = { ...draftForSiteType('e621', adapters), apiKey: 'a', username: 'user' };
    const snapshot = draftValidationSignature(draft);
    expect(draftValidationSignature({ ...draft, label: 'Another label' })).toBe(snapshot);
    for (const patch of [
      { siteType: 'hydrus' }, { baseUrl: 'https://other.example' }, { apiKey: 'b' },
      { username: 'other' }, { userId: 'other' }, { customUserAgent: 'custom' },
    ]) {
      expect(draftValidationSignature({ ...draft, ...patch })).not.toBe(snapshot);
    }
  });

  it('requires a current successful validation or an explicit override when editing', async () => {
    const response = await createHarness().router({ type: 'diagnostics/info' });
    if (!response.ok) throw new Error(response.error.message);
    const draft = draftForSiteType('e621', (response.data as DiagnosticsInfo).adapters);
    const signature = draftValidationSignature(draft);
    const ok = { ok: true } as import('../../src/shared/types.js').ValidationResult;
    const failed = { ok: false } as import('../../src/shared/types.js').ValidationResult;
    const editor = { draft, isNew: false, validation: null, validatedSignature: null };
    expect(draftSaveDecision(editor, false)).toBe('validate');
    expect(draftSaveDecision({ ...editor, validation: ok, validatedSignature: signature }, false)).toBe('save');
    expect(draftSaveDecision({ ...editor, validation: ok, validatedSignature: 'stale' }, false)).toBe('validate');
    expect(draftSaveDecision({ ...editor, validation: failed, validatedSignature: signature }, false)).toBe('blocked');
    expect(draftSaveDecision({ ...editor, validation: failed, validatedSignature: signature }, true)).toBe('save');
    expect(draftSaveDecision({ ...editor, isNew: true }, false)).toBe('save');
    expect(draftSaveDecision({ ...editor, isNew: true, validation: failed, validatedSignature: signature }, false)).toBe('blocked');
  });

  it('resets target and credentials to adapter defaults on a family switch', async () => {
    const response = await createHarness().router({ type: 'diagnostics/info' });
    if (!response.ok) throw new Error(response.error.message);
    const adapters = (response.data as DiagnosticsInfo).adapters;
    const e621 = { ...draftForSiteType('e621', adapters), username: 'u', apiKey: 'key', userId: '123', customUserAgent: 'ua' };
    const hydrus = withSiteDefaults(e621, 'hydrus', adapters);
    expect(hydrus.baseUrl).toBe('http://127.0.0.1:45869');
    expect(hydrus).toMatchObject({ siteType: 'hydrus', username: '', apiKey: '', userId: '', customUserAgent: '' });
    expect(hydrus.ratingFilterEnabled).toBe(false);
  });
});
