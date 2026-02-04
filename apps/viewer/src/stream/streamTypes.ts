import type { IssueStateSnapshot, LogEvent, SdkEvent, SonarTokenStatusEvent } from '../api/types.js';

export type StreamState = Readonly<{
  connected: boolean;
  lastError: string | null;
  state: IssueStateSnapshot | null;
  logs: string[];
  viewerLogs: string[];
  sdkEvents: SdkEvent[];
  /** Latest sonar-token-status event for the current issue (may be null if none received). */
  sonarTokenStatus: SonarTokenStatusEvent | null;
}>;

export type StreamAction =
  | { type: 'ws_connected' }
  | { type: 'ws_disconnected'; error?: string }
  | { type: 'state'; data: IssueStateSnapshot }
  | { type: 'logs'; data: LogEvent }
  | { type: 'viewer-logs'; data: LogEvent }
  | { type: 'sdk'; event: string; data: unknown }
  | { type: 'sonar-token-status'; data: SonarTokenStatusEvent };

