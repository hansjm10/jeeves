import { describe, expect, it } from 'vitest';

import { noop } from './index';

describe('noop', () => {
  it('does not throw', () => {
    expect(() => noop()).not.toThrow();
  });
});
