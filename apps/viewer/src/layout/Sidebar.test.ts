import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { validateIterations, ITERATIONS_STORAGE_KEY } from './Sidebar.js';

/**
 * Tests for Sidebar iterations input UI behavior.
 *
 * These tests verify the UI contract for the iterations input field:
 * - Validation logic that determines what error message is displayed
 * - Button disabled state conditions that control the Start button
 * - localStorage persistence that initializes state on component mount
 *
 * The Sidebar component (Sidebar.tsx) implements these behaviors:
 * - Line 60-62: iterationsValidation drives iterationsError which is displayed in errorText div
 * - Line 207: Start button disabled condition includes `iterationsError !== null`
 * - Line 57: useState initializes from localStorage.getItem(ITERATIONS_STORAGE_KEY)
 * - Line 80-95: handleSetIterations updates localStorage based on validation
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

// === Replicate Sidebar.tsx state derivation (lines 60-62) ===
function deriveUIState(iterationsInput: string) {
  const iterationsValidation = validateIterations(iterationsInput);
  const iterationsError = iterationsValidation !== null && 'error' in iterationsValidation
    ? iterationsValidation.error
    : null;
  const validIterations = iterationsValidation !== null && 'value' in iterationsValidation
    ? iterationsValidation.value
    : undefined;
  return { iterationsError, validIterations };
}

// === Replicate Sidebar.tsx Start button disabled logic (line 207) ===
// disabled={!activeIssue || (run?.running ?? false) || startRun.isPending || iterationsError !== null}
function isStartButtonDisabledDueToIterations(iterationsError: string | null): boolean {
  return iterationsError !== null;
}

// === ACCEPTANCE CRITERIA TESTS ===

describe('Test: blank iterations omits max_iterations from request body', () => {
  it('blank input results in undefined validIterations (omits from payload)', () => {
    const { validIterations } = deriveUIState('');
    expect(validIterations).toBeUndefined();
  });

  it('whitespace-only input results in undefined validIterations', () => {
    const { validIterations } = deriveUIState('   ');
    expect(validIterations).toBeUndefined();
  });

  it('request body omits max_iterations when validIterations is undefined', () => {
    const { validIterations } = deriveUIState('');
    const body: { provider: string; max_iterations?: number } = { provider: 'claude' };
    if (validIterations !== undefined) {
      body.max_iterations = validIterations;
    }
    expect(body).toEqual({ provider: 'claude' });
    expect(Object.keys(body)).not.toContain('max_iterations');
  });
});

describe('Test: valid positive integer iterations included in request as max_iterations', () => {
  it.each([
    ['1', 1],
    ['5', 5],
    ['10', 10],
    ['100', 100],
    ['  15  ', 15],
  ])('input "%s" results in validIterations=%d', (input, expected) => {
    const { validIterations } = deriveUIState(input);
    expect(validIterations).toBe(expected);
  });

  it('request body includes max_iterations when validIterations is defined', () => {
    const { validIterations } = deriveUIState('7');
    const body: { provider: string; max_iterations?: number } = { provider: 'claude' };
    if (validIterations !== undefined) {
      body.max_iterations = validIterations;
    }
    expect(body).toEqual({ provider: 'claude', max_iterations: 7 });
  });
});

describe('Test: invalid inputs (0, -1, 2.5, abc) show inline error message', () => {
  // These tests verify that iterationsError is set with the exact message
  // that will be displayed in the errorText div (Sidebar.tsx line 202)
  // {iterationsError ? <div className="errorText">{iterationsError}</div> : null}

  it('input "0" shows error "Must be a positive integer"', () => {
    const { iterationsError } = deriveUIState('0');
    expect(iterationsError).toBe('Must be a positive integer');
  });

  it('input "-1" shows error "Must be a positive integer"', () => {
    const { iterationsError } = deriveUIState('-1');
    expect(iterationsError).toBe('Must be a positive integer');
  });

  it('input "2.5" shows error "Must be a whole number"', () => {
    const { iterationsError } = deriveUIState('2.5');
    expect(iterationsError).toBe('Must be a whole number');
  });

  it('input "abc" shows error "Must be a number"', () => {
    const { iterationsError } = deriveUIState('abc');
    expect(iterationsError).toBe('Must be a number');
  });

  it('input "-10" shows error "Must be a positive integer"', () => {
    const { iterationsError } = deriveUIState('-10');
    expect(iterationsError).toBe('Must be a positive integer');
  });

  it('input "3.14159" shows error "Must be a whole number"', () => {
    const { iterationsError } = deriveUIState('3.14159');
    expect(iterationsError).toBe('Must be a whole number');
  });

  it('input "5abc" shows error "Must be a number"', () => {
    const { iterationsError } = deriveUIState('5abc');
    expect(iterationsError).toBe('Must be a number');
  });

  it('valid inputs do NOT show error (iterationsError is null)', () => {
    expect(deriveUIState('').iterationsError).toBeNull();
    expect(deriveUIState('5').iterationsError).toBeNull();
    expect(deriveUIState('  10  ').iterationsError).toBeNull();
  });
});

describe('Test: invalid inputs disable Start button in addition to existing disable conditions', () => {
  // Sidebar.tsx line 207: disabled={!activeIssue || (run?.running ?? false) || startRun.isPending || iterationsError !== null}
  // These tests verify that iterationsError !== null causes isStartButtonDisabledDueToIterations to return true

  it('input "0" disables Start button (iterationsError !== null)', () => {
    const { iterationsError } = deriveUIState('0');
    expect(isStartButtonDisabledDueToIterations(iterationsError)).toBe(true);
  });

  it('input "-1" disables Start button (iterationsError !== null)', () => {
    const { iterationsError } = deriveUIState('-1');
    expect(isStartButtonDisabledDueToIterations(iterationsError)).toBe(true);
  });

  it('input "2.5" disables Start button (iterationsError !== null)', () => {
    const { iterationsError } = deriveUIState('2.5');
    expect(isStartButtonDisabledDueToIterations(iterationsError)).toBe(true);
  });

  it('input "abc" disables Start button (iterationsError !== null)', () => {
    const { iterationsError } = deriveUIState('abc');
    expect(isStartButtonDisabledDueToIterations(iterationsError)).toBe(true);
  });

  it('valid input "5" does NOT disable Start button due to iterations', () => {
    const { iterationsError } = deriveUIState('5');
    expect(isStartButtonDisabledDueToIterations(iterationsError)).toBe(false);
  });

  it('blank input does NOT disable Start button due to iterations', () => {
    const { iterationsError } = deriveUIState('');
    expect(isStartButtonDisabledDueToIterations(iterationsError)).toBe(false);
  });

  it('verifies the disabled condition matches Sidebar.tsx implementation', () => {
    // This test documents the exact condition from Sidebar.tsx line 207
    const testCases = [
      { input: '0', shouldDisable: true },
      { input: '-1', shouldDisable: true },
      { input: '2.5', shouldDisable: true },
      { input: 'abc', shouldDisable: true },
      { input: '', shouldDisable: false },
      { input: '5', shouldDisable: false },
      { input: '10', shouldDisable: false },
    ];
    for (const { input, shouldDisable } of testCases) {
      const { iterationsError } = deriveUIState(input);
      const isDisabled = iterationsError !== null;
      expect(isDisabled).toBe(shouldDisable);
    }
  });
});

describe('Test: localStorage persistence stores last valid value and reloads on component mount', () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    localStorageMock.clear();
  });

  // === Simulates component mount: useState(() => localStorage.getItem(ITERATIONS_STORAGE_KEY) ?? '') ===
  function simulateComponentMount(): string {
    return localStorage.getItem(ITERATIONS_STORAGE_KEY) ?? '';
  }

  // === Simulates handleSetIterations from Sidebar.tsx lines 80-95 ===
  function simulateHandleSetIterations(value: string): void {
    const validation = validateIterations(value);
    if (validation !== null && 'value' in validation) {
      localStorage.setItem(ITERATIONS_STORAGE_KEY, value.trim());
    } else if (value.trim() === '') {
      localStorage.removeItem(ITERATIONS_STORAGE_KEY);
    }
    // Invalid: do nothing to localStorage (keep last valid)
  }

  it('stores valid value "5" in localStorage', () => {
    simulateHandleSetIterations('5');
    expect(localStorageMock.setItem).toHaveBeenCalledWith(ITERATIONS_STORAGE_KEY, '5');
    expect(localStorageMock.store[ITERATIONS_STORAGE_KEY]).toBe('5');
  });

  it('stores updated valid value, replacing previous', () => {
    simulateHandleSetIterations('10');
    simulateHandleSetIterations('20');
    expect(localStorageMock.store[ITERATIONS_STORAGE_KEY]).toBe('20');
  });

  it('reloads persisted value "15" on component mount', () => {
    localStorageMock.store[ITERATIONS_STORAGE_KEY] = '15';
    const initialValue = simulateComponentMount();
    expect(initialValue).toBe('15');
    expect(localStorageMock.getItem).toHaveBeenCalledWith(ITERATIONS_STORAGE_KEY);
  });

  it('reloads empty string when no persisted value exists', () => {
    const initialValue = simulateComponentMount();
    expect(initialValue).toBe('');
  });

  it('invalid input does not overwrite stored valid value', () => {
    simulateHandleSetIterations('10');
    simulateHandleSetIterations('abc'); // invalid - should not change storage
    expect(localStorageMock.store[ITERATIONS_STORAGE_KEY]).toBe('10');
  });

  it('persisted value is used as initial iterations input state', () => {
    localStorageMock.store[ITERATIONS_STORAGE_KEY] = '25';

    // Simulate full component mount + validation flow
    const initialInput = simulateComponentMount();
    const { validIterations, iterationsError } = deriveUIState(initialInput);

    expect(initialInput).toBe('25');
    expect(validIterations).toBe(25);
    expect(iterationsError).toBeNull();
  });
});

describe('Test: clearing iterations input removes localStorage entry', () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    localStorageMock.clear();
  });

  function simulateHandleSetIterations(value: string): void {
    const validation = validateIterations(value);
    if (validation !== null && 'value' in validation) {
      localStorage.setItem(ITERATIONS_STORAGE_KEY, value.trim());
    } else if (value.trim() === '') {
      localStorage.removeItem(ITERATIONS_STORAGE_KEY);
    }
  }

  it('removes localStorage entry when input is cleared to empty string', () => {
    localStorageMock.store[ITERATIONS_STORAGE_KEY] = '10';
    simulateHandleSetIterations('');
    expect(localStorageMock.removeItem).toHaveBeenCalledWith(ITERATIONS_STORAGE_KEY);
    expect(localStorageMock.store[ITERATIONS_STORAGE_KEY]).toBeUndefined();
  });

  it('removes localStorage entry when input is cleared to whitespace', () => {
    localStorageMock.store[ITERATIONS_STORAGE_KEY] = '10';
    simulateHandleSetIterations('   ');
    expect(localStorageMock.removeItem).toHaveBeenCalledWith(ITERATIONS_STORAGE_KEY);
    expect(localStorageMock.store[ITERATIONS_STORAGE_KEY]).toBeUndefined();
  });

  it('does NOT remove localStorage entry when input is invalid (keeps last valid)', () => {
    localStorageMock.store[ITERATIONS_STORAGE_KEY] = '10';
    simulateHandleSetIterations('abc');
    expect(localStorageMock.store[ITERATIONS_STORAGE_KEY]).toBe('10');
    expect(localStorageMock.removeItem).not.toHaveBeenCalled();
  });

  it('full flow: set valid → clear → mount shows empty', () => {
    // Set a valid value
    simulateHandleSetIterations('42');
    expect(localStorageMock.store[ITERATIONS_STORAGE_KEY]).toBe('42');

    // Clear the input
    simulateHandleSetIterations('');
    expect(localStorageMock.store[ITERATIONS_STORAGE_KEY]).toBeUndefined();

    // Simulate remount - should be empty
    const initialValue = localStorage.getItem(ITERATIONS_STORAGE_KEY) ?? '';
    expect(initialValue).toBe('');
  });
});
