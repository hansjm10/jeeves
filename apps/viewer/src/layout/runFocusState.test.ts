import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  RUN_OVERRIDE_STORAGE_KEY,
  parseRunOverride,
  readRunOverride,
  writeRunOverride,
  clearRunOverride,
  focusReducer,
  deriveFocusState,
  isSidebarVisible,
  isAnimating,
  type RunOverride,
  type FocusState,
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

// ============================================================================
// T2: Focus-state transition reducer tests
// ============================================================================

/**
 * Tests for focus-state transition model (focusReducer).
 *
 * Acceptance criteria (T2):
 * 1. Transition logic defines deterministic handling for states W0-W4 and
 *    transitions TR1 through TR9.
 * 2. Duplicate run-start while in W1 is a no-op, hide while running in W3
 *    transitions directly to W2 and clears override to "auto", and run start
 *    from W4 enters W2 without replaying run-start animation.
 * 3. Hydration/reconnect derivation preserves last known state during disconnect
 *    and initializes mid-run as W2 for "auto" and W3 for "open".
 */

describe('focusReducer', () => {
  // --- TR1: W0 -> W1 (run start with override "auto") ---
  describe('TR1: W0 -> W1 (run start with override "auto")', () => {
    it('transitions from W0 to W1 and signals animation', () => {
      const result = focusReducer('W0', { type: 'RUN_START', override: 'auto' });
      expect(result.state).toBe('W1');
      expect(result.animate).toBe(true);
      expect(result.persistOverride).toBeNull();
    });
  });

  // --- W0 + RUN_START with override "open" -> W3 ---
  describe('W0 + RUN_START with override "open"', () => {
    it('transitions from W0 to W3 (user wants sidebar open)', () => {
      const result = focusReducer('W0', { type: 'RUN_START', override: 'open' });
      expect(result.state).toBe('W3');
      expect(result.animate).toBe(false);
      expect(result.persistOverride).toBeNull();
    });
  });

  // --- TR2: W1 -> W2 (hide transition completes) ---
  describe('TR2: W1 -> W2 (hide transition end)', () => {
    it('transitions from W1 to W2 after transition end', () => {
      const result = focusReducer('W1', { type: 'HIDE_TRANSITION_END' });
      expect(result.state).toBe('W2');
      expect(result.animate).toBe(false);
      expect(result.persistOverride).toBeNull();
    });
  });

  // --- TR3: W1/W2 -> W3 (user reopen during run) ---
  describe('TR3: W1/W2 -> W3 (user reopen during running)', () => {
    it('transitions from W1 to W3 and persists "open"', () => {
      const result = focusReducer('W1', { type: 'USER_REOPEN' });
      expect(result.state).toBe('W3');
      expect(result.animate).toBe(false);
      expect(result.persistOverride).toBe('open');
    });

    it('transitions from W2 to W3 and persists "open"', () => {
      const result = focusReducer('W2', { type: 'USER_REOPEN' });
      expect(result.state).toBe('W3');
      expect(result.animate).toBe(false);
      expect(result.persistOverride).toBe('open');
    });
  });

  // --- TR4: W2 -> W4 (run ends from focused hidden) ---
  describe('TR4: W2 -> W4 (run end from focused hidden)', () => {
    it('transitions from W2 to W4 (sticky hidden)', () => {
      const result = focusReducer('W2', { type: 'RUN_END' });
      expect(result.state).toBe('W4');
      expect(result.animate).toBe(false);
      expect(result.persistOverride).toBeNull();
    });
  });

  // --- TR5: W3 -> W0 (run ends while override open) ---
  describe('TR5: W3 -> W0 (run end while override open)', () => {
    it('transitions from W3 to W0 (keep sidebar visible)', () => {
      const result = focusReducer('W3', { type: 'RUN_END' });
      expect(result.state).toBe('W0');
      expect(result.animate).toBe(false);
      expect(result.persistOverride).toBeNull();
    });
  });

  // --- TR6: W4 -> W0 (explicit reopen after run completion) ---
  describe('TR6: W4 -> W0 (user reopen from sticky hidden)', () => {
    it('transitions from W4 to W0 and clears override to "auto"', () => {
      const result = focusReducer('W4', { type: 'USER_REOPEN' });
      expect(result.state).toBe('W0');
      expect(result.animate).toBe(false);
      expect(result.persistOverride).toBe('auto');
    });
  });

  // --- TR7: W1 -> W1 (duplicate run-start, no-op) ---
  describe('TR7: W1 -> W1 (duplicate run-start is no-op)', () => {
    it('stays in W1 without re-triggering animation', () => {
      const result = focusReducer('W1', { type: 'RUN_START', override: 'auto' });
      expect(result.state).toBe('W1');
      expect(result.animate).toBe(false);
      expect(result.persistOverride).toBeNull();
    });
  });

  // --- TR8: W3 -> W2 (user hide while running from override-open) ---
  describe('TR8: W3 -> W2 (user hide while running)', () => {
    it('transitions directly to W2 (no W1 replay) and clears override to "auto"', () => {
      const result = focusReducer('W3', { type: 'USER_HIDE' });
      expect(result.state).toBe('W2');
      expect(result.animate).toBe(false);
      expect(result.persistOverride).toBe('auto');
    });
  });

  // --- TR9: W4 -> W2 (run start from sticky hidden) ---
  describe('TR9: W4 -> W2 (run start from sticky hidden)', () => {
    it('transitions directly to W2 without animation', () => {
      const result = focusReducer('W4', { type: 'RUN_START', override: 'auto' });
      expect(result.state).toBe('W2');
      expect(result.animate).toBe(false);
      expect(result.persistOverride).toBeNull();
    });
  });

  // --- EC1: Animation in-flight edge cases ---
  describe('EC1: animation in-flight edge cases', () => {
    it('run end during W1 lands in W4 (hidden)', () => {
      const result = focusReducer('W1', { type: 'RUN_END' });
      expect(result.state).toBe('W4');
      expect(result.animate).toBe(false);
    });

    it('user reopen during W1 cancels hide and enters W3', () => {
      const result = focusReducer('W1', { type: 'USER_REOPEN' });
      expect(result.state).toBe('W3');
      expect(result.persistOverride).toBe('open');
    });
  });

  // --- No-op scenarios ---
  describe('no-op transitions', () => {
    it('RUN_START from W2 is a no-op', () => {
      const result = focusReducer('W2', { type: 'RUN_START', override: 'auto' });
      expect(result.state).toBe('W2');
      expect(result.animate).toBe(false);
    });

    it('RUN_START from W3 is a no-op', () => {
      const result = focusReducer('W3', { type: 'RUN_START', override: 'auto' });
      expect(result.state).toBe('W3');
      expect(result.animate).toBe(false);
    });

    it('HIDE_TRANSITION_END from non-W1 states is a no-op', () => {
      const states: FocusState[] = ['W0', 'W2', 'W3', 'W4'];
      for (const state of states) {
        const result = focusReducer(state, { type: 'HIDE_TRANSITION_END' });
        expect(result.state).toBe(state);
        expect(result.animate).toBe(false);
      }
    });

    it('USER_REOPEN from W0 is a no-op', () => {
      const result = focusReducer('W0', { type: 'USER_REOPEN' });
      expect(result.state).toBe('W0');
      expect(result.persistOverride).toBeNull();
    });

    it('USER_REOPEN from W3 is a no-op', () => {
      const result = focusReducer('W3', { type: 'USER_REOPEN' });
      expect(result.state).toBe('W3');
      expect(result.persistOverride).toBeNull();
    });

    it('USER_HIDE from W1 is a no-op', () => {
      const result = focusReducer('W1', { type: 'USER_HIDE' });
      expect(result.state).toBe('W1');
    });

    it('USER_HIDE from W2 is a no-op', () => {
      const result = focusReducer('W2', { type: 'USER_HIDE' });
      expect(result.state).toBe('W2');
    });

    it('USER_HIDE from W4 is a no-op', () => {
      const result = focusReducer('W4', { type: 'USER_HIDE' });
      expect(result.state).toBe('W4');
    });

    it('RUN_END from W0 is a no-op', () => {
      const result = focusReducer('W0', { type: 'RUN_END' });
      expect(result.state).toBe('W0');
    });

    it('RUN_END from W4 is a no-op', () => {
      const result = focusReducer('W4', { type: 'RUN_END' });
      expect(result.state).toBe('W4');
    });
  });

  // --- USER_HIDE from W0 -> W4 ---
  describe('USER_HIDE from W0', () => {
    it('transitions from W0 to W4 (manual hide while idle)', () => {
      const result = focusReducer('W0', { type: 'USER_HIDE' });
      expect(result.state).toBe('W4');
      expect(result.animate).toBe(false);
      expect(result.persistOverride).toBeNull();
    });
  });

  // --- Full transition sequences ---
  describe('multi-step transition sequences', () => {
    it('W0 -> W1 -> W2 -> W4 (full auto-hide run lifecycle)', () => {
      let result = focusReducer('W0', { type: 'RUN_START', override: 'auto' });
      expect(result.state).toBe('W1');
      expect(result.animate).toBe(true);

      result = focusReducer('W1', { type: 'HIDE_TRANSITION_END' });
      expect(result.state).toBe('W2');

      result = focusReducer('W2', { type: 'RUN_END' });
      expect(result.state).toBe('W4');
    });

    it('W0 -> W1 -> W3 -> W0 (reopen during animation, run ends)', () => {
      let result = focusReducer('W0', { type: 'RUN_START', override: 'auto' });
      expect(result.state).toBe('W1');

      result = focusReducer('W1', { type: 'USER_REOPEN' });
      expect(result.state).toBe('W3');
      expect(result.persistOverride).toBe('open');

      result = focusReducer('W3', { type: 'RUN_END' });
      expect(result.state).toBe('W0');
    });

    it('W0 -> W1 -> W2 -> W3 -> W2 -> W4 (reopen then hide during run)', () => {
      let result = focusReducer('W0', { type: 'RUN_START', override: 'auto' });
      expect(result.state).toBe('W1');

      result = focusReducer('W1', { type: 'HIDE_TRANSITION_END' });
      expect(result.state).toBe('W2');

      result = focusReducer('W2', { type: 'USER_REOPEN' });
      expect(result.state).toBe('W3');
      expect(result.persistOverride).toBe('open');

      result = focusReducer('W3', { type: 'USER_HIDE' });
      expect(result.state).toBe('W2');
      expect(result.persistOverride).toBe('auto');

      result = focusReducer('W2', { type: 'RUN_END' });
      expect(result.state).toBe('W4');
    });

    it('W4 -> W2 -> W4 -> W0 (restart from sticky hidden, then reopen)', () => {
      let result = focusReducer('W4', { type: 'RUN_START', override: 'auto' });
      expect(result.state).toBe('W2');
      expect(result.animate).toBe(false);

      result = focusReducer('W2', { type: 'RUN_END' });
      expect(result.state).toBe('W4');

      result = focusReducer('W4', { type: 'USER_REOPEN' });
      expect(result.state).toBe('W0');
      expect(result.persistOverride).toBe('auto');
    });
  });
});

// ============================================================================
// T2: deriveFocusState (hydration / reconnect) tests
// ============================================================================

describe('deriveFocusState', () => {
  // --- EC2: Refresh mid-run initialization ---
  describe('EC2: refresh mid-run initialization', () => {
    it('initializes to W2 when running with override "auto"', () => {
      const result = deriveFocusState({ running: true, override: 'auto' });
      expect(result).toBe('W2');
    });

    it('initializes to W3 when running with override "open"', () => {
      const result = deriveFocusState({ running: true, override: 'open' });
      expect(result).toBe('W3');
    });

    it('initializes to W0 when not running', () => {
      const result = deriveFocusState({ running: false, override: 'auto' });
      expect(result).toBe('W0');
    });

    it('initializes to W0 when not running even with override "open"', () => {
      const result = deriveFocusState({ running: false, override: 'open' });
      expect(result).toBe('W0');
    });
  });

  // --- EC3: WebSocket reconnect — preserve last known state during disconnect ---
  describe('EC3: reconnect disconnect preservation', () => {
    it('preserves last known state W2 during disconnect', () => {
      const result = deriveFocusState({
        running: true,
        override: 'auto',
        disconnected: true,
        previousState: 'W2',
      });
      expect(result).toBe('W2');
    });

    it('preserves last known state W3 during disconnect', () => {
      const result = deriveFocusState({
        running: true,
        override: 'auto',
        disconnected: true,
        previousState: 'W3',
      });
      expect(result).toBe('W3');
    });

    it('preserves last known state W1 during disconnect', () => {
      const result = deriveFocusState({
        running: false,
        override: 'auto',
        disconnected: true,
        previousState: 'W1',
      });
      expect(result).toBe('W1');
    });

    it('preserves last known state W4 during disconnect', () => {
      const result = deriveFocusState({
        running: false,
        override: 'auto',
        disconnected: true,
        previousState: 'W4',
      });
      expect(result).toBe('W4');
    });

    it('preserves W0 during disconnect', () => {
      const result = deriveFocusState({
        running: false,
        override: 'auto',
        disconnected: true,
        previousState: 'W0',
      });
      expect(result).toBe('W0');
    });

    it('falls back to normal derivation when disconnected but no previousState', () => {
      const result = deriveFocusState({
        running: true,
        override: 'auto',
        disconnected: true,
      });
      expect(result).toBe('W2');
    });

    it('ignores previousState when not disconnected', () => {
      const result = deriveFocusState({
        running: false,
        override: 'auto',
        disconnected: false,
        previousState: 'W2',
      });
      expect(result).toBe('W0');
    });
  });

  // --- EC3: Reconnect snapshot (disconnected=false) uses normal derivation ---
  describe('EC3: reconnect snapshot derivation', () => {
    it('derives W2 on reconnect snapshot when running with "auto"', () => {
      const result = deriveFocusState({
        running: true,
        override: 'auto',
        disconnected: false,
      });
      expect(result).toBe('W2');
    });

    it('derives W3 on reconnect snapshot when running with "open"', () => {
      const result = deriveFocusState({
        running: true,
        override: 'open',
        disconnected: false,
      });
      expect(result).toBe('W3');
    });

    it('derives W0 on reconnect snapshot when not running', () => {
      const result = deriveFocusState({
        running: false,
        override: 'auto',
        disconnected: false,
      });
      expect(result).toBe('W0');
    });
  });
});

// ============================================================================
// T2: Utility helper tests
// ============================================================================

describe('isSidebarVisible', () => {
  it('returns true for W0 (idle visible)', () => {
    expect(isSidebarVisible('W0')).toBe(true);
  });

  it('returns true for W3 (running, override open)', () => {
    expect(isSidebarVisible('W3')).toBe(true);
  });

  it('returns false for W1 (transitioning)', () => {
    expect(isSidebarVisible('W1')).toBe(false);
  });

  it('returns false for W2 (focused hidden)', () => {
    expect(isSidebarVisible('W2')).toBe(false);
  });

  it('returns false for W4 (sticky hidden)', () => {
    expect(isSidebarVisible('W4')).toBe(false);
  });
});

describe('isAnimating', () => {
  it('returns true only for W1', () => {
    expect(isAnimating('W1')).toBe(true);
  });

  it('returns false for all other states', () => {
    const nonAnimatingStates: FocusState[] = ['W0', 'W2', 'W3', 'W4'];
    for (const state of nonAnimatingStates) {
      expect(isAnimating(state)).toBe(false);
    }
  });
});
