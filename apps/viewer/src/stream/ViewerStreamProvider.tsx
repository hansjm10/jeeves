import type { ReactNode } from 'react';
import { createContext, useContext, useEffect, useReducer, useRef } from 'react';

import { wsUrlFromBaseUrl } from '../api/paths.js';
import type { IssueStateSnapshot, LogEvent } from '../api/types.js';
import { streamReducer } from './streamReducer.js';
import type { StreamState } from './streamTypes.js';

const ViewerStreamContext = createContext<StreamState | null>(null);

const RECONNECT_MS = 600;

export function ViewerStreamProvider(props: { baseUrl: string; children: ReactNode }) {
  const [state, dispatch] = useReducer(streamReducer, {
    connected: false,
    lastError: null,
    state: null,
    logs: [],
    viewerLogs: [],
    sdkEvents: [],
  });

  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let cancelled = false;
    let reconnectTimer: number | null = null;

    function connect() {
      if (cancelled) return;
      const ws = new WebSocket(wsUrlFromBaseUrl(props.baseUrl));
      wsRef.current = ws;

      ws.addEventListener('open', () => {
        dispatch({ type: 'ws_connected' });
      });

      ws.addEventListener('message', (evt) => {
        try {
          const parsed = JSON.parse(String(evt.data)) as { event?: unknown; data?: unknown };
          const event = typeof parsed.event === 'string' ? parsed.event : null;
          if (!event) return;
          if (event === 'state') dispatch({ type: 'state', data: parsed.data as IssueStateSnapshot });
          else if (event === 'logs') dispatch({ type: 'logs', data: parsed.data as LogEvent });
          else if (event === 'viewer-logs') dispatch({ type: 'viewer-logs', data: parsed.data as LogEvent });
          else dispatch({ type: 'sdk', event, data: parsed.data });
        } catch {
          // ignore
        }
      });

      ws.addEventListener('close', () => {
        dispatch({ type: 'ws_disconnected', error: 'WebSocket disconnected' });
        if (cancelled) return;
        reconnectTimer = window.setTimeout(connect, RECONNECT_MS);
      });

      ws.addEventListener('error', () => {
        dispatch({ type: 'ws_disconnected', error: 'WebSocket error' });
      });
    }

    connect();
    return () => {
      cancelled = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      try {
        wsRef.current?.close();
      } catch {
        // ignore
      }
      wsRef.current = null;
    };
  }, [props.baseUrl]);

  return <ViewerStreamContext.Provider value={state}>{props.children}</ViewerStreamContext.Provider>;
}

export function useViewerStream(): StreamState {
  const value = useContext(ViewerStreamContext);
  if (!value) throw new Error('useViewerStream must be used within ViewerStreamProvider');
  return value;
}
