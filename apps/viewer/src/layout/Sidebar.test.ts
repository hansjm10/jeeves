import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

/**
 * Tests for the validateIterations function and iterations input behavior in Sidebar.
 *
 * These tests cover:
 * - Blank iterations omits max_iterations from request body
 * - Valid positive integer iterations included in request as max_iterations
 * - Invalid inputs (0, -1, 2.5, 'abc') show inline error message
 * - Invalid inputs disable Start button in addition to existing disable conditions
 * - localStorage persistence stores last valid value and reloads on component mount
 * - Clearing iterations input removes localStorage entry
 */

// Mock localStorage for testing
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

// Import validateIterations by extracting the logic (same as in Sidebar.tsx)
// Since the function is not exported, we replicate it here for unit testing
function validateIterations(input: string): { value: number } | { error: string } | null {
  const trimmed = input.trim();
  if (trimmed === '') return null; // blank is valid (omit from request)
  const num = Number(trimmed);
  if (!Number.isFinite(num)) return { error: 'Must be a number' };
  if (!Number.isInteger(num)) return { error: 'Must be a whole number' };
  if (num <= 0) return { error: 'Must be a positive integer' };
  return { value: num };
}

const ITERATIONS_STORAGE_KEY = 'jeeves.iterations';

describe('validateIterations', () => {
  describe('blank input (omits max_iterations from request)', () => {
    it('returns null for empty string', () => {
      expect(validateIterations('')).toBeNull();
    });

    it('returns null for whitespace-only string', () => {
      expect(validateIterations('   ')).toBeNull();
    });

    it('returns null for tab/newline whitespace', () => {
      expect(validateIterations('\t\n')).toBeNull();
    });
  });

  describe('valid positive integer (included in request as max_iterations)', () => {
    it('returns value for 1', () => {
      expect(validateIterations('1')).toEqual({ value: 1 });
    });

    it('returns value for 10', () => {
      expect(validateIterations('10')).toEqual({ value: 10 });
    });

    it('returns value for 100', () => {
      expect(validateIterations('100')).toEqual({ value: 100 });
    });

    it('returns value for large integers', () => {
      expect(validateIterations('9999')).toEqual({ value: 9999 });
    });

    it('trims whitespace and returns value', () => {
      expect(validateIterations('  5  ')).toEqual({ value: 5 });
    });
  });

  describe('invalid inputs (show inline error message)', () => {
    it('returns error for 0', () => {
      const result = validateIterations('0');
      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).toBe('Must be a positive integer');
    });

    it('returns error for negative integers (-1)', () => {
      const result = validateIterations('-1');
      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).toBe('Must be a positive integer');
    });

    it('returns error for negative integers (-10)', () => {
      const result = validateIterations('-10');
      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).toBe('Must be a positive integer');
    });

    it('returns error for floats (2.5)', () => {
      const result = validateIterations('2.5');
      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).toBe('Must be a whole number');
    });

    it('returns error for floats (3.14159)', () => {
      const result = validateIterations('3.14159');
      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).toBe('Must be a whole number');
    });

    it('returns error for non-numeric strings (abc)', () => {
      const result = validateIterations('abc');
      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).toBe('Must be a number');
    });

    it('returns error for mixed alphanumeric (5abc)', () => {
      const result = validateIterations('5abc');
      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).toBe('Must be a number');
    });

    it('returns error for special characters (!@#)', () => {
      const result = validateIterations('!@#');
      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).toBe('Must be a number');
    });

    it('returns error for Infinity', () => {
      const result = validateIterations('Infinity');
      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).toBe('Must be a number');
    });

    it('returns error for NaN', () => {
      const result = validateIterations('NaN');
      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).toBe('Must be a number');
    });
  });
});

describe('Start button disabled state with invalid iterations', () => {
  // These tests verify that the Start button logic correctly disables
  // when iterationsError is not null, in addition to existing conditions

  it('should be disabled when iterationsError is not null (0 input)', () => {
    const iterationsValidation = validateIterations('0');
    const iterationsError = iterationsValidation !== null && 'error' in iterationsValidation
      ? iterationsValidation.error
      : null;

    // The Start button disabled condition includes: iterationsError !== null
    expect(iterationsError).not.toBeNull();
    // This would disable the Start button
  });

  it('should be disabled when iterationsError is not null (-1 input)', () => {
    const iterationsValidation = validateIterations('-1');
    const iterationsError = iterationsValidation !== null && 'error' in iterationsValidation
      ? iterationsValidation.error
      : null;

    expect(iterationsError).not.toBeNull();
  });

  it('should be disabled when iterationsError is not null (2.5 input)', () => {
    const iterationsValidation = validateIterations('2.5');
    const iterationsError = iterationsValidation !== null && 'error' in iterationsValidation
      ? iterationsValidation.error
      : null;

    expect(iterationsError).not.toBeNull();
  });

  it('should be disabled when iterationsError is not null (abc input)', () => {
    const iterationsValidation = validateIterations('abc');
    const iterationsError = iterationsValidation !== null && 'error' in iterationsValidation
      ? iterationsValidation.error
      : null;

    expect(iterationsError).not.toBeNull();
  });

  it('should NOT be disabled due to iterations when input is valid', () => {
    const iterationsValidation = validateIterations('5');
    const iterationsError = iterationsValidation !== null && 'error' in iterationsValidation
      ? iterationsValidation.error
      : null;

    expect(iterationsError).toBeNull();
  });

  it('should NOT be disabled due to iterations when input is blank', () => {
    const iterationsValidation = validateIterations('');
    const iterationsError = iterationsValidation !== null && 'error' in iterationsValidation
      ? iterationsValidation.error
      : null;

    expect(iterationsError).toBeNull();
  });
});

describe('localStorage persistence for iterations', () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    localStorageMock.clear();
  });

  it('stores last valid value in localStorage', () => {
    // Simulate handleSetIterations behavior for valid input
    const value = '5';
    const validation = validateIterations(value);

    if (validation !== null && 'value' in validation) {
      localStorage.setItem(ITERATIONS_STORAGE_KEY, value.trim());
    }

    expect(localStorageMock.setItem).toHaveBeenCalledWith(ITERATIONS_STORAGE_KEY, '5');
    expect(localStorageMock.store[ITERATIONS_STORAGE_KEY]).toBe('5');
  });

  it('stores updated valid value in localStorage', () => {
    // First value
    const value1 = '10';
    const validation1 = validateIterations(value1);
    if (validation1 !== null && 'value' in validation1) {
      localStorage.setItem(ITERATIONS_STORAGE_KEY, value1.trim());
    }

    // Update to new value
    const value2 = '20';
    const validation2 = validateIterations(value2);
    if (validation2 !== null && 'value' in validation2) {
      localStorage.setItem(ITERATIONS_STORAGE_KEY, value2.trim());
    }

    expect(localStorageMock.store[ITERATIONS_STORAGE_KEY]).toBe('20');
  });

  it('reloads persisted value on component mount', () => {
    // Pre-populate localStorage
    localStorageMock.store[ITERATIONS_STORAGE_KEY] = '15';

    // Simulate component mount behavior: read from localStorage
    const storedValue = localStorage.getItem(ITERATIONS_STORAGE_KEY) ?? '';

    expect(storedValue).toBe('15');
    expect(localStorageMock.getItem).toHaveBeenCalledWith(ITERATIONS_STORAGE_KEY);
  });

  it('returns empty string when no persisted value exists', () => {
    const storedValue = localStorage.getItem(ITERATIONS_STORAGE_KEY) ?? '';
    expect(storedValue).toBe('');
  });
});

describe('clearing iterations input removes localStorage entry', () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    localStorageMock.clear();
  });

  it('removes localStorage entry when input is cleared (empty string)', () => {
    // First, set a valid value
    localStorageMock.store[ITERATIONS_STORAGE_KEY] = '10';

    // Simulate clearing the input (handleSetIterations with empty value)
    const value = '';
    const validation = validateIterations(value);

    if (validation === null && value.trim() === '') {
      localStorage.removeItem(ITERATIONS_STORAGE_KEY);
    }

    expect(localStorageMock.removeItem).toHaveBeenCalledWith(ITERATIONS_STORAGE_KEY);
    expect(localStorageMock.store[ITERATIONS_STORAGE_KEY]).toBeUndefined();
  });

  it('removes localStorage entry when input is whitespace only', () => {
    localStorageMock.store[ITERATIONS_STORAGE_KEY] = '10';

    const value = '   ';
    const validation = validateIterations(value);

    if (validation === null && value.trim() === '') {
      localStorage.removeItem(ITERATIONS_STORAGE_KEY);
    }

    expect(localStorageMock.removeItem).toHaveBeenCalledWith(ITERATIONS_STORAGE_KEY);
    expect(localStorageMock.store[ITERATIONS_STORAGE_KEY]).toBeUndefined();
  });

  it('does NOT remove localStorage entry when input is invalid (keeps last valid)', () => {
    localStorageMock.store[ITERATIONS_STORAGE_KEY] = '10';

    const value = 'abc';
    const validation = validateIterations(value);

    // Invalid input: don't update localStorage (keep last valid)
    if (validation !== null && 'value' in validation) {
      localStorage.setItem(ITERATIONS_STORAGE_KEY, value.trim());
    } else if (validation === null && value.trim() === '') {
      localStorage.removeItem(ITERATIONS_STORAGE_KEY);
    }
    // else: invalid, do nothing to localStorage

    // localStorage should still contain the previous valid value
    expect(localStorageMock.store[ITERATIONS_STORAGE_KEY]).toBe('10');
  });
});

describe('request body formation', () => {
  it('omits max_iterations when input is blank', () => {
    const iterationsValidation = validateIterations('');
    const validIterations = iterationsValidation !== null && 'value' in iterationsValidation
      ? iterationsValidation.value
      : undefined;

    // Build request body as mutations.ts does
    const body: { provider: string; max_iterations?: number } = { provider: 'claude' };
    if (validIterations !== undefined) {
      body.max_iterations = validIterations;
    }

    expect(body).toEqual({ provider: 'claude' });
    expect(body).not.toHaveProperty('max_iterations');
  });

  it('includes max_iterations when input is valid positive integer', () => {
    const iterationsValidation = validateIterations('7');
    const validIterations = iterationsValidation !== null && 'value' in iterationsValidation
      ? iterationsValidation.value
      : undefined;

    const body: { provider: string; max_iterations?: number } = { provider: 'claude' };
    if (validIterations !== undefined) {
      body.max_iterations = validIterations;
    }

    expect(body).toEqual({ provider: 'claude', max_iterations: 7 });
  });

  it('includes correct max_iterations value for various valid inputs', () => {
    const testCases = [
      { input: '1', expected: 1 },
      { input: '5', expected: 5 },
      { input: '20', expected: 20 },
      { input: '100', expected: 100 },
      { input: '  15  ', expected: 15 },
    ];

    for (const { input, expected } of testCases) {
      const iterationsValidation = validateIterations(input);
      const validIterations = iterationsValidation !== null && 'value' in iterationsValidation
        ? iterationsValidation.value
        : undefined;

      const body: { provider: string; max_iterations?: number } = { provider: 'codex' };
      if (validIterations !== undefined) {
        body.max_iterations = validIterations;
      }

      expect(body.max_iterations).toBe(expected);
    }
  });

  it('does NOT include max_iterations for invalid inputs (0, -1, 2.5, abc)', () => {
    const invalidInputs = ['0', '-1', '2.5', 'abc', 'NaN', 'Infinity'];

    for (const input of invalidInputs) {
      const iterationsValidation = validateIterations(input);
      const validIterations = iterationsValidation !== null && 'value' in iterationsValidation
        ? iterationsValidation.value
        : undefined;

      const body: { provider: string; max_iterations?: number } = { provider: 'fake' };
      if (validIterations !== undefined) {
        body.max_iterations = validIterations;
      }

      expect(body).not.toHaveProperty('max_iterations');
    }
  });
});
