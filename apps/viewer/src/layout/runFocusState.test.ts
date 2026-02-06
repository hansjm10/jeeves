import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  RUN_OVERRIDE_STORAGE_KEY,
  parseRunOverride,
  readRunOverride,
  writeRunOverride,
  clearRunOverride,
  type RunOverride,
} from './runFocusState.js';

/**
 * Tests for run-focus sidebar override storage primitives.
 *
 * Acceptance criteria (T1):
 * 1. Only exact "auto" and "open" values are accepted; all others resolve to "auto".
 * 2. Storage read/write helpers never throw when localStorage is unavailable or blocked.
 * 3. Helper exports are typed so downstream focus-state derivation can consume a normalized enum.
 */

// === Mock localStorage ===
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
    clear: vi.fn(() => {
      store = {};
    }),
    get store() {
      return store;
    },
  };
})();

Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock });

beforeEach(() => {
  localStorageMock.clear();
  vi.clearAllMocks();
});

// === AC1: Only exact "auto" and "open" accepted; all others resolve to "auto" ===

describe('parseRunOverride', () => {
  it('accepts exact "auto"', () => {
    expect(parseRunOverride('auto')).toBe('auto');
  });

  it('accepts exact "open"', () => {
    expect(parseRunOverride('open')).toBe('open');
  });

  it.each([
    ['Auto', 'uppercase variant'],
    ['OPEN', 'all-caps variant'],
    ['closed', 'unrecognized string'],
    ['', 'empty string'],
    ['  auto  ', 'whitespace-padded "auto"'],
    ['auto\n', 'trailing newline'],
  ])('rejects %s (%s) and resolves to "auto"', (input) => {
    expect(parseRunOverride(input)).toBe('auto');
  });

  it('resolves null to "auto"', () => {
    expect(parseRunOverride(null)).toBe('auto');
  });

  it('resolves undefined to "auto"', () => {
    expect(parseRunOverride(undefined)).toBe('auto');
  });

  it('resolves numeric values to "auto"', () => {
    expect(parseRunOverride(0)).toBe('auto');
    expect(parseRunOverride(42)).toBe('auto');
  });

  it('resolves boolean values to "auto"', () => {
    expect(parseRunOverride(true)).toBe('auto');
    expect(parseRunOverride(false)).toBe('auto');
  });

  it('resolves object values to "auto"', () => {
    expect(parseRunOverride({})).toBe('auto');
    expect(parseRunOverride([])).toBe('auto');
  });
});

// === AC1 + AC2: readRunOverride from localStorage ===

describe('readRunOverride', () => {
  it('returns "auto" when key is absent', () => {
    expect(readRunOverride()).toBe('auto');
  });

  it('returns "auto" when stored value is "auto"', () => {
    localStorageMock.store[RUN_OVERRIDE_STORAGE_KEY] = 'auto';
    expect(readRunOverride()).toBe('auto');
  });

  it('returns "open" when stored value is "open"', () => {
    localStorageMock.store[RUN_OVERRIDE_STORAGE_KEY] = 'open';
    expect(readRunOverride()).toBe('open');
  });

  it('returns "auto" for invalid stored value', () => {
    localStorageMock.store[RUN_OVERRIDE_STORAGE_KEY] = 'bogus';
    expect(readRunOverride()).toBe('auto');
  });

  it('never throws when localStorage.getItem throws', () => {
    localStorageMock.getItem.mockImplementationOnce(() => {
      throw new Error('SecurityError: localStorage is blocked');
    });
    expect(() => readRunOverride()).not.toThrow();
    expect(readRunOverride()).toBe('auto');
  });
});

// === AC2: writeRunOverride never throws ===

describe('writeRunOverride', () => {
  it('persists "auto" to localStorage', () => {
    writeRunOverride('auto');
    expect(localStorageMock.setItem).toHaveBeenCalledWith(RUN_OVERRIDE_STORAGE_KEY, 'auto');
    expect(localStorageMock.store[RUN_OVERRIDE_STORAGE_KEY]).toBe('auto');
  });

  it('persists "open" to localStorage', () => {
    writeRunOverride('open');
    expect(localStorageMock.setItem).toHaveBeenCalledWith(RUN_OVERRIDE_STORAGE_KEY, 'open');
    expect(localStorageMock.store[RUN_OVERRIDE_STORAGE_KEY]).toBe('open');
  });

  it('never throws when localStorage.setItem throws', () => {
    localStorageMock.setItem.mockImplementationOnce(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => writeRunOverride('open')).not.toThrow();
  });

  it('overwrites previous value', () => {
    writeRunOverride('open');
    writeRunOverride('auto');
    expect(localStorageMock.store[RUN_OVERRIDE_STORAGE_KEY]).toBe('auto');
  });
});

// === AC2: clearRunOverride never throws ===

describe('clearRunOverride', () => {
  it('removes the key from localStorage', () => {
    localStorageMock.store[RUN_OVERRIDE_STORAGE_KEY] = 'open';
    clearRunOverride();
    expect(localStorageMock.removeItem).toHaveBeenCalledWith(RUN_OVERRIDE_STORAGE_KEY);
    expect(localStorageMock.store[RUN_OVERRIDE_STORAGE_KEY]).toBeUndefined();
  });

  it('never throws when localStorage.removeItem throws', () => {
    localStorageMock.removeItem.mockImplementationOnce(() => {
      throw new Error('SecurityError');
    });
    expect(() => clearRunOverride()).not.toThrow();
  });

  it('subsequent read returns "auto" after clear', () => {
    localStorageMock.store[RUN_OVERRIDE_STORAGE_KEY] = 'open';
    clearRunOverride();
    expect(readRunOverride()).toBe('auto');
  });
});

// === AC3: Type safety — compile-time verification ===

describe('RunOverride type contract', () => {
  it('exported type is assignable to normalized values', () => {
    // These assignments verify the type is usable downstream.
    const autoVal: RunOverride = 'auto';
    const openVal: RunOverride = 'open';
    expect(autoVal).toBe('auto');
    expect(openVal).toBe('open');
  });

  it('parseRunOverride return type is RunOverride', () => {
    // Downstream consumers can depend on the return type without casting.
    const result: RunOverride = parseRunOverride('anything');
    expect(result).toBe('auto');
  });

  it('readRunOverride return type is RunOverride', () => {
    const result: RunOverride = readRunOverride();
    expect(result).toBe('auto');
  });
});

// === Storage key constant ===

describe('RUN_OVERRIDE_STORAGE_KEY', () => {
  it('matches the design-specified key', () => {
    expect(RUN_OVERRIDE_STORAGE_KEY).toBe('jeeves.watch.sidebar.runOverride');
  });
});
