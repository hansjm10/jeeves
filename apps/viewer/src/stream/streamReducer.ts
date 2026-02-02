import type { RunStatus } from '../api/types.js';
import type { StreamAction, StreamState } from './streamTypes.js';

export const MAX_LOG_LINES = 10_000;
export const MAX_SDK_EVENTS = 500;

/**
 * Extended stream state with runOverride for live run updates.
 * When a `run` websocket event arrives, it is stored in runOverride.
 * When a `state` snapshot arrives, runOverride is cleared (snapshot supersedes).
 * UI consumers should use `effectiveRun` which is pre-computed as `runOverride ?? state?.run`.
 */
export type ExtendedStreamState = StreamState & {
  runOverride: RunStatus | null;
  /** Pre-computed effective run status: runOverride ?? state?.run. UI consumers should use this. */
  effectiveRun: RunStatus | null;
};

/** Action for live run updates from the viewer-server */
export type RunAction = { type: 'run'; data: { run: RunStatus } };

/** Extended action type that includes the run action */
export type ExtendedStreamAction = StreamAction | RunAction;

export function capArray<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  return items.slice(items.length - max);
}

export function streamReducer(
  state: ExtendedStreamState,
  action: ExtendedStreamAction
): ExtendedStreamState {
  switch (action.type) {
    case 'ws_connected':
      return { ...state, connected: true, lastError: null };
    case 'ws_disconnected':
      return { ...state, connected: false, lastError: action.error ?? state.lastError };
    case 'state': {
      // Clear runOverride when a state snapshot arrives (snapshot supersedes prior run updates)
      const newState = action.data;
      return { ...state, state: newState, runOverride: null, effectiveRun: newState.run };
    }
    case 'run': {
      // Store live run update in runOverride (supersedes snapshot until next snapshot)
      const runOverride = action.data.run;
      return { ...state, runOverride, effectiveRun: runOverride };
    }
    case 'logs': {
      const next = action.data.reset ? action.data.lines : [...state.logs, ...action.data.lines];
      return { ...state, logs: capArray(next, MAX_LOG_LINES) };
    }
    case 'viewer-logs': {
      const next = action.data.reset ? action.data.lines : [...state.viewerLogs, ...action.data.lines];
      return { ...state, viewerLogs: capArray(next, MAX_LOG_LINES) };
    }
    case 'sdk': {
      const next = [...state.sdkEvents, { event: action.event, data: action.data }];
      return { ...state, sdkEvents: capArray(next, MAX_SDK_EVENTS) };
    }
    default:
      return state;
  }
}

