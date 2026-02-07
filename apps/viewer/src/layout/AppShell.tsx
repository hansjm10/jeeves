import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useBlocker } from 'react-router-dom';

import { useViewerServerBaseUrl } from '../app/ViewerServerProvider.js';
import { useViewerStream } from '../stream/ViewerStreamProvider.js';
import { useUnsavedChanges } from '../ui/unsaved/UnsavedChangesProvider.js';
import { Header } from './Header.js';
import { Sidebar } from './Sidebar.js';
import {
  type FocusState,
  type RunOverride,
  readRunOverride,
  writeRunOverride,
  focusReducer,
  deriveFocusState,
  isSidebarVisible,
  isAnimating,
} from './runFocusState.js';

/**
 * Context for focused-mode state and actions.
 *
 * Allows child components (e.g. Header) to access the current focus state
 * and trigger user reopen/hide actions without prop drilling.
 */
export interface FocusContext {
  focusState: FocusState;
  onUserReopen: () => void;
  onUserHide: () => void;
}

const FocusModeContext = createContext<FocusContext | null>(null);

/**
 * Hook to access the focused-mode context from child components.
 * Returns null when used outside AppShell (safe for optional consumption).
 */
export function useFocusMode(): FocusContext | null {
  return useContext(FocusModeContext);
}

function TabLink(props: { to: string; label: string }) {
  return (
    <NavLink to={props.to} className={({ isActive }) => `tab ${isActive ? 'active' : ''}`}>
      {props.label}
    </NavLink>
  );
}

/**
 * Derive the initial focus state on first render.
 *
 * Handles EC2 (refresh mid-run): if the run is already active when the
 * component mounts, derive from the snapshot without replaying a run-start
 * animation.
 */
function deriveInitialFocusState(running: boolean): FocusState {
  const override = readRunOverride();
  return deriveFocusState({ running, override });
}

/** CSS transition duration fallback timer (ms). Matches the 150-200ms envelope. */
const HIDE_TRANSITION_FALLBACK_MS = 220;

export function AppShell() {
  const baseUrl = useViewerServerBaseUrl();
  const stream = useViewerStream();
  const runRunning = stream.state?.run.running ?? false;
  const connected = stream.connected;
  const hasReceivedSnapshot = stream.state !== null;
  const { isDirty, confirmDiscard } = useUnsavedChanges();
  const blocker = useBlocker(isDirty);
  const hasPromptedRef = useRef(false);

  // --- Focus state management ---
  const [focusState, setFocusState] = useState<FocusState>(() =>
    deriveInitialFocusState(runRunning),
  );
  const focusStateRef = useRef<FocusState>(focusState);
  const prevRunningRef = useRef<boolean>(runRunning);
  const prevConnectedRef = useRef<boolean>(connected);
  /**
   * Tracks whether the initial state snapshot has been processed for focus-state
   * hydration. On page refresh, the websocket `open` event fires before the first
   * `state` snapshot, so `runRunning` starts as `false`. Without this guard, the
   * first snapshot with `running=true` would trigger a `RUN_START` dispatch
   * (entering W1 with animation) instead of hydrating directly to W2/W3 (EC2).
   */
  const hasHydratedRef = useRef<boolean>(stream.state !== null);
  const hideTimerRef = useRef<number | null>(null);
  const sidebarRef = useRef<HTMLElement | null>(null);

  /** Apply a focus transition and handle persistence side effects. */
  const applyTransition = useCallback(
    (nextState: FocusState, persistOverride: RunOverride | null) => {
      focusStateRef.current = nextState;
      setFocusState(nextState);
      if (persistOverride !== null) {
        writeRunOverride(persistOverride);
      }
    },
    [],
  );

  /** Dispatch a focus action through the reducer and apply the result. */
  const dispatch = useCallback(
    (action: Parameters<typeof focusReducer>[1]) => {
      const result = focusReducer(focusStateRef.current, action);
      applyTransition(result.state, result.persistOverride);
      return result;
    },
    [applyTransition],
  );

  // --- Run state change detection ---
  useEffect(() => {
    const wasRunning = prevRunningRef.current;
    prevRunningRef.current = runRunning;

    // EC2 hydration gate: When the first state snapshot arrives after page
    // refresh (connected before snapshot), derive focus state directly from
    // the snapshot rather than dispatching RUN_START. This prevents replaying
    // the run-start hide animation on refresh mid-run.
    if (!hasHydratedRef.current && hasReceivedSnapshot) {
      hasHydratedRef.current = true;
      // Derive the correct state from the initial snapshot (hydration path)
      const override = readRunOverride();
      const derived = deriveFocusState({ running: runRunning, override });
      applyTransition(derived, null);
      return;
    }

    if (!wasRunning && runRunning) {
      // Run started: false -> true
      const override = readRunOverride();
      const result = dispatch({ type: 'RUN_START', override });

      if (result.animate) {
        // Start the hide transition fallback timer (in case transitionend doesn't fire)
        if (hideTimerRef.current !== null) {
          window.clearTimeout(hideTimerRef.current);
        }
        hideTimerRef.current = window.setTimeout(() => {
          hideTimerRef.current = null;
          if (focusStateRef.current === 'W1') {
            dispatch({ type: 'HIDE_TRANSITION_END' });
          }
        }, HIDE_TRANSITION_FALLBACK_MS);
      }
    } else if (wasRunning && !runRunning) {
      // Run ended: true -> false
      dispatch({ type: 'RUN_END' });
      // Clean up any in-flight hide timer
      if (hideTimerRef.current !== null) {
        window.clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
    }
  }, [runRunning, hasReceivedSnapshot, dispatch, applyTransition]);

  // --- Reconnect snapshot reconciliation (EC3) ---
  useEffect(() => {
    const wasConnected = prevConnectedRef.current;
    prevConnectedRef.current = connected;

    if (!wasConnected && connected && stream.state) {
      // Reconnected with a snapshot — derive state from the snapshot
      // and previous focus state to avoid flicker through visible-idle.
      // When the run ended while disconnected, previousState allows
      // reconciliation to W4 (hidden prior) or W0 (visible prior).
      const override = readRunOverride();
      const derived = deriveFocusState({
        running: stream.state.run.running,
        override,
        previousState: focusStateRef.current,
      });
      applyTransition(derived, null);
    }
  }, [connected, stream.state, applyTransition]);

  // --- Sidebar transitionend handler ---
  useEffect(() => {
    const sidebar = sidebarRef.current;
    if (!sidebar) return;

    function onTransitionEnd() {
      if (focusStateRef.current === 'W1') {
        dispatch({ type: 'HIDE_TRANSITION_END' });
        // Clear fallback timer since transition completed normally
        if (hideTimerRef.current !== null) {
          window.clearTimeout(hideTimerRef.current);
          hideTimerRef.current = null;
        }
      }
    }

    sidebar.addEventListener('transitionend', onTransitionEnd);
    return () => sidebar.removeEventListener('transitionend', onTransitionEnd);
  }, [dispatch]);

  // --- Clean up hide timer on unmount ---
  useEffect(() => {
    return () => {
      if (hideTimerRef.current !== null) {
        window.clearTimeout(hideTimerRef.current);
      }
    };
  }, []);

  // --- User actions (exposed to Header via props) ---
  const handleUserReopen = useCallback(() => {
    dispatch({ type: 'USER_REOPEN' });
    // Cancel any in-flight hide animation timer
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, [dispatch]);

  const handleUserHide = useCallback(() => {
    dispatch({ type: 'USER_HIDE' });
  }, [dispatch]);

  // --- Navigation blocker ---
  useEffect(() => {
    if (blocker.state !== 'blocked') {
      hasPromptedRef.current = false;
      return;
    }
    if (hasPromptedRef.current) return;
    hasPromptedRef.current = true;
    if (confirmDiscard()) blocker.proceed();
    else blocker.reset();
  }, [blocker, blocker.state, confirmDiscard]);

  // --- Derived layout state ---
  const sidebarVisible = isSidebarVisible(focusState);
  const animatingHide = isAnimating(focusState);

  // Build layout CSS classes for focused mode
  const layoutClasses = ['layout'];
  if (!sidebarVisible && !animatingHide) {
    layoutClasses.push('layout-focused');
  }
  if (animatingHide) {
    layoutClasses.push('layout-focusing');
  }

  // Build sidebar CSS classes
  const sidebarClasses = ['sidebar'];
  if (!sidebarVisible && !animatingHide) {
    sidebarClasses.push('sidebar-hidden');
  }
  if (animatingHide) {
    sidebarClasses.push('sidebar-hiding');
  }

  const focusContextValue: FocusContext = {
    focusState,
    onUserReopen: handleUserReopen,
    onUserHide: handleUserHide,
  };

  return (
    <FocusModeContext.Provider value={focusContextValue}>
      <div className="app">
        <Header baseUrl={baseUrl} connected={connected} runRunning={runRunning} />
        <main className={layoutClasses.join(' ')}>
          <aside className={sidebarClasses.join(' ')} ref={sidebarRef}>
            <Sidebar />
          </aside>
          <section className="main">
            <div className="tabs">
              <TabLink to="/watch" label="watch" />
              <TabLink to="/workflows" label="workflows" />
              <TabLink to="/create-issue" label="create-issue" />
              <TabLink to="/sonar-token" label="sonar-token" />
              <TabLink to="/azure-devops" label="azure-devops" />
              <TabLink to="/prompts" label="prompts" />
            </div>
            <Outlet />
          </section>
        </main>
      </div>
    </FocusModeContext.Provider>
  );
}
