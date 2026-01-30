import { describe, expect, it } from 'vitest';

import { evaluateGuard } from './guards.js';

describe('evaluateGuard', () => {
  it('supports == and != against nested paths', () => {
    const ctx = { status: { reviewClean: true, count: 3 } };
    expect(evaluateGuard('status.reviewClean == true', ctx)).toBe(true);
    expect(evaluateGuard('status.reviewClean != true', ctx)).toBe(false);
    expect(evaluateGuard('status.count == 3', ctx)).toBe(true);
    expect(evaluateGuard('status.count != 3', ctx)).toBe(false);
  });

  it('supports and/or with and binding tighter than or', () => {
    const ctx = { status: { a: false, b: true, c: false } };
    expect(evaluateGuard('status.a == true or status.b == true and status.c == true', ctx)).toBe(false);
    expect(evaluateGuard('status.a == true or status.b == true and status.c == false', ctx)).toBe(true);
  });

  it('treats bare paths as truthy checks', () => {
    const ctx = { status: { ok: 'yes', empty: '' } };
    expect(evaluateGuard('status.ok', ctx)).toBe(true);
    expect(evaluateGuard('status.empty', ctx)).toBe(false);
    expect(evaluateGuard('status.missing', ctx)).toBe(false);
  });
});
