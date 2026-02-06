import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  type FocusState,
  focusReducer,
  isSidebarVisible,
  readRunOverride,
  writeRunOverride,
} from './runFocusState.js';

/**
 * Header focused-mode controls tests (T5).
 *
 * These tests verify the Header integration behavior described in T5
 * acceptance criteria by simulating the same state+action pattern that
 * Header.tsx uses:
 *
 * - `useFocusMode()` provides `focusState`, `onUserReopen`, `onUserHide`
 * - Header shows a focus-toggle control when `focusState !== 'W0'`
 * - Label is "Show Sidebar" when sidebar is hidden, "Hide Sidebar" when visible (W3)
 * - onUserReopen dispatches USER_REOPEN, onUserHide dispatches USER_HIDE
 *
 * The test harness replicates the Header control logic and AppShell dispatch
 * wiring so we can verify button visibility, labels, and persistence effects
 * without mounting React components.
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

// === Header control derivation (mirrors Header.tsx logic) ===

/**
 * Derives the Header focused-mode control state from the current FocusState.
 * Mirrors the logic in Header.tsx for showFocusControl, label, and action.
 */
function deriveHeaderControl(focusState: FocusState) {
  const showFocusControl = focusState !== 'W0';
  const sidebarVisible = isSidebarVisible(focusState);

  return {
    showFocusControl,
    label: sidebarVisible ? 'Hide Sidebar' : 'Show Sidebar',
    /** Which action the button would trigger: 'reopen' or 'hide' */
    action: sidebarVisible ? ('hide' as const) : ('reopen' as const),
  };
}

/**
 * Simulates the AppShell dispatch (onUserReopen / onUserHide) that
 * Header triggers via the FocusModeContext.
 */
function simulateHeaderAction(
  focusState: FocusState,
  action: 'reopen' | 'hide',
) {
  const type = action === 'reopen' ? 'USER_REOPEN' : 'USER_HIDE';
  const result = focusReducer(focusState, { type });
  if (result.persistOverride !== null) {
    writeRunOverride(result.persistOverride);
  }
  return result;
}

// ============================================================================
// T5-AC1: Header shows focused-mode controls with correct labels/actions
// ============================================================================

describe('T5-AC1: Header focused-mode control visibility and labels', () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
  });

  it('W0 (idle visible): no focus control shown', () => {
    const control = deriveHeaderControl('W0');
    expect(control.showFocusControl).toBe(false);
  });

  it('W1 (run-start hiding): shows "Show Sidebar" with reopen action', () => {
    const control = deriveHeaderControl('W1');
    expect(control.showFocusControl).toBe(true);
    expect(control.label).toBe('Show Sidebar');
    expect(control.action).toBe('reopen');
  });

  it('W2 (running focused hidden): shows "Show Sidebar" with reopen action', () => {
    const control = deriveHeaderControl('W2');
    expect(control.showFocusControl).toBe(true);
    expect(control.label).toBe('Show Sidebar');
    expect(control.action).toBe('reopen');
  });

  it('W3 (running override open): shows "Hide Sidebar" with hide action', () => {
    const control = deriveHeaderControl('W3');
    expect(control.showFocusControl).toBe(true);
    expect(control.label).toBe('Hide Sidebar');
    expect(control.action).toBe('hide');
  });

  it('W4 (idle sticky hidden): shows "Show Sidebar" with reopen action', () => {
    const control = deriveHeaderControl('W4');
    expect(control.showFocusControl).toBe(true);
    expect(control.label).toBe('Show Sidebar');
    expect(control.action).toBe('reopen');
  });
});

// ============================================================================
// T5-AC2: Explicit reopen during W1/W2 transitions to W3 and persists "open"
// ============================================================================

describe('T5-AC2: explicit reopen during W1/W2 persists override "open"', () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
  });

  it('reopen from W1 transitions to W3 (visible running)', () => {
    const result = simulateHeaderAction('W1', 'reopen');
    expect(result.state).toBe('W3');
  });

  it('reopen from W1 persists override "open"', () => {
    simulateHeaderAction('W1', 'reopen');
    expect(readRunOverride()).toBe('open');
  });

  it('reopen from W2 transitions to W3 (visible running)', () => {
    const result = simulateHeaderAction('W2', 'reopen');
    expect(result.state).toBe('W3');
  });

  it('reopen from W2 persists override "open"', () => {
    simulateHeaderAction('W2', 'reopen');
    expect(readRunOverride()).toBe('open');
  });

  it('after reopen from W1, header control shows "Hide Sidebar"', () => {
    const result = simulateHeaderAction('W1', 'reopen');
    const control = deriveHeaderControl(result.state);
    expect(control.showFocusControl).toBe(true);
    expect(control.label).toBe('Hide Sidebar');
    expect(control.action).toBe('hide');
  });

  it('after reopen from W2, header control shows "Hide Sidebar"', () => {
    const result = simulateHeaderAction('W2', 'reopen');
    const control = deriveHeaderControl(result.state);
    expect(control.showFocusControl).toBe(true);
    expect(control.label).toBe('Hide Sidebar');
    expect(control.action).toBe('hide');
  });
});

// ============================================================================
// T5-AC3: Explicit hide from W3 clears persisted override to "auto"
// ============================================================================

describe('T5-AC3: explicit hide from W3 clears override to "auto"', () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
  });

  it('hide from W3 transitions to W2 (hidden focused)', () => {
    writeRunOverride('open');
    const result = simulateHeaderAction('W3', 'hide');
    expect(result.state).toBe('W2');
  });

  it('hide from W3 clears persisted override to "auto"', () => {
    writeRunOverride('open');
    expect(readRunOverride()).toBe('open');

    simulateHeaderAction('W3', 'hide');
    expect(readRunOverride()).toBe('auto');
  });

  it('after hide from W3, header control shows "Show Sidebar"', () => {
    writeRunOverride('open');
    const result = simulateHeaderAction('W3', 'hide');
    const control = deriveHeaderControl(result.state);
    expect(control.showFocusControl).toBe(true);
    expect(control.label).toBe('Show Sidebar');
    expect(control.action).toBe('reopen');
  });

  it('hide from W3 does not replay animation (direct to W2)', () => {
    writeRunOverride('open');
    const result = simulateHeaderAction('W3', 'hide');
    expect(result.state).toBe('W2');
    expect(result.animate).toBe(false);
  });
});

// ============================================================================
// T5: Full interaction sequences through Header controls
// ============================================================================

describe('T5: Header control interaction sequences', () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
  });

  it('reopen during W2 then hide from W3: round-trips override correctly', () => {
    // Start at W2 (running, auto-hidden)
    let state: FocusState = 'W2';

    // User clicks "Show Sidebar"
    const reopenResult = simulateHeaderAction(state, 'reopen');
    state = reopenResult.state;
    expect(state).toBe('W3');
    expect(readRunOverride()).toBe('open');

    // User clicks "Hide Sidebar"
    const hideResult = simulateHeaderAction(state, 'hide');
    state = hideResult.state;
    expect(state).toBe('W2');
    expect(readRunOverride()).toBe('auto');
  });

  it('reopen from W4 transitions to W0 and control disappears', () => {
    const result = simulateHeaderAction('W4', 'reopen');
    expect(result.state).toBe('W0');

    const control = deriveHeaderControl(result.state);
    expect(control.showFocusControl).toBe(false);
  });

  it('reopen from W4 persists override "auto" (clears sticky hidden)', () => {
    // Set up: somehow override was "open" before
    writeRunOverride('open');
    const result = simulateHeaderAction('W4', 'reopen');
    expect(result.state).toBe('W0');
    expect(readRunOverride()).toBe('auto');
  });
});
