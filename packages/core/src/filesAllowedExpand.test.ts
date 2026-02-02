import { describe, expect, it } from 'vitest';

import { expandFilesAllowedForTests } from './filesAllowedExpand.js';

describe('expandFilesAllowedForTests', () => {
  it('adds same-dir and __tests__ variants for exact source files', () => {
    const out = expandFilesAllowedForTests(['packages/runner/src/issueExpand.ts']);
    expect(out).toContain('packages/runner/src/issueExpand.ts');
    expect(out).toContain('packages/runner/src/issueExpand.test.ts');
    expect(out).toContain('packages/runner/src/issueExpand.test.tsx');
    expect(out).toContain('packages/runner/src/__tests__/issueExpand.ts');
    expect(out).toContain('packages/runner/src/__tests__/issueExpand.test.ts');
    expect(out).toContain('packages/runner/src/__tests__/issueExpand.test.tsx');
  });

  it('adds cross-extension test variants for .tsx sources', () => {
    const out = expandFilesAllowedForTests(['apps/viewer/src/ui/LogPanel.tsx']);
    expect(out).toContain('apps/viewer/src/ui/LogPanel.test.ts');
    expect(out).toContain('apps/viewer/src/ui/LogPanel.test.tsx');
  });

  it('expands glob patterns without creating invalid dot sequences', () => {
    const out = expandFilesAllowedForTests(['apps/viewer/src/ui/*.ts', 'apps/viewer/src/stream/**/*.ts']);
    expect(out).toContain('apps/viewer/src/ui/*.test.ts');
    expect(out).toContain('apps/viewer/src/ui/*.test.tsx');
    expect(out).toContain('apps/viewer/src/ui/__tests__/*.ts');
    expect(out).toContain('apps/viewer/src/ui/__tests__/*.test.ts');
    expect(out).toContain('apps/viewer/src/stream/**/*.test.ts');
    expect(out).toContain('apps/viewer/src/stream/**/__tests__/*.ts');
  });

  it('does not expand patterns that already look like test files', () => {
    const out = expandFilesAllowedForTests(['src/foo.test.ts', 'src/__tests__/bar.test.ts']);
    expect(out).toEqual(['src/foo.test.ts', 'src/__tests__/bar.test.ts']);
  });

  it('is idempotent', () => {
    const once = expandFilesAllowedForTests(['src/foo.ts']);
    const twice = expandFilesAllowedForTests(once);
    expect(twice).toEqual(once);
  });
});

