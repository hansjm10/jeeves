import type { IssueStateSnapshot, LogEvent, SdkEvent, SonarTokenStatusEvent } from '../api/types.js';

export type StreamState = Readonly<{
  connected: boolean;
  lastError: string | null;
  state: IssueStateSnapshot | null;
  logs: string[];
  viewerLogs: string[];
  sdkEvents: SdkEvent[];
  /** Per-worker log lines keyed by taskId. */
  workerLogs: Readonly<Record<string, string[]>>;
  /** Per-worker SDK events keyed by taskId. */
  workerSdkEvents: Readonly<Record<string, SdkEvent[]>>;
  /** Latest sonar-token-status event for the current issue (may be null if none received). */
  sonarTokenStatus: SonarTokenStatusEvent | null;
}>;

export type WorkerLogEvent = Readonly<{ workerId: string; lines: string[]; reset?: boolean }>;

export type StreamAction =
  | { type: 'ws_connected' }
  | { type: 'ws_disconnected'; error?: string }
  | { type: 'state'; data: IssueStateSnapshot }
  | { type: 'logs'; data: LogEvent }
  | { type: 'viewer-logs'; data: LogEvent }
  | { type: 'sdk'; event: string; data: unknown }
  | { type: 'worker-logs'; data: WorkerLogEvent }
  | { type: 'worker-sdk'; event: string; data: unknown; workerId: string }
  | { type: 'sonar-token-status'; data: SonarTokenStatusEvent };

