import { useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { createContext, useContext, useEffect, useReducer, useRef } from 'react';

import { wsUrlFromBaseUrl } from '../api/paths.js';
import type {
  IssueStateSnapshot,
  LogEvent,
  RunStatus,
  SonarTokenStatusEvent,
  AzureDevopsStatusEvent,
  IssueIngestStatusEvent,
} from '../api/types.js';
import type { WorkerLogEvent } from './streamTypes.js';
import { sonarTokenQueryKey } from '../features/sonarToken/queries.js';
import type { ExtendedStreamState } from './streamReducer.js';
import { streamReducer } from './streamReducer.js';

const ViewerStreamContext = createContext<ExtendedStreamState | null>(null);

const RECONNECT_MS = 600;

export function ViewerStreamProvider(props: { baseUrl: string; children: ReactNode }) {
  const [state, dispatch] = useReducer(streamReducer, {
    connected: false,
    lastError: null,
    state: null,
    logs: [],
    viewerLogs: [],
    sdkEvents: [],
    workerLogs: {},
    workerSdkEvents: {},
    runOverride: null,
    effectiveRun: null,
    sonarTokenStatus: null,
    azureDevopsStatus: null,
    issueIngestStatus: null,
  });

  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let cancelled = false;
    let reconnectTimer: number | null = null;

    function scheduleReconnect() {
      if (cancelled) return;
      if (reconnectTimer) return;
      reconnectTimer = window.setTimeout(connect, RECONNECT_MS);
    }

    function connect() {
      if (cancelled) return;
      reconnectTimer = null;
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
          else if (event === 'run')
            dispatch({ type: 'run', data: parsed.data as { run: RunStatus } });
          else if (event === 'logs') dispatch({ type: 'logs', data: parsed.data as LogEvent });
          else if (event === 'viewer-logs') dispatch({ type: 'viewer-logs', data: parsed.data as LogEvent });
          else if (event === 'worker-logs')
            dispatch({ type: 'worker-logs', data: parsed.data as WorkerLogEvent });
          else if (event === 'sonar-token-status')
            dispatch({ type: 'sonar-token-status', data: parsed.data as SonarTokenStatusEvent });
          else if (event === 'azure-devops-status')
            dispatch({ type: 'azure-devops-status', data: parsed.data as AzureDevopsStatusEvent });
          else if (event === 'issue-ingest-status')
            dispatch({ type: 'issue-ingest-status', data: parsed.data as IssueIngestStatusEvent });
          else {
            // SDK events: check for workerId to route to worker-specific state
            const dataObj = parsed.data as Record<string, unknown> | null;
            const workerId = dataObj && typeof dataObj.workerId === 'string' ? dataObj.workerId : null;
            if (workerId) {
              dispatch({ type: 'worker-sdk', event, data: parsed.data, workerId });
            } else {
              dispatch({ type: 'sdk', event, data: parsed.data });
            }
          }
        } catch {
          dispatch({
            type: 'viewer-logs',
            data: { lines: ['[client] failed to parse websocket message'] },
          });
        }
      });

      ws.addEventListener('close', () => {
        dispatch({ type: 'ws_disconnected', error: 'WebSocket disconnected' });
        scheduleReconnect();
      });

      ws.addEventListener('error', () => {
        dispatch({ type: 'ws_disconnected', error: 'WebSocket error' });
        try {
          ws.close();
        } catch {
          // ignore
        }
        scheduleReconnect();
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

  return (
    <ViewerStreamContext.Provider value={state}>
      <SonarTokenStreamSyncInternal baseUrl={props.baseUrl} />
      {props.children}
    </ViewerStreamContext.Provider>
  );
}

/**
 * Internal component that directly updates the Sonar token query cache when a stream event arrives.
 * This ensures the UI displays the latest status immediately (within one render tick) without
 * requiring a network round-trip.
 *
 * Rendered automatically by ViewerStreamProvider - no need to use directly.
 */
function SonarTokenStreamSyncInternal(props: { baseUrl: string }) {
  const queryClient = useQueryClient();
  const stream = useViewerStream();
  const sonarTokenStatus = stream.sonarTokenStatus;
  const prevEventRef = useRef<SonarTokenStatusEvent | null>(null);

  useEffect(() => {
    if (!sonarTokenStatus) return;

    // Check if this is a different event by comparing all status fields
    // This ensures we catch changes to any field, not just issue_ref/last_attempt_at
    const prevEvent = prevEventRef.current;
    const isNewEvent =
      !prevEvent ||
      prevEvent.issue_ref !== sonarTokenStatus.issue_ref ||
      prevEvent.has_token !== sonarTokenStatus.has_token ||
      prevEvent.worktree_present !== sonarTokenStatus.worktree_present ||
      prevEvent.env_var_name !== sonarTokenStatus.env_var_name ||
      prevEvent.sync_status !== sonarTokenStatus.sync_status ||
      prevEvent.last_attempt_at !== sonarTokenStatus.last_attempt_at ||
      prevEvent.last_success_at !== sonarTokenStatus.last_success_at ||
      prevEvent.last_error !== sonarTokenStatus.last_error;

    if (isNewEvent) {
      // Directly update the query cache with the event data (immediate, no network round-trip)
      // This converts the event to a SonarTokenStatusResponse format
      // Include issueRef in query key to match the query used by useSonarTokenStatus
      queryClient.setQueryData(sonarTokenQueryKey(props.baseUrl, sonarTokenStatus.issue_ref), {
        ok: true as const,
        issue_ref: sonarTokenStatus.issue_ref,
        worktree_present: sonarTokenStatus.worktree_present,
        has_token: sonarTokenStatus.has_token,
        env_var_name: sonarTokenStatus.env_var_name,
        sync_status: sonarTokenStatus.sync_status,
        last_attempt_at: sonarTokenStatus.last_attempt_at,
        last_success_at: sonarTokenStatus.last_success_at,
        last_error: sonarTokenStatus.last_error,
      });
      prevEventRef.current = sonarTokenStatus;
    }
  }, [sonarTokenStatus, props.baseUrl, queryClient]);

  return null;
}

export function useViewerStream(): ExtendedStreamState {
  const value = useContext(ViewerStreamContext);
  if (!value) throw new Error('useViewerStream must be used within ViewerStreamProvider');
  return value;
}
