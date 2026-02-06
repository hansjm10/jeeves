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

// ============================================================================
// T6: AppShell/Header Integration Tests
// ============================================================================

/**
 * Header control derivation helper (mirrors Header.tsx logic).
 *
 * Computes focused-mode control visibility, label, and action type
 * from the current focus state, exactly as Header.tsx does.
 */
function deriveHeaderControl(focusState: FocusState) {
  const showFocusControl = focusState !== 'W0';
  const sidebarVisible = isSidebarVisible(focusState);

  return {
    showFocusControl,
    label: sidebarVisible ? 'Hide Sidebar' : 'Show Sidebar',
    action: sidebarVisible ? ('hide' as const) : ('reopen' as const),
  };
}

// ============================================================================
// T6-AC1: Run-start W0 -> W1 -> W2 path under override "auto" and no
//         duplicate restart on repeated run-start signals
// ============================================================================

describe('T6-AC1: integrated run-start W0 -> W1 -> W2 with Header controls', () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
  });

  it('W0: Header shows no focus control before run starts', () => {
    const sim = new AppShellFocusSimulator(false);
    const header = deriveHeaderControl(sim.focusState);
    expect(sim.focusState).toBe('W0');
    expect(header.showFocusControl).toBe(false);
  });

  it('W0 -> W1: run start with "auto" begins hide, Header shows "Show Sidebar"', () => {
    const sim = new AppShellFocusSimulator(false);
    sim.onRunStateChange(true);

    expect(sim.focusState).toBe('W1');
    expect(sim.animatingHide).toBe(true);
    expect(sim.sidebarClasses).toContain('sidebar-hiding');

    const header = deriveHeaderControl(sim.focusState);
    expect(header.showFocusControl).toBe(true);
    expect(header.label).toBe('Show Sidebar');
    expect(header.action).toBe('reopen');
  });

  it('W1 -> W2: transition end settles hidden, Header still shows "Show Sidebar"', () => {
    const sim = new AppShellFocusSimulator(false);
    sim.onRunStateChange(true);
    sim.onHideTransitionEnd();

    expect(sim.focusState).toBe('W2');
    expect(sim.sidebarVisible).toBe(false);
    expect(sim.animatingHide).toBe(false);
    expect(sim.sidebarClasses).toContain('sidebar-hidden');
    expect(sim.layoutClasses).toContain('layout-focused');

    const header = deriveHeaderControl(sim.focusState);
    expect(header.showFocusControl).toBe(true);
    expect(header.label).toBe('Show Sidebar');
    expect(header.action).toBe('reopen');
  });

  it('full W0 -> W1 -> W2 path: layout classes and Header controls transition correctly', () => {
    const sim = new AppShellFocusSimulator(false);

    // W0: idle
    expect(sim.focusState).toBe('W0');
    expect(deriveHeaderControl(sim.focusState).showFocusControl).toBe(false);
    expect(sim.layoutClasses).toEqual(['layout']);

    // W0 -> W1: run starts
    sim.onRunStateChange(true);
    expect(sim.focusState).toBe('W1');
    expect(deriveHeaderControl(sim.focusState).showFocusControl).toBe(true);
    expect(sim.layoutClasses).toContain('layout-focusing');

    // W1 -> W2: transition completes
    sim.onHideTransitionEnd();
    expect(sim.focusState).toBe('W2');
    expect(deriveHeaderControl(sim.focusState).label).toBe('Show Sidebar');
    expect(sim.layoutClasses).toContain('layout-focused');
  });

  it('duplicate RUN_START from W1 is a no-op, Header control unchanged', () => {
    const sim = new AppShellFocusSimulator(false);
    sim.onRunStateChange(true); // W0 -> W1
    expect(sim.focusState).toBe('W1');

    const headerBefore = deriveHeaderControl(sim.focusState);

    // Duplicate dispatch (simulating rapid double signal)
    const result = sim.dispatch({ type: 'RUN_START', override: 'auto' });
    expect(result.state).toBe('W1');
    expect(result.animate).toBe(false);

    const headerAfter = deriveHeaderControl(sim.focusState);
    expect(headerAfter.showFocusControl).toBe(headerBefore.showFocusControl);
    expect(headerAfter.label).toBe(headerBefore.label);
    expect(headerAfter.action).toBe(headerBefore.action);
  });

  it('duplicate RUN_START from W2 is a no-op, state stays W2', () => {
    const sim = new AppShellFocusSimulator(false);
    sim.onRunStateChange(true);
    sim.onHideTransitionEnd(); // W2

    const result = sim.dispatch({ type: 'RUN_START', override: 'auto' });
    expect(result.state).toBe('W2');
    expect(result.animate).toBe(false);
    expect(sim.focusState).toBe('W2');
  });

  it('repeated run-start signals do not accumulate animation timers', () => {
    const sim = new AppShellFocusSimulator(false);

    // First run start
    sim.onRunStateChange(true); // W0 -> W1
    expect(sim.hideTimerActive).toBe(true);

    // Duplicate dispatch at reducer level (no-op)
    sim.dispatch({ type: 'RUN_START', override: 'auto' });
    // Timer state unchanged — the simulator only sets hideTimerActive on animate=true
    expect(sim.focusState).toBe('W1');
    expect(sim.hideTimerActive).toBe(true);
  });
});

// ============================================================================
// T6-AC2: Explicit reopen during in-flight/hidden focused states and
//         explicit hide from W3 to W2 with override clearing
// ============================================================================

describe('T6-AC2: integrated reopen during in-flight W1 with Header controls', () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
  });

  it('reopen from W1 via Header: sidebar visible, Header shows "Hide Sidebar", override "open" persisted', () => {
    const sim = new AppShellFocusSimulator(false);
    sim.onRunStateChange(true); // W0 -> W1

    // Simulate Header reopen action
    sim.onUserReopen(); // W1 -> W3
    expect(sim.focusState).toBe('W3');
    expect(sim.sidebarVisible).toBe(true);
    expect(sim.animatingHide).toBe(false);
    expect(sim.hideTimerActive).toBe(false);
    expect(readRunOverride()).toBe('open');

    const header = deriveHeaderControl(sim.focusState);
    expect(header.showFocusControl).toBe(true);
    expect(header.label).toBe('Hide Sidebar');
    expect(header.action).toBe('hide');
  });

  it('reopen from W1 cancels animation classes on sidebar and layout', () => {
    const sim = new AppShellFocusSimulator(false);
    sim.onRunStateChange(true); // W1
    expect(sim.sidebarClasses).toContain('sidebar-hiding');
    expect(sim.layoutClasses).toContain('layout-focusing');

    sim.onUserReopen(); // W1 -> W3
    expect(sim.sidebarClasses).not.toContain('sidebar-hiding');
    expect(sim.sidebarClasses).not.toContain('sidebar-hidden');
    expect(sim.layoutClasses).not.toContain('layout-focusing');
    expect(sim.layoutClasses).not.toContain('layout-focused');
  });
});

describe('T6-AC2: integrated reopen during hidden W2 with Header controls', () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
  });

  it('reopen from W2 via Header: sidebar visible, override "open" persisted', () => {
    const sim = new AppShellFocusSimulator(false);
    sim.onRunStateChange(true);
    sim.onHideTransitionEnd(); // W2

    sim.onUserReopen(); // W2 -> W3
    expect(sim.focusState).toBe('W3');
    expect(sim.sidebarVisible).toBe(true);
    expect(readRunOverride()).toBe('open');

    const header = deriveHeaderControl(sim.focusState);
    expect(header.label).toBe('Hide Sidebar');
  });

  it('reopen from W2 removes hidden CSS classes', () => {
    const sim = new AppShellFocusSimulator(false);
    sim.onRunStateChange(true);
    sim.onHideTransitionEnd(); // W2
    expect(sim.sidebarClasses).toContain('sidebar-hidden');
    expect(sim.layoutClasses).toContain('layout-focused');

    sim.onUserReopen(); // W2 -> W3
    expect(sim.sidebarClasses).not.toContain('sidebar-hidden');
    expect(sim.layoutClasses).not.toContain('layout-focused');
  });
});

describe('T6-AC2: integrated hide from W3 to W2 with override clearing', () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
  });

  it('hide from W3 via Header: transitions to W2, clears override, Header updates', () => {
    writeRunOverride('open');
    const sim = new AppShellFocusSimulator(false);
    sim.onRunStateChange(true); // W0 -> W3 (override "open")
    expect(sim.focusState).toBe('W3');

    // Simulate Header hide action
    sim.onUserHide(); // W3 -> W2
    expect(sim.focusState).toBe('W2');
    expect(sim.sidebarVisible).toBe(false);
    expect(sim.animatingHide).toBe(false);
    expect(readRunOverride()).toBe('auto');

    const header = deriveHeaderControl(sim.focusState);
    expect(header.showFocusControl).toBe(true);
    expect(header.label).toBe('Show Sidebar');
    expect(header.action).toBe('reopen');
  });

  it('hide from W3 does not replay run-start animation (no W1 step)', () => {
    writeRunOverride('open');
    const sim = new AppShellFocusSimulator(false);
    sim.onRunStateChange(true); // W3

    sim.onUserHide(); // W3 -> W2 (direct)
    expect(sim.focusState).toBe('W2');
    expect(sim.animatingHide).toBe(false);
    expect(sim.sidebarClasses).not.toContain('sidebar-hiding');
    expect(sim.sidebarClasses).toContain('sidebar-hidden');
  });

  it('reopen-then-hide round-trip: W2 -> W3 -> W2 with correct overrides', () => {
    const sim = new AppShellFocusSimulator(false);
    sim.onRunStateChange(true);
    sim.onHideTransitionEnd(); // W2

    // Header reopen
    sim.onUserReopen(); // W2 -> W3
    expect(sim.focusState).toBe('W3');
    expect(readRunOverride()).toBe('open');
    expect(deriveHeaderControl(sim.focusState).label).toBe('Hide Sidebar');

    // Header hide
    sim.onUserHide(); // W3 -> W2
    expect(sim.focusState).toBe('W2');
    expect(readRunOverride()).toBe('auto');
    expect(deriveHeaderControl(sim.focusState).label).toBe('Show Sidebar');
  });

  it('multiple reopen-hide cycles maintain correct state', () => {
    const sim = new AppShellFocusSimulator(false);
    sim.onRunStateChange(true);
    sim.onHideTransitionEnd(); // W2

    for (let i = 0; i < 3; i++) {
      sim.onUserReopen(); // W2 -> W3
      expect(sim.focusState).toBe('W3');
      expect(readRunOverride()).toBe('open');
      expect(deriveHeaderControl(sim.focusState).label).toBe('Hide Sidebar');

      sim.onUserHide(); // W3 -> W2
      expect(sim.focusState).toBe('W2');
      expect(readRunOverride()).toBe('auto');
      expect(deriveHeaderControl(sim.focusState).label).toBe('Show Sidebar');
    }
  });
});

// ============================================================================
// T6-AC3: Completion/restart behavior (W2 -> W4, W4 -> W2) without
//         replaying run-start animation
// ============================================================================

describe('T6-AC3: integrated completion W2 -> W4 with Header controls', () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
  });

  it('run end from W2: transitions to W4, sidebar stays hidden, Header shows "Show Sidebar"', () => {
    const sim = new AppShellFocusSimulator(false);
    sim.onRunStateChange(true);
    sim.onHideTransitionEnd(); // W2
    sim.onRunStateChange(false); // W2 -> W4

    expect(sim.focusState).toBe('W4');
    expect(sim.sidebarVisible).toBe(false);
    expect(sim.sidebarClasses).toContain('sidebar-hidden');
    expect(sim.layoutClasses).toContain('layout-focused');

    const header = deriveHeaderControl(sim.focusState);
    expect(header.showFocusControl).toBe(true);
    expect(header.label).toBe('Show Sidebar');
    expect(header.action).toBe('reopen');
  });

  it('W4 sticky hidden persists until explicit reopen via Header', () => {
    const sim = new AppShellFocusSimulator(false);
    sim.onRunStateChange(true);
    sim.onHideTransitionEnd();
    sim.onRunStateChange(false); // W4

    // Sidebar remains hidden (no auto-reopen)
    expect(sim.focusState).toBe('W4');
    expect(sim.sidebarVisible).toBe(false);

    // Explicit reopen via Header
    sim.onUserReopen(); // W4 -> W0
    expect(sim.focusState).toBe('W0');
    expect(sim.sidebarVisible).toBe(true);
    expect(readRunOverride()).toBe('auto');

    const header = deriveHeaderControl(sim.focusState);
    expect(header.showFocusControl).toBe(false);
  });
});

describe('T6-AC3: integrated restart W4 -> W2 without animation replay', () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
  });

  it('new run from W4: transitions directly to W2, no W1 animation step', () => {
    const sim = new AppShellFocusSimulator(false);
    // Get to W4
    sim.onRunStateChange(true);
    sim.onHideTransitionEnd();
    sim.onRunStateChange(false); // W4

    // New run starts
    const result = sim.onRunStateChange(true); // W4 -> W2
    expect(sim.focusState).toBe('W2');
    expect(result?.animate).toBe(false);
    expect(sim.hideTimerActive).toBe(false);
    expect(sim.animatingHide).toBe(false);
  });

  it('W4 -> W2 restart: no animation CSS classes applied', () => {
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

  it('W4 -> W2 restart: Header control stays "Show Sidebar"', () => {
    const sim = new AppShellFocusSimulator(false);
    sim.onRunStateChange(true);
    sim.onHideTransitionEnd();
    sim.onRunStateChange(false); // W4

    sim.onRunStateChange(true); // W4 -> W2

    const header = deriveHeaderControl(sim.focusState);
    expect(header.showFocusControl).toBe(true);
    expect(header.label).toBe('Show Sidebar');
    expect(header.action).toBe('reopen');
  });

  it('full cycle: W0 -> W1 -> W2 -> W4 -> W2 -> W4 -> W0 with Header controls at each step', () => {
    const sim = new AppShellFocusSimulator(false);

    // W0: idle
    expect(sim.focusState).toBe('W0');
    expect(deriveHeaderControl(sim.focusState).showFocusControl).toBe(false);

    // First run: W0 -> W1 -> W2
    sim.onRunStateChange(true);
    expect(sim.focusState).toBe('W1');
    expect(deriveHeaderControl(sim.focusState).label).toBe('Show Sidebar');
    sim.onHideTransitionEnd();
    expect(sim.focusState).toBe('W2');
    expect(deriveHeaderControl(sim.focusState).label).toBe('Show Sidebar');

    // Run ends: W2 -> W4
    sim.onRunStateChange(false);
    expect(sim.focusState).toBe('W4');
    expect(deriveHeaderControl(sim.focusState).label).toBe('Show Sidebar');

    // Second run from sticky hidden: W4 -> W2 (no animation)
    const restartResult = sim.onRunStateChange(true);
    expect(sim.focusState).toBe('W2');
    expect(restartResult?.animate).toBe(false);
    expect(sim.animatingHide).toBe(false);
    expect(deriveHeaderControl(sim.focusState).label).toBe('Show Sidebar');

    // Second run ends: W2 -> W4
    sim.onRunStateChange(false);
    expect(sim.focusState).toBe('W4');

    // Explicit reopen via Header: W4 -> W0
    sim.onUserReopen();
    expect(sim.focusState).toBe('W0');
    expect(deriveHeaderControl(sim.focusState).showFocusControl).toBe(false);
    expect(sim.sidebarVisible).toBe(true);
  });

  it('W4 -> W2 -> W4 consecutive restarts: never enters W1', () => {
    const sim = new AppShellFocusSimulator(false);
    // Initial run to reach W4
    sim.onRunStateChange(true);
    sim.onHideTransitionEnd();
    sim.onRunStateChange(false);
    expect(sim.focusState).toBe('W4');

    // Three consecutive restart cycles from W4
    for (let i = 0; i < 3; i++) {
      const result = sim.onRunStateChange(true); // W4 -> W2
      expect(sim.focusState).toBe('W2');
      expect(result?.animate).toBe(false);
      expect(sim.animatingHide).toBe(false);

      sim.onRunStateChange(false); // W2 -> W4
      expect(sim.focusState).toBe('W4');
    }
  });

  it('reopen during W2 after restart from W4: transitions to W3 with override', () => {
    const sim = new AppShellFocusSimulator(false);
    // Get to W4, then restart
    sim.onRunStateChange(true);
    sim.onHideTransitionEnd();
    sim.onRunStateChange(false); // W4
    sim.onRunStateChange(true); // W4 -> W2

    // Reopen during the restarted run
    sim.onUserReopen(); // W2 -> W3
    expect(sim.focusState).toBe('W3');
    expect(readRunOverride()).toBe('open');
    expect(deriveHeaderControl(sim.focusState).label).toBe('Hide Sidebar');

    // Run ends from W3: back to W0
    sim.onRunStateChange(false);
    expect(sim.focusState).toBe('W0');
    expect(sim.sidebarVisible).toBe(true);
  });
});
