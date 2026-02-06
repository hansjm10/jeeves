import type {
  RunStatus,
  SonarTokenStatusEvent,
  AzureDevopsStatusEvent,
  IssueIngestStatusEvent,
} from '../api/types.js';
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
  /** Latest sonar-token-status event (mirrors StreamState for direct access). */
  sonarTokenStatus: SonarTokenStatusEvent | null;
  /** Latest azure-devops-status event (mirrors StreamState for direct access). */
  azureDevopsStatus: AzureDevopsStatusEvent | null;
  /** Latest issue-ingest-status event (mirrors StreamState for direct access). */
  issueIngestStatus: IssueIngestStatusEvent | null;
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
      // Keep sonarTokenStatus as-is (it's updated by dedicated events, not snapshots)
      const newState = action.data;
      return { ...state, state: newState, runOverride: null, effectiveRun: newState.run };
    }
    case 'run': {
      // Store live run update in runOverride (supersedes snapshot until next snapshot)
      // Also update state.run if state exists, so consumers reading state.run get live updates
      const runOverride = action.data.run;
      const newState = state.state ? { ...state.state, run: runOverride } : null;
      return { ...state, state: newState, runOverride, effectiveRun: runOverride };
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
    case 'worker-logs': {
      const { workerId, lines, reset } = action.data;
      const prev = state.workerLogs[workerId] ?? [];
      const next = reset ? lines : [...prev, ...lines];
      return {
        ...state,
        workerLogs: { ...state.workerLogs, [workerId]: capArray(next, MAX_LOG_LINES) },
      };
    }
    case 'worker-sdk': {
      const wid = action.workerId;
      const prev = state.workerSdkEvents[wid] ?? [];
      const next = [...prev, { event: action.event, data: action.data }];
      return {
        ...state,
        workerSdkEvents: { ...state.workerSdkEvents, [wid]: capArray(next, MAX_SDK_EVENTS) },
      };
    }
    case 'sonar-token-status': {
      // Store the latest sonar-token-status event for direct access by consumers
      // This does NOT add to sdkEvents (no noise)
      return { ...state, sonarTokenStatus: action.data };
    }
    case 'azure-devops-status': {
      // Store the latest azure-devops-status event for direct access by consumers
      // This does NOT add to sdkEvents (no noise)
      return { ...state, azureDevopsStatus: action.data };
    }
    case 'issue-ingest-status': {
      // Store the latest issue-ingest-status event for direct access by consumers
      // This does NOT add to sdkEvents (no noise)
      return { ...state, issueIngestStatus: action.data };
    }
    default:
      return state;
  }
}

