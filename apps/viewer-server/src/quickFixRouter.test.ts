import { describe, expect, it } from 'vitest';

import { matchesQuickFixHeuristics } from './quickFixRouter.js';

describe('quickFixRouter', () => {
  it('matches label quick-fix', () => {
    const res = matchesQuickFixHeuristics({ title: 'Anything', body: 'Long body', labels: ['quick-fix'] });
    expect(res.match).toBe(true);
    expect(res.reasons.join(' ')).toContain('label');
  });

  it('matches title prefixes', () => {
    const res = matchesQuickFixHeuristics({ title: 'fix: small thing', body: 'Long body', labels: [] });
    expect(res.match).toBe(true);
    expect(res.reasons.join(' ')).toContain('title');
  });

  it('matches short body', () => {
    const res = matchesQuickFixHeuristics({ title: 'Normal title', body: 'short', labels: [] });
    expect(res.match).toBe(true);
    expect(res.reasons.join(' ')).toContain('body');
  });

  it('does not match when no heuristics apply', () => {
    const res = matchesQuickFixHeuristics({ title: 'Feature: big change', body: 'x'.repeat(500), labels: ['enhancement'] });
    expect(res.match).toBe(false);
    expect(res.reasons).toEqual([]);
  });
});

