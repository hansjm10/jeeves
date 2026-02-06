/**
 * Run-focus sidebar override storage primitives and focus-state transition model.
 *
 * Provides safe read/write helpers for the `jeeves.watch.sidebar.runOverride`
 * localStorage key, which controls whether the sidebar is automatically hidden
 * during active runs ("auto") or explicitly kept open by the user ("open").
 *
 * Also provides a deterministic state model (W0-W4) and transition reducer
 * (TR1-TR9) for focused-mode sidebar visibility derivation, including
 * hydration and reconnect reconciliation rules.
 *
 * Design contract (Sections 2 & 4 of issue-71-design.md):
 * - Allowed values: exact `"auto"` or `"open"` (case-sensitive).
 * - Absent, invalid, or unreadable values resolve to `"auto"`.
 * - Read/write helpers never throw, even when localStorage is unavailable.
 * - State transitions are deterministic per TR1-TR9 / EC1-EC4.
 */

/** localStorage key for run-time sidebar override. */
export const RUN_OVERRIDE_STORAGE_KEY = 'jeeves.watch.sidebar.runOverride';

/** Normalized run override values consumed by focus-state derivation. */
export type RunOverride = 'auto' | 'open';

/**
 * Parse a raw value into a normalized {@link RunOverride}.
 *
 * Only exact `"auto"` and `"open"` strings are accepted; everything else
 * (including `null`, `undefined`, empty string, casing variants, and
 * unexpected values) resolves to `"auto"`.
 *
 * @param raw - The raw value read from storage (or any unknown source).
 * @returns A normalized `RunOverride`.
 */
export function parseRunOverride(raw: unknown): RunOverride {
  if (raw === 'auto' || raw === 'open') return raw;
  return 'auto';
}

/**
 * Read the persisted run override from localStorage.
 *
 * Never throws. Returns `"auto"` when:
 * - The key is absent.
 * - The stored value is not a recognized override.
 * - localStorage is unavailable or blocked (e.g. private browsing, quota).
 *
 * @returns A normalized `RunOverride`.
 */
export function readRunOverride(): RunOverride {
  try {
    return parseRunOverride(localStorage.getItem(RUN_OVERRIDE_STORAGE_KEY));
  } catch {
    return 'auto';
  }
}

/**
 * Write a run override value to localStorage.
 *
 * Never throws. If localStorage is unavailable or the write fails for any
 * reason, the error is silently swallowed and the caller can continue with
 * in-memory state.
 *
 * @param value - The override value to persist.
 */
export function writeRunOverride(value: RunOverride): void {
  try {
    localStorage.setItem(RUN_OVERRIDE_STORAGE_KEY, value);
  } catch {
    // Ignore — fall back to in-memory behavior for this session.
  }
}

/**
 * Clear the persisted run override from localStorage.
 *
 * Never throws. Subsequent reads will resolve to the default `"auto"`.
 */
export function clearRunOverride(): void {
  try {
    localStorage.removeItem(RUN_OVERRIDE_STORAGE_KEY);
  } catch {
    // Ignore — fall back to in-memory behavior for this session.
  }
}

// ============================================================================
// Focus-state transition model (W0-W4, TR1-TR9)
// ============================================================================

/**
 * UI focus states for sidebar visibility during runs.
 *
 * | State | Conditions | Sidebar |
 * |-------|------------|---------|
 * | W0    | Idle, visible (default) | Visible |
 * | W1    | Run started, hide transition in progress | Transitioning |
 * | W2    | Running, focused hidden | Hidden |
 * | W3    | Running, user override open | Visible |
 * | W4    | Idle, sticky hidden post-run | Hidden |
 */
export type FocusState = 'W0' | 'W1' | 'W2' | 'W3' | 'W4';

/**
 * Actions that drive focus-state transitions (TR1-TR9 + hydration).
 */
export type FocusAction =
  | { type: 'RUN_START'; override: RunOverride }
  | { type: 'HIDE_TRANSITION_END' }
  | { type: 'USER_REOPEN' }
  | { type: 'USER_HIDE' }
  | { type: 'RUN_END' };

/**
 * Result of a focus-state transition, including the new state,
 * whether the run-start animation should play, and any side effects.
 */
export interface FocusTransitionResult {
  /** The new focus state after the transition. */
  state: FocusState;
  /** Whether the 150-200ms run-start hide animation should play. */
  animate: boolean;
  /** Side effect: persist this override value, or null for no persistence change. */
  persistOverride: RunOverride | null;
}

/**
 * Pure, deterministic focus-state transition reducer.
 *
 * Implements transitions TR1-TR9 and edge cases EC1-EC4 from
 * the design document (Section 2 of issue-71-design.md).
 *
 * @param current - The current focus state.
 * @param action - The action triggering the transition.
 * @returns The transition result with new state, animation flag, and persistence side effect.
 */
export function focusReducer(
  current: FocusState,
  action: FocusAction,
): FocusTransitionResult {
  switch (action.type) {
    case 'RUN_START':
      return handleRunStart(current, action.override);
    case 'HIDE_TRANSITION_END':
      return handleHideTransitionEnd(current);
    case 'USER_REOPEN':
      return handleUserReopen(current);
    case 'USER_HIDE':
      return handleUserHide(current);
    case 'RUN_END':
      return handleRunEnd(current);
  }
}

/**
 * Handle RUN_START action.
 *
 * - TR1: W0 -> W1 (override "auto"): start hide animation
 * - W0 with override "open": go to W3 directly (user wants sidebar open)
 * - TR7: W1 -> W1 (duplicate run-start): no-op
 * - TR9: W4 -> W2 (run start from sticky hidden): direct to hidden, no animation
 * - W2, W3: already running, no-op
 */
function handleRunStart(
  current: FocusState,
  override: RunOverride,
): FocusTransitionResult {
  switch (current) {
    case 'W0':
      if (override === 'open') {
        // User explicitly wants sidebar open during runs
        return { state: 'W3', animate: false, persistOverride: null };
      }
      // TR1: Start hide animation
      return { state: 'W1', animate: true, persistOverride: null };

    case 'W1':
      // TR7 (EC1): Duplicate run-start during in-flight hide is a no-op
      return { state: 'W1', animate: false, persistOverride: null };

    case 'W4':
      // TR9 (EC4): Already hidden, go directly to W2 without animation
      return { state: 'W2', animate: false, persistOverride: null };

    case 'W2':
    case 'W3':
      // Already running in some state; no-op
      return { state: current, animate: false, persistOverride: null };
  }
}

/**
 * Handle HIDE_TRANSITION_END action.
 *
 * - TR2: W1 -> W2: hide transition complete, commit hidden focused state
 * - Any other state: no-op (transition already cancelled or irrelevant)
 */
function handleHideTransitionEnd(current: FocusState): FocusTransitionResult {
  if (current === 'W1') {
    // TR2: Commit hidden focused state
    return { state: 'W2', animate: false, persistOverride: null };
  }
  // No-op for all other states
  return { state: current, animate: false, persistOverride: null };
}

/**
 * Handle USER_REOPEN action.
 *
 * - TR3: W1 or W2 -> W3: cancel hide, show sidebar, persist "open"
 * - TR6: W4 -> W0: explicit reopen after run completion
 * - W0, W3: already visible, no-op
 */
function handleUserReopen(current: FocusState): FocusTransitionResult {
  switch (current) {
    case 'W1':
    case 'W2':
      // TR3: Cancel/override hide, show sidebar immediately, persist "open"
      return { state: 'W3', animate: false, persistOverride: 'open' };

    case 'W4':
      // TR6: Explicit reopen after run completion, clear sticky hidden
      return { state: 'W0', animate: false, persistOverride: 'auto' };

    case 'W0':
    case 'W3':
      // Already visible; no-op
      return { state: current, animate: false, persistOverride: null };
  }
}

/**
 * Handle USER_HIDE action.
 *
 * - TR8 (EC1): W3 -> W2: hide while running from override-open,
 *   enter hidden directly (no W1 replay), clear override to "auto"
 * - W0: hide while idle → go to W4 (sticky hidden)
 * - W1, W2, W4: already hidden/hiding, no-op
 */
function handleUserHide(current: FocusState): FocusTransitionResult {
  switch (current) {
    case 'W3':
      // TR8: Direct to hidden focused, no W1 replay animation, clear override
      return { state: 'W2', animate: false, persistOverride: 'auto' };

    case 'W0':
      // User hides sidebar while idle → sticky hidden
      return { state: 'W4', animate: false, persistOverride: null };

    case 'W1':
    case 'W2':
    case 'W4':
      // Already hidden/hiding; no-op
      return { state: current, animate: false, persistOverride: null };
  }
}

/**
 * Handle RUN_END action.
 *
 * - TR4: W2 -> W4: run ends from focused hidden, keep hidden (sticky)
 * - TR5: W3 -> W0: run ends while override open, keep visible
 * - W1 -> W4: run ends during in-flight animation, finish as hidden (EC1)
 * - W0, W4: not running, no-op
 */
function handleRunEnd(current: FocusState): FocusTransitionResult {
  switch (current) {
    case 'W2':
      // TR4: Keep hidden, sticky until explicit reopen
      return { state: 'W4', animate: false, persistOverride: null };

    case 'W3':
      // TR5: Keep sidebar visible, return to idle
      return { state: 'W0', animate: false, persistOverride: null };

    case 'W1':
      // EC1: Run ends during in-flight animation → land in W4 (hidden)
      return { state: 'W4', animate: false, persistOverride: null };

    case 'W0':
    case 'W4':
      // Not running; no-op
      return { state: current, animate: false, persistOverride: null };
  }
}

// ============================================================================
// Hydration / Reconnect derivation (EC2 / EC3)
// ============================================================================

/**
 * Input for initial state derivation on hydration or reconnect.
 */
export interface HydrationInput {
  /** Whether a run is currently active. */
  running: boolean;
  /** The persisted (or in-memory) run override. */
  override: RunOverride;
  /**
   * Whether the caller is in a disconnected state (no snapshot available yet).
   * When true, `previousState` is used to preserve the last known UI state.
   */
  disconnected?: boolean;
  /**
   * The last known focus state before disconnect, used to preserve UI state
   * during transient stream disconnects (EC3). When `disconnected` is true and
   * `previousState` is provided, this value is returned instead of deriving
   * from run/override snapshot data.
   */
  previousState?: FocusState;
}

/**
 * Derive the initial focus state on hydration (page load) or reconnect snapshot.
 *
 * EC2 (refresh mid-run):
 * - If running and override "auto" → W2 (hidden, no run-start animation)
 * - If running and override "open" → W3 (visible)
 * - If not running → W0 (idle visible)
 *
 * EC3 (reconnect): During transient stream disconnect, preserve last known
 * state until reconnect snapshot is available. When `disconnected` is true
 * and a `previousState` is provided, that state is preserved. Once a
 * reconnect snapshot arrives (`disconnected` is false or omitted), derive
 * from snapshot data using reconciliation rules:
 * - If run is active: enter W2 (auto) or W3 (open) by override.
 * - If run is idle and `previousState` is available: reconcile based on
 *   prior visibility — hidden states (W1/W2/W4) → W4, visible states
 *   (W0/W3) → W0. This handles the case where a run ends while disconnected.
 * - If run is idle with no `previousState`: W0 (fresh hydration).
 *
 * @param input - The hydration input with current run state, override, and
 *   optional disconnect/previous-state signals.
 * @returns The derived initial focus state (no animation needed).
 */
export function deriveFocusState(input: HydrationInput): FocusState {
  // EC3: During disconnect, preserve last known state if available.
  if (input.disconnected && input.previousState !== undefined) {
    return input.previousState;
  }

  // EC2 / EC3-reconnect-snapshot: Derive from current run state + override.
  if (input.running) {
    return input.override === 'open' ? 'W3' : 'W2';
  }

  // EC3 idle reconciliation: if a previousState is available (reconnect
  // scenario where run ended while disconnected), reconcile based on
  // whether the prior state was hidden or visible.
  if (input.previousState !== undefined) {
    return isSidebarVisible(input.previousState) ? 'W0' : 'W4';
  }

  return 'W0';
}

/**
 * Whether the sidebar should be visible in a given focus state.
 *
 * Utility for UI components to derive sidebar visibility from state.
 */
export function isSidebarVisible(state: FocusState): boolean {
  return state === 'W0' || state === 'W3';
}

/**
 * Whether a run-start animation is currently in progress.
 *
 * Utility for UI components to know if the hide transition is in flight.
 */
export function isAnimating(state: FocusState): boolean {
  return state === 'W1';
}
