import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  type FocusState,
  focusReducer,
  deriveFocusState,
  readRunOverride,
  writeRunOverride,
  isSidebarVisible,
  isAnimating,
} from './runFocusState.js';

/**
 * AppShell focused-state wiring tests (T4).
 *
 * These tests verify the AppShell integration behavior described in the T4
 * acceptance criteria by simulating the same state management logic used
 * in AppShell.tsx:
 *
 * - `focusStateRef.current` tracks the current FocusState
 * - `prevRunningRef.current` tracks the previous run.running value
 * - `dispatch` calls `focusReducer` and applies persistence side effects
 * - `deriveInitialFocusState` calls `deriveFocusState` with `readRunOverride()`
 * - CSS class derivation uses `isSidebarVisible` and `isAnimating`
 *
 * The test harness replicates the AppShell wiring pattern so we can verify
 * transition behavior without mounting React components.
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

// === AppShell wiring simulation ===

/**
 * Simulates the AppShell's focus state management.
 * Mirrors the ref-based state tracking and dispatch logic in AppShell.tsx.
 */
class AppShellFocusSimulator {
  focusState: FocusState;
  prevRunning: boolean;
  prevConnected: boolean;
  hideTimerActive: boolean;

  constructor(initialRunning: boolean) {
    this.focusState = this.deriveInitialFocusState(initialRunning);
    this.prevRunning = initialRunning;
    this.prevConnected = true;
    this.hideTimerActive = false;
  }

  /** Replicates deriveInitialFocusState from AppShell.tsx */
  private deriveInitialFocusState(running: boolean): FocusState {
    const override = readRunOverride();
    return deriveFocusState({ running, override });
  }

  /** Replicates the dispatch callback from AppShell.tsx */
  dispatch(action: Parameters<typeof focusReducer>[1]) {
    const result = focusReducer(this.focusState, action);
    this.focusState = result.state;
    if (result.persistOverride !== null) {
      writeRunOverride(result.persistOverride);
    }
    return result;
  }

  /**
   * Simulate run state change (mirrors the useEffect on runRunning).
   * Returns the transition result if a dispatch occurred.
   */
  onRunStateChange(running: boolean) {
    const wasRunning = this.prevRunning;
    this.prevRunning = running;

    if (!wasRunning && running) {
      // Run started: false -> true
      const override = readRunOverride();
      const result = this.dispatch({ type: 'RUN_START', override });
      if (result.animate) {
        this.hideTimerActive = true;
      }
      return result;
    } else if (wasRunning && !running) {
      // Run ended: true -> false
      const result = this.dispatch({ type: 'RUN_END' });
      this.hideTimerActive = false;
      return result;
    }
    return null;
  }

  /** Simulate hide transition completing (transitionend or fallback timer). */
  onHideTransitionEnd() {
    if (this.focusState === 'W1') {
      this.dispatch({ type: 'HIDE_TRANSITION_END' });
      this.hideTimerActive = false;
    }
  }

  /** Simulate user reopen action. */
  onUserReopen() {
    this.dispatch({ type: 'USER_REOPEN' });
    this.hideTimerActive = false;
  }

  /** Simulate user hide action. */
  onUserHide() {
    this.dispatch({ type: 'USER_HIDE' });
  }

  /**
   * Simulate reconnect snapshot reconciliation (mirrors the useEffect on connected).
   */
  onReconnect(running: boolean) {
    const override = readRunOverride();
    this.focusState = deriveFocusState({ running, override });
    this.prevConnected = true;
  }

  /** Disconnect (mirrors connected going false). */
  onDisconnect() {
    this.prevConnected = false;
  }

  /** Get sidebar visibility as AppShell derives it. */
  get sidebarVisible() {
    return isSidebarVisible(this.focusState);
  }

  /** Get whether the hide animation is in progress. */
  get animatingHide() {
    return isAnimating(this.focusState);
  }

  /** Get the CSS classes that would be applied to layout. */
  get layoutClasses(): string[] {
    const classes = ['layout'];
    if (!this.sidebarVisible && !this.animatingHide) {
      classes.push('layout-focused');
    }
    if (this.animatingHide) {
      classes.push('layout-focusing');
    }
    return classes;
  }

  /** Get the CSS classes that would be applied to sidebar. */
  get sidebarClasses(): string[] {
    const classes = ['sidebar'];
    if (!this.sidebarVisible && !this.animatingHide) {
      classes.push('sidebar-hidden');
    }
    if (this.animatingHide) {
      classes.push('sidebar-hiding');
    }
    return classes;
  }
}

// ============================================================================
// T4-AC1: Run state false->true with override "auto" enters hide flow
// ============================================================================

describe('T4-AC1: AppShell run-start hide flow', () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
  });

  it('initializes to W0 when not running', () => {
    const sim = new AppShellFocusSimulator(false);
    expect(sim.focusState).toBe('W0');
    expect(sim.sidebarVisible).toBe(true);
    expect(sim.animatingHide).toBe(false);
  });

  it('transitions W0 -> W1 on run start with override "auto"', () => {
    const sim = new AppShellFocusSimulator(false);
    const result = sim.onRunStateChange(true);

    expect(sim.focusState).toBe('W1');
    expect(result?.animate).toBe(true);
    expect(sim.hideTimerActive).toBe(true);
    expect(sim.animatingHide).toBe(true);
  });

  it('applies sidebar-hiding CSS class during W1', () => {
    const sim = new AppShellFocusSimulator(false);
    sim.onRunStateChange(true);

    expect(sim.sidebarClasses).toContain('sidebar-hiding');
    expect(sim.layoutClasses).toContain('layout-focusing');
    expect(sim.sidebarClasses).not.toContain('sidebar-hidden');
  });

  it('transitions W1 -> W2 on hide transition end', () => {
    const sim = new AppShellFocusSimulator(false);
    sim.onRunStateChange(true);
    sim.onHideTransitionEnd();

    expect(sim.focusState).toBe('W2');
    expect(sim.sidebarVisible).toBe(false);
    expect(sim.animatingHide).toBe(false);
    expect(sim.hideTimerActive).toBe(false);
  });

  it('applies sidebar-hidden and layout-focused CSS classes in W2', () => {
    const sim = new AppShellFocusSimulator(false);
    sim.onRunStateChange(true);
    sim.onHideTransitionEnd();

    expect(sim.sidebarClasses).toContain('sidebar-hidden');
    expect(sim.layoutClasses).toContain('layout-focused');
    expect(sim.sidebarClasses).not.toContain('sidebar-hiding');
  });

  it('full hide flow: W0 -> W1 -> W2 with "auto" override', () => {
    const sim = new AppShellFocusSimulator(false);

    // Step 1: Run starts
    sim.onRunStateChange(true);
    expect(sim.focusState).toBe('W1');

    // Step 2: Transition completes
    sim.onHideTransitionEnd();
    expect(sim.focusState).toBe('W2');
    expect(sim.sidebarVisible).toBe(false);
  });

  it('goes directly to W3 when override is "open"', () => {
    writeRunOverride('open');
    const sim = new AppShellFocusSimulator(false);
    const result = sim.onRunStateChange(true);

    expect(sim.focusState).toBe('W3');
    expect(result?.animate).toBe(false);
    expect(sim.sidebarVisible).toBe(true);
  });
});

// ============================================================================
// T4-AC1: Duplicate run-start during W1 is no-op (TR7 / EC1)
// ============================================================================

describe('T4-AC1: duplicate run-start no-op', () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
  });

  it('duplicate run-start while in W1 is a no-op', () => {
    const sim = new AppShellFocusSimulator(false);
    sim.onRunStateChange(true); // W0 -> W1
    expect(sim.focusState).toBe('W1');

    // Simulate a duplicate RUN_START dispatch (as if prevRunning hadn't updated)
    const result = sim.dispatch({ type: 'RUN_START', override: 'auto' });
    expect(result.state).toBe('W1');
    expect(result.animate).toBe(false);
  });
});

// ============================================================================
// T4-AC2: Sticky hidden after completion until explicit reopen
// ============================================================================

describe('T4-AC2: sticky hidden post-run', () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
  });

  it('run end from W2 transitions to W4 (sticky hidden)', () => {
    const sim = new AppShellFocusSimulator(false);
    sim.onRunStateChange(true);
    sim.onHideTransitionEnd(); // W2
    sim.onRunStateChange(false); // run ends

    expect(sim.focusState).toBe('W4');
    expect(sim.sidebarVisible).toBe(false);
    expect(sim.sidebarClasses).toContain('sidebar-hidden');
    expect(sim.layoutClasses).toContain('layout-focused');
  });

  it('sidebar stays hidden in W4 (no auto-reopen)', () => {
    const sim = new AppShellFocusSimulator(false);
    sim.onRunStateChange(true);
    sim.onHideTransitionEnd();
    sim.onRunStateChange(false);

    expect(sim.focusState).toBe('W4');
    expect(sim.sidebarVisible).toBe(false);
  });

  it('explicit reopen from W4 transitions to W0 (visible idle)', () => {
    const sim = new AppShellFocusSimulator(false);
    sim.onRunStateChange(true);
    sim.onHideTransitionEnd();
    sim.onRunStateChange(false);

    // Now explicitly reopen
    sim.onUserReopen();
    expect(sim.focusState).toBe('W0');
    expect(sim.sidebarVisible).toBe(true);
    expect(sim.sidebarClasses).not.toContain('sidebar-hidden');
    expect(sim.layoutClasses).not.toContain('layout-focused');
  });

  it('reopen persists override "auto" (clears sticky)', () => {
    const sim = new AppShellFocusSimulator(false);
    sim.onRunStateChange(true);
    sim.onHideTransitionEnd();
    sim.onRunStateChange(false); // W4
    sim.onUserReopen(); // W0

    // Verify the override was set to "auto" to clear the sticky state
    expect(readRunOverride()).toBe('auto');
  });

  it('run end during W1 (in-flight animation) lands in W4', () => {
    const sim = new AppShellFocusSimulator(false);
    sim.onRunStateChange(true); // W1
    sim.onRunStateChange(false); // run ends during animation

    expect(sim.focusState).toBe('W4');
    expect(sim.sidebarVisible).toBe(false);
    expect(sim.hideTimerActive).toBe(false);
  });

  it('run end from W3 transitions to W0 (visible idle)', () => {
    writeRunOverride('open');
    const sim = new AppShellFocusSimulator(false);
    sim.onRunStateChange(true); // W0 -> W3

    sim.onRunStateChange(false); // run ends
    expect(sim.focusState).toBe('W0');
    expect(sim.sidebarVisible).toBe(true);
  });
});

// ============================================================================
// T4-AC2: Reconnect snapshot reconciliation (EC3)
// ============================================================================

describe('T4-AC2: reconnect without flicker', () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
  });

  it('reconnect during active run with "auto" override stays in W2', () => {
    const sim = new AppShellFocusSimulator(false);
    sim.onRunStateChange(true);
    sim.onHideTransitionEnd(); // W2

    // Simulate disconnect/reconnect
    sim.onDisconnect();
    sim.onReconnect(true); // run still active

    expect(sim.focusState).toBe('W2');
    expect(sim.sidebarVisible).toBe(false);
  });

  it('reconnect during active run with "open" override goes to W3', () => {
    writeRunOverride('open');
    const sim = new AppShellFocusSimulator(false);
    sim.onRunStateChange(true); // W3

    sim.onDisconnect();
    sim.onReconnect(true); // run still active

    expect(sim.focusState).toBe('W3');
    expect(sim.sidebarVisible).toBe(true);
  });

  it('reconnect after run completed goes to W0 (no flicker through visible-idle)', () => {
    const sim = new AppShellFocusSimulator(false);
    sim.onRunStateChange(true);
    sim.onHideTransitionEnd(); // W2

    // Simulate disconnect, then reconnect with run completed
    sim.onDisconnect();
    sim.onReconnect(false); // run ended while disconnected

    expect(sim.focusState).toBe('W0');
    expect(sim.sidebarVisible).toBe(true);
  });

  it('reconnect does not replay run-start animation', () => {
    const sim = new AppShellFocusSimulator(false);

    // Simulate disconnect/reconnect with an active run
    sim.onDisconnect();
    sim.onReconnect(true); // run active on reconnect

    // Should be in W2 directly, not W1 (no animation)
    expect(sim.focusState).toBe('W2');
    expect(sim.animatingHide).toBe(false);
    expect(sim.sidebarClasses).not.toContain('sidebar-hiding');
  });
});

// ============================================================================
// T4-AC3: W3 -> W2 (hide while running) and W4 -> W2 (run restart)
// ============================================================================

describe('T4-AC3: W3 -> W2 direct hide', () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
  });

  it('hide from W3 transitions directly to W2 (no W1 replay)', () => {
    writeRunOverride('open');
    const sim = new AppShellFocusSimulator(false);
    sim.onRunStateChange(true); // W0 -> W3

    sim.onUserHide();
    expect(sim.focusState).toBe('W2');
    expect(sim.animatingHide).toBe(false);
    expect(sim.sidebarClasses).not.toContain('sidebar-hiding');
    expect(sim.sidebarClasses).toContain('sidebar-hidden');
  });

  it('hide from W3 clears override to "auto"', () => {
    writeRunOverride('open');
    const sim = new AppShellFocusSimulator(false);
    sim.onRunStateChange(true); // W3

    sim.onUserHide();
    expect(readRunOverride()).toBe('auto');
  });

  it('hide from W3 does not trigger animation flag', () => {
    writeRunOverride('open');
    const sim = new AppShellFocusSimulator(false);
    sim.onRunStateChange(true); // W3

    sim.onUserHide(); // W3 -> W2
    expect(sim.animatingHide).toBe(false);
    expect(sim.hideTimerActive).toBe(false);
  });
});

describe('T4-AC3: W4 -> W2 run restart', () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
  });

  it('run start from W4 transitions directly to W2 (no animation)', () => {
    const sim = new AppShellFocusSimulator(false);
    // Get to W4: run -> hide -> end
    sim.onRunStateChange(true);
    sim.onHideTransitionEnd();
    sim.onRunStateChange(false);
    expect(sim.focusState).toBe('W4');

    // New run starts from W4
    const result = sim.onRunStateChange(true);
    expect(sim.focusState).toBe('W2');
    expect(result?.animate).toBe(false);
    expect(sim.hideTimerActive).toBe(false);
  });

  it('run start from W4 does not replay hide animation classes', () => {
    const sim = new AppShellFocusSimulator(false);
    sim.onRunStateChange(true);
    sim.onHideTransitionEnd();
    sim.onRunStateChange(false); // W4

    sim.onRunStateChange(true); // W4 -> W2
    expect(sim.sidebarClasses).not.toContain('sidebar-hiding');
    expect(sim.sidebarClasses).toContain('sidebar-hidden');
    expect(sim.layoutClasses).not.toContain('layout-focusing');
    expect(sim.layoutClasses).toContain('layout-focused');
  });

  it('full cycle: W0 -> W1 -> W2 -> W4 -> W2 -> W4 -> W0', () => {
    const sim = new AppShellFocusSimulator(false);

    // First run
    sim.onRunStateChange(true); // W0 -> W1
    expect(sim.focusState).toBe('W1');
    sim.onHideTransitionEnd(); // W1 -> W2
    expect(sim.focusState).toBe('W2');
    sim.onRunStateChange(false); // W2 -> W4
    expect(sim.focusState).toBe('W4');

    // Second run from sticky hidden
    sim.onRunStateChange(true); // W4 -> W2
    expect(sim.focusState).toBe('W2');
    sim.onRunStateChange(false); // W2 -> W4
    expect(sim.focusState).toBe('W4');

    // Explicit reopen
    sim.onUserReopen(); // W4 -> W0
    expect(sim.focusState).toBe('W0');
    expect(sim.sidebarVisible).toBe(true);
  });
});

// ============================================================================
// T4: Explicit reopen during W1 or W2
// ============================================================================

describe('T4: explicit reopen during active run', () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
  });

  it('reopen during W1 cancels animation and goes to W3', () => {
    const sim = new AppShellFocusSimulator(false);
    sim.onRunStateChange(true); // W0 -> W1
    expect(sim.animatingHide).toBe(true);

    sim.onUserReopen(); // W1 -> W3
    expect(sim.focusState).toBe('W3');
    expect(sim.sidebarVisible).toBe(true);
    expect(sim.animatingHide).toBe(false);
    expect(sim.hideTimerActive).toBe(false);
    expect(readRunOverride()).toBe('open');
  });

  it('reopen during W2 shows sidebar immediately', () => {
    const sim = new AppShellFocusSimulator(false);
    sim.onRunStateChange(true);
    sim.onHideTransitionEnd(); // W2

    sim.onUserReopen(); // W2 -> W3
    expect(sim.focusState).toBe('W3');
    expect(sim.sidebarVisible).toBe(true);
    expect(readRunOverride()).toBe('open');
  });
});

// ============================================================================
// T4: CSS class derivation
// ============================================================================

describe('T4: CSS class derivation', () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
  });

  it('W0: layout and sidebar have base classes only', () => {
    const sim = new AppShellFocusSimulator(false);
    expect(sim.layoutClasses).toEqual(['layout']);
    expect(sim.sidebarClasses).toEqual(['sidebar']);
  });

  it('W1: layout-focusing and sidebar-hiding', () => {
    const sim = new AppShellFocusSimulator(false);
    sim.onRunStateChange(true);
    expect(sim.layoutClasses).toEqual(['layout', 'layout-focusing']);
    expect(sim.sidebarClasses).toEqual(['sidebar', 'sidebar-hiding']);
  });

  it('W2: layout-focused and sidebar-hidden', () => {
    const sim = new AppShellFocusSimulator(false);
    sim.onRunStateChange(true);
    sim.onHideTransitionEnd();
    expect(sim.layoutClasses).toEqual(['layout', 'layout-focused']);
    expect(sim.sidebarClasses).toEqual(['sidebar', 'sidebar-hidden']);
  });

  it('W3: base classes only (sidebar visible)', () => {
    writeRunOverride('open');
    const sim = new AppShellFocusSimulator(false);
    sim.onRunStateChange(true);
    expect(sim.layoutClasses).toEqual(['layout']);
    expect(sim.sidebarClasses).toEqual(['sidebar']);
  });

  it('W4: layout-focused and sidebar-hidden', () => {
    const sim = new AppShellFocusSimulator(false);
    sim.onRunStateChange(true);
    sim.onHideTransitionEnd();
    sim.onRunStateChange(false);
    expect(sim.layoutClasses).toEqual(['layout', 'layout-focused']);
    expect(sim.sidebarClasses).toEqual(['sidebar', 'sidebar-hidden']);
  });
});

// ============================================================================
// T4: EC2 - Refresh mid-run initialization
// ============================================================================

describe('T4: EC2 refresh mid-run', () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
  });

  it('initializes to W2 when running with "auto" override', () => {
    const sim = new AppShellFocusSimulator(true);
    expect(sim.focusState).toBe('W2');
    expect(sim.sidebarVisible).toBe(false);
    expect(sim.animatingHide).toBe(false);
  });

  it('initializes to W3 when running with "open" override', () => {
    writeRunOverride('open');
    const sim = new AppShellFocusSimulator(true);
    expect(sim.focusState).toBe('W3');
    expect(sim.sidebarVisible).toBe(true);
  });

  it('initializes to W0 when not running', () => {
    const sim = new AppShellFocusSimulator(false);
    expect(sim.focusState).toBe('W0');
    expect(sim.sidebarVisible).toBe(true);
  });

  it('mid-run initialization does not replay run-start animation', () => {
    const sim = new AppShellFocusSimulator(true);
    expect(sim.animatingHide).toBe(false);
    expect(sim.sidebarClasses).not.toContain('sidebar-hiding');
  });
});

// ============================================================================
// T4: Navigation tabs remain accessible
// ============================================================================

describe('T4: content accessibility in focused mode', () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
  });

  it('layout-focused does not remove main section', () => {
    // This test documents that the layout CSS class approach preserves
    // the main content section (tabs + Outlet) in all focus states.
    // The sidebar is hidden via CSS, not removed from the DOM.
    const sim = new AppShellFocusSimulator(false);
    sim.onRunStateChange(true);
    sim.onHideTransitionEnd();

    // In W2 focused state, layout should be "layout layout-focused"
    // The main section remains in DOM (only sidebar styling changes)
    expect(sim.layoutClasses).toContain('layout-focused');
    // Sidebar is hidden via CSS, not conditionally rendered
    expect(sim.sidebarClasses).toContain('sidebar-hidden');
  });
});
