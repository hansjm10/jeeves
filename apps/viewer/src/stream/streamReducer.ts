import type { StreamAction, StreamState } from './streamTypes.js';

export const MAX_LOG_LINES = 10_000;
export const MAX_SDK_EVENTS = 500;

export function capArray<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  return items.slice(items.length - max);
}

export function streamReducer(state: StreamState, action: StreamAction): StreamState {
  switch (action.type) {
    case 'ws_connected':
      return { ...state, connected: true, lastError: null };
    case 'ws_disconnected':
      return { ...state, connected: false, lastError: action.error ?? state.lastError };
    case 'state':
      return { ...state, state: action.data };
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

