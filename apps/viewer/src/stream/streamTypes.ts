import type { IssueStateSnapshot, LogEvent, SdkEvent } from '../api/types.js';

export type StreamState = Readonly<{
  connected: boolean;
  lastError: string | null;
  state: IssueStateSnapshot | null;
  logs: string[];
  viewerLogs: string[];
  sdkEvents: SdkEvent[];
}>;

export type StreamAction =
  | { type: 'ws_connected' }
  | { type: 'ws_disconnected'; error?: string }
  | { type: 'state'; data: IssueStateSnapshot }
  | { type: 'logs'; data: LogEvent }
  | { type: 'viewer-logs'; data: LogEvent }
  | { type: 'sdk'; event: string; data: unknown };

